-- Authenticated Manager spreadsheet submissions. No credentials or source records.
begin;

create table public.garage_sheet_sources (
  id uuid primary key,
  spreadsheet_id text not null unique check (spreadsheet_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  owner_id uuid not null references public.profiles(id),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  last_error text
);
create table public.garage_sheet_orders (
  source_id uuid not null references public.garage_sheet_sources(id),
  external_order_id uuid not null,
  order_id uuid not null unique references public.garage_orders(id),
  last_revision integer not null check (last_revision > 0),
  last_order_version integer not null check (last_order_version > 0),
  primary key(source_id,external_order_id)
);
create table public.garage_sheet_tasks (
  source_id uuid not null,
  external_task_id uuid not null,
  external_order_id uuid not null,
  task_id uuid not null unique references public.garage_order_tasks(id),
  active boolean not null default true,
  primary key(source_id,external_task_id),
  foreign key(source_id,external_order_id) references public.garage_sheet_orders(source_id,external_order_id)
);
create table public.garage_sheet_submissions (
  source_id uuid not null references public.garage_sheet_sources(id),
  submission_id uuid not null,
  external_order_id uuid not null,
  revision integer,
  payload_hash text not null,
  status text not null check (status in ('accepted','rejected','conflict')),
  receipt jsonb not null,
  scope_snapshot jsonb,
  created_at timestamptz not null default now(),
  primary key(source_id,submission_id)
);
create table public.garage_sheet_task_versions (
  source_id uuid not null,
  external_task_id uuid not null,
  external_order_id uuid not null,
  revision integer not null check (revision>0),
  task_id uuid not null references public.garage_order_tasks(id),
  primary key(source_id,external_task_id,revision),
  foreign key(source_id,external_order_id) references public.garage_sheet_orders(source_id,external_order_id)
);
create index garage_sheet_orders_source_idx on public.garage_sheet_orders(source_id,external_order_id);
create index garage_sheet_tasks_order_idx on public.garage_sheet_tasks(source_id,external_order_id,active);
create index garage_sheet_submissions_recent_idx on public.garage_sheet_submissions(source_id,created_at desc);

create function public.garage_sheet_hash(p_value text) returns text
language sql immutable strict set search_path=pg_catalog,public as $$
  select encode(sha256(convert_to(p_value,'UTF8')),'hex');
$$;

create function public.garage_sheet_can_view(p_source_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select public.garage_is_owner() and exists(select 1 from public.garage_sheet_sources
    where id=p_source_id and owner_id=auth.uid());
$$;

create function public.garage_sheet_source_json(p_source_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',id,'source_id',id,'name',name,'spreadsheet_id',spreadsheet_id,
    'active',active,'version',version,'created_at',created_at,'last_success_at',last_success_at,
    'last_error_at',last_error_at,'last_error_code',last_error_code,'last_error',last_error)
    from public.garage_sheet_sources where id=p_source_id;
$$;

create function public.garage_sheet_sources() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform public.garage_require_actor();
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only the Owner can manage spreadsheet sources.'; end if;
  return coalesce((select jsonb_agg(public.garage_sheet_source_json(id) order by created_at,id)
    from public.garage_sheet_sources where owner_id=auth.uid()),'[]'::jsonb);
end $$;

create function public.garage_register_sheet(p_name text,p_spreadsheet_id text,p_source_id uuid,p_secret text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor uuid:=public.garage_lock_actor(); source public.garage_sheet_sources%rowtype; digest text;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only the Owner can manage spreadsheet sources.'; end if;
  if p_source_id is null or p_name is null or length(btrim(p_name)) not between 1 and 120
    or p_spreadsheet_id is null or p_spreadsheet_id !~ '^[A-Za-z0-9_-]{10,200}$'
    or p_secret is null or (length(p_secret) not between 32 and 256 or p_secret !~ '^[A-Za-z0-9_-]+$') then
    raise exception 'Provide a source name, native spreadsheet ID, UUID and scoped credential.';
  end if;
  digest:=public.garage_sheet_hash(p_secret);
  perform pg_advisory_xact_lock(hashtextextended('garage-sheet-register:'||p_source_id::text,0));
  select * into source from public.garage_sheet_sources where id=p_source_id for update;
  if found then
    if source.owner_id<>actor or source.spreadsheet_id<>p_spreadsheet_id or source.name<>btrim(p_name) or source.secret_hash<>digest then
      raise exception using errcode='40001',message='This source identity is already registered with different settings.';
    end if;
    return public.garage_sheet_source_json(source.id);
  end if;
  insert into public.garage_sheet_sources(id,spreadsheet_id,name,owner_id,secret_hash)
    values(p_source_id,p_spreadsheet_id,btrim(p_name),actor,digest);
  return public.garage_sheet_source_json(p_source_id);
end $$;

create function public.garage_rotate_sheet_secret(p_source_id uuid,p_secret text,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor uuid:=public.garage_lock_actor(); source public.garage_sheet_sources%rowtype; digest text;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only the Owner can manage spreadsheet sources.'; end if;
  if p_secret is null or (length(p_secret) not between 32 and 256 or p_secret !~ '^[A-Za-z0-9_-]+$') or p_expected_version is null then raise exception 'Provide a scoped credential and current source version.'; end if;
  digest:=public.garage_sheet_hash(p_secret);
  select * into source from public.garage_sheet_sources where id=p_source_id and owner_id=actor for update;
  if not found then raise exception using errcode='42501',message='This spreadsheet source is unavailable.'; end if;
  if source.version=p_expected_version+1 and source.secret_hash=digest then return public.garage_sheet_source_json(source.id); end if;
  if source.version<>p_expected_version then raise exception using errcode='40001',message='This source changed. Refresh before rotating its credential.'; end if;
  update public.garage_sheet_sources set secret_hash=digest,version=version+1 where id=source.id;
  return public.garage_sheet_source_json(source.id);
end $$;

create function public.garage_set_sheet_active(p_source_id uuid,p_active boolean,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor uuid:=public.garage_lock_actor(); source public.garage_sheet_sources%rowtype;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only the Owner can manage spreadsheet sources.'; end if;
  select * into source from public.garage_sheet_sources where id=p_source_id and owner_id=actor for update;
  if not found then raise exception using errcode='42501',message='This spreadsheet source is unavailable.'; end if;
  if p_active is null or p_expected_version is null then raise exception 'Provide a source state and current version.'; end if;
  if source.version=p_expected_version+1 and source.active=p_active then return public.garage_sheet_source_json(source.id); end if;
  if source.version<>p_expected_version then raise exception using errcode='40001',message='This source changed. Refresh before changing it.'; end if;
  update public.garage_sheet_sources set active=p_active,version=version+1 where id=source.id;
  return public.garage_sheet_source_json(source.id);
end $$;

-- Status/receipt output deliberately excludes amounts, internal IDs and credentials.
create function public.garage_sheet_order_status(p_source_id uuid,p_external_order_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('external_order_id',s.external_order_id,'revision',s.last_revision,
    'order_number',o.order_number,'status',o.status,'order_version',o.version,
    'tasks',coalesce((select jsonb_agg(jsonb_build_object('external_task_id',st.external_task_id,
      'work_code',t.work_code,'status',t.status,'working_name',p.name,'completed_at',t.completed_at)
      order by st.external_task_id) from public.garage_sheet_tasks st
      join public.garage_order_tasks t on t.id=st.task_id left join public.profiles p on p.id=t.working_mechanic_id
      where st.source_id=s.source_id and st.external_order_id=s.external_order_id and st.active),'[]'::jsonb))
  from public.garage_sheet_orders s join public.garage_orders o on o.id=s.order_id
  where s.source_id=p_source_id and s.external_order_id=p_external_order_id;
$$;

create function public.garage_sheet_authenticate(p_source_id uuid,p_secret text) returns public.garage_sheet_sources
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare source public.garage_sheet_sources%rowtype;
begin
  select * into source from public.garage_sheet_sources where id=p_source_id;
  if not found or not source.active or p_secret is null or source.secret_hash is distinct from public.garage_sheet_hash(p_secret)
    or not exists(select 1 from public.profiles where id=source.owner_id and active and role='admin') then
    raise exception using errcode='42501',message='Spreadsheet source authentication failed.';
  end if;
  return source;
end $$;

create function public.garage_sheet_status(p_source_id uuid,p_secret text,p_external_order_ids jsonb default '[]'::jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare source public.garage_sheet_sources%rowtype; ids uuid[]; item jsonb;
begin
  source:=public.garage_sheet_authenticate(p_source_id,p_secret);
  if p_external_order_ids is null or jsonb_typeof(p_external_order_ids)<>'array' or jsonb_array_length(p_external_order_ids)>100 then
    raise exception 'Request at most 100 external order IDs.';
  end if;
  ids:=array[]::uuid[];
  for item in select value from jsonb_array_elements(p_external_order_ids) loop
    if jsonb_typeof(item)<>'string' then raise exception 'External order IDs must be UUID strings.'; end if;
    ids:=array_append(ids,(item#>>'{}')::uuid);
  end loop;
  return jsonb_build_object('source_id',source.id,'orders',coalesce((select jsonb_agg(public.garage_sheet_order_status(source.id,s.external_order_id)
    order by s.external_order_id) from (select external_order_id from public.garage_sheet_orders where source_id=source.id
      and (cardinality(ids)=0 or external_order_id=any(ids)) order by external_order_id limit 100)s),'[]'::jsonb));
end $$;

create function public.garage_ingest_sheet(p_source_id uuid,p_secret text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
<<sheet_ingest>>
declare
  source public.garage_sheet_sources%rowtype; link public.garage_sheet_orders%rowtype;
  old_receipt public.garage_sheet_submissions%rowtype; selected_order public.garage_orders%rowtype;
  submission uuid; external_order uuid; revision integer; hash text; action text; item jsonb; line uuid;
  expected integer; record_order jsonb; tasks jsonb; canonical jsonb; task_id uuid; created jsonb; response jsonb;
  ids uuid[]:=array[]::uuid[]; previous_sub text; previous_claims text; failure_state text; error_code text; error_message text;
  known_work public.garage_works%rowtype; task_options jsonb; order_id uuid; safe_state jsonb; previous_task public.garage_order_tasks%rowtype;
begin
  -- Lock source first, then its active Owner, then the parent order. This also
  -- serializes source revisions and makes credential rotation take effect cleanly.
  select * into source from public.garage_sheet_sources where id=p_source_id for update;
  if not found or not source.active or p_secret is null or source.secret_hash is distinct from public.garage_sheet_hash(p_secret) then
    raise exception using errcode='42501',message='Spreadsheet source authentication failed.';
  end if;
  perform 1 from public.profiles where id=source.owner_id and active and role='admin' for share;
  if not found then raise exception using errcode='42501',message='Spreadsheet source authentication failed.'; end if;

  -- Without valid identity fields no durable receipt can safely be addressed.
  begin
    if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid payload'; end if;
    submission:=(p_payload->>'submission_id')::uuid;
    external_order:=(p_payload->>'external_order_id')::uuid;
    revision:=(p_payload->>'revision')::integer;
    if submission is null or external_order is null or revision is null then raise exception 'Missing identity'; end if;
  exception when others then
    return jsonb_build_object('status','rejected','error',jsonb_build_object('code','INVALID_SUBMISSION','message','Provide valid submission and external order identities.'));
  end;
  hash:=public.garage_sheet_hash(p_payload::text);
  select * into old_receipt from public.garage_sheet_submissions where source_id=source.id and submission_id=submission;
  if found then
    if old_receipt.payload_hash=hash then return old_receipt.receipt; end if;
    return jsonb_build_object('status','conflict','submission_id',submission,'external_order_id',external_order,'revision',revision,
      'error',jsonb_build_object('code','SUBMISSION_ID_REUSED','message','Use a new submission ID for changed content.'));
  end if;

  error_code:='VALIDATION_FAILED'; error_message:='The complete submitted order could not be validated.';
  previous_sub:=current_setting('request.jwt.claim.sub',true);
  previous_claims:=current_setting('request.jwt.claims',true);
  begin
    if exists(select 1 from jsonb_object_keys(p_payload) k where k not in
      ('schema_version','spreadsheet_id','submission_id','external_order_id','revision','expected_order_version','action','order','tasks')) then
      error_code:='UNSUPPORTED_FIELDS'; raise exception 'Unsupported fields';
    end if;
    if p_payload->'schema_version' is distinct from '1'::jsonb then error_code:='INVALID_SUBMISSION'; raise exception 'Unsupported schema'; end if;
    if p_payload->>'spreadsheet_id' is distinct from source.spreadsheet_id then
      error_code:='SPREADSHEET_MISMATCH'; raise exception 'Wrong spreadsheet';
    end if;
    action:=p_payload->>'action';
    if action is null or action not in ('submit','cancel') or revision<1 then error_code:='INVALID_SUBMISSION'; raise exception 'Unsupported action'; end if;
    -- Even ignored cancellation fields cannot smuggle privileged input shapes.
    if p_payload ? 'order' then
      record_order:=p_payload->'order';
      if jsonb_typeof(record_order)<>'object' then raise exception 'Invalid order fields'; end if;
      if exists(select 1 from jsonb_object_keys(record_order) k where k not in
        ('vehicle','vin','colour','vehicle_group_code','planned_date','due_date','priority','instructions','manager_label')) then
        error_code:='UNSUPPORTED_FIELDS'; raise exception 'Unsupported order fields';
      end if;
    end if;
    if p_payload ? 'tasks' then
      if jsonb_typeof(p_payload->'tasks')<>'array' or jsonb_array_length(p_payload->'tasks')>50 then raise exception 'Invalid tasks'; end if;
      for item in select value from jsonb_array_elements(p_payload->'tasks') loop
        if jsonb_typeof(item)<>'object' then raise exception 'Invalid task'; end if;
        if exists(select 1 from jsonb_object_keys(item) k where k not in ('external_task_id','work_code','options','instructions')) then
          error_code:='UNSUPPORTED_FIELDS'; raise exception 'Unsupported task fields';
        end if;
        if item ? 'options' and (jsonb_typeof(item->'options')<>'object' or
          exists(select 1 from jsonb_object_keys(item->'options') k where k<>'tint_percent')) then
          error_code:='UNSUPPORTED_FIELDS'; raise exception 'Unsupported task options';
        end if;
      end loop;
    end if;
    select * into link from public.garage_sheet_orders where source_id=source.id and external_order_id=external_order;
    if found then
      if revision<>link.last_revision+1 then error_code:='REVISION_CONFLICT'; raise exception using errcode='40001',message='Stale revision'; end if;
      expected:=(p_payload->>'expected_order_version')::integer;
      select * into selected_order from public.garage_orders where id=link.order_id for update;
      if selected_order.source<>'manager' then error_code:='ORDER_CHANGED'; raise exception using errcode='40001',message='Wrong order source'; end if;
      if selected_order.status<>'published' then error_code:='ORDER_CLOSED'; raise exception using errcode='40001',message='Order no longer open'; end if;
      if expected is distinct from link.last_order_version or selected_order.version<>link.last_order_version then
        error_code:='ORDER_CHANGED'; raise exception using errcode='40001',message='Order changed';
      end if;
      perform 1 from public.garage_order_tasks where garage_order_tasks.order_id=selected_order.id order by id for update;
      if exists(select 1 from public.garage_sheet_tasks s join public.garage_order_tasks t on t.id=s.task_id
        where s.source_id=source.id and s.external_order_id=external_order and s.active and t.status<>'pending') then
        error_code:='ORDER_CHANGED'; raise exception using errcode='40001',message='Work already changed';
      end if;
      order_id:=selected_order.id;
    else
      if action='cancel' or revision<>1 or p_payload->>'expected_order_version' is not null then
        error_code:='REVISION_CONFLICT'; raise exception using errcode='40001',message='New orders start at revision one';
      end if;
    end if;

    perform set_config('request.jwt.claim.sub',source.owner_id::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',source.owner_id,'role','service_role')::text,true);
    if action='cancel' then
      perform public.garage_order_action(order_id,'cancel',selected_order.version,
        md5('garage-sheet-cancel:'||source.id::text||':'||submission::text)::uuid,'Cancellation requested by the registered Manager spreadsheet.');
    else
      record_order:=p_payload->'order'; tasks:=p_payload->'tasks';
      if record_order is null or jsonb_typeof(record_order)<>'object' or tasks is null or jsonb_typeof(tasks)<>'array'
        or jsonb_array_length(tasks) not between 1 and 50 then raise exception 'Incomplete order'; end if;
      if exists(select 1 from jsonb_object_keys(record_order) k where k not in
        ('vehicle','vin','colour','vehicle_group_code','planned_date','due_date','priority','instructions','manager_label')) then
        error_code:='UNSUPPORTED_FIELDS'; raise exception 'Unsupported order fields';
      end if;
      canonical:='[]'::jsonb;
      for item in select value from jsonb_array_elements(tasks) loop
        if jsonb_typeof(item)<>'object' then raise exception 'Invalid task'; end if;
        if exists(select 1 from jsonb_object_keys(item) k where k not in ('external_task_id','work_code','options','instructions')) then
          error_code:='UNSUPPORTED_FIELDS'; raise exception 'Unsupported task fields';
        end if;
        line:=(item->>'external_task_id')::uuid;
        if line is null or line=any(ids) then error_code:='TASK_ID_REUSED'; raise exception 'Duplicate task identity'; end if;
        ids:=array_append(ids,line);
        if exists(select 1 from public.garage_sheet_tasks where source_id=source.id and external_task_id=line and external_order_id<>external_order) then
          error_code:='TASK_ID_REUSED'; raise exception using errcode='40001',message='Task belongs to another order';
        end if;
        canonical:=canonical||jsonb_build_array(jsonb_build_object('work_code',item->>'work_code',
          'options',coalesce(item->'options','{}'::jsonb),'instructions',coalesce(item->>'instructions','')));
      end loop;
      if link.source_id is null then
        created:=public.garage_create_order(record_order->>'vehicle',record_order->>'vehicle_group_code','manager',canonical,
          md5('garage-sheet-create:'||source.id::text||':'||submission::text)::uuid,
          coalesce(record_order->>'instructions',''),nullif(record_order->>'due_date','')::date,coalesce(record_order->>'priority','normal'),
          coalesce(record_order->>'vin',''),coalesce(record_order->>'colour',''),coalesce(record_order->>'manager_label',''),nullif(record_order->>'planned_date','')::date);
        order_id:=(created->>'order_id')::uuid;
        insert into public.garage_sheet_orders(source_id,external_order_id,order_id,last_revision,last_order_version)
          values(source.id,external_order,sheet_ingest.order_id,revision,1);
        -- Creation retains input order in the event identity sequence, unlike UUID order.
        for item,line in select value,(value->>'external_task_id')::uuid from jsonb_array_elements(tasks) loop
          select t.id into task_id from public.garage_order_tasks t
            join public.garage_task_events e on e.task_id=t.id and e.action='created'
            where t.order_id=sheet_ingest.order_id and not exists(select 1 from public.garage_sheet_tasks st where st.task_id=t.id)
            order by e.id limit 1;
          insert into public.garage_sheet_tasks(source_id,external_task_id,external_order_id,task_id)
            values(source.id,line,external_order,sheet_ingest.task_id);
          insert into public.garage_sheet_task_versions(source_id,external_task_id,external_order_id,revision,task_id)
            values(source.id,line,external_order,sheet_ingest.revision,sheet_ingest.task_id);
        end loop;
      else
        -- Validate the entire replacement before superseding any pending task.
        if length(btrim(coalesce(record_order->>'vehicle',''))) not between 1 and 200
          or length(coalesce(record_order->>'vin',''))>40 or length(coalesce(record_order->>'colour',''))>80
          or length(coalesce(record_order->>'instructions',''))>4000 or length(coalesce(record_order->>'manager_label',''))>120
          or coalesce(record_order->>'priority','normal') not in ('normal','high','urgent')
          or not exists(select 1 from public.garage_vehicle_groups where code=record_order->>'vehicle_group_code') then raise exception 'Invalid replacement'; end if;
        for item in select value from jsonb_array_elements(tasks) loop
          select * into known_work from public.garage_works where code=item->>'work_code' and active;
          if not found or not exists(select 1 from public.garage_work_availability where vehicle_group_code=record_order->>'vehicle_group_code' and work_code=known_work.code) then raise exception 'Unsupported work'; end if;
          task_options:=coalesce(item->'options','{}'::jsonb);
          if (known_work.code='W19' and task_options not in ('{"tint_percent":5}'::jsonb,'{"tint_percent":15}'::jsonb))
            or (known_work.code<>'W19' and task_options<>'{}'::jsonb) or length(coalesce(item->>'instructions',''))>2000 then raise exception 'Unsupported options'; end if;
        end loop;
        insert into public.garage_task_events(order_id,task_id,actor_id,action,note)
          select sheet_ingest.order_id,t.id,source.owner_id,'cancel','Superseded by an accepted spreadsheet revision.'
          from public.garage_order_tasks t join public.garage_sheet_tasks st on st.task_id=t.id
          where st.source_id=source.id and st.external_order_id=external_order and st.active and not exists(
            select 1 from jsonb_array_elements(tasks) incoming where incoming->>'external_task_id'=st.external_task_id::text
              and incoming->>'work_code'=t.work_code and coalesce(incoming->'options','{}'::jsonb)=t.options
              and selected_order.vehicle_group_code=record_order->>'vehicle_group_code');
        update public.garage_order_tasks t set status='cancelled',version=t.version+1
          from public.garage_sheet_tasks st where st.task_id=t.id and st.source_id=source.id and st.external_order_id=external_order and st.active and not exists(
            select 1 from jsonb_array_elements(tasks) incoming where incoming->>'external_task_id'=st.external_task_id::text
              and incoming->>'work_code'=t.work_code and coalesce(incoming->'options','{}'::jsonb)=t.options
              and selected_order.vehicle_group_code=record_order->>'vehicle_group_code');
        update public.garage_sheet_tasks set active=false where source_id=source.id and external_order_id=external_order;
        update public.garage_orders set vehicle=btrim(record_order->>'vehicle'),vin=upper(btrim(coalesce(record_order->>'vin',''))),
          colour=btrim(coalesce(record_order->>'colour','')),vehicle_group_code=record_order->>'vehicle_group_code',
          planned_date=nullif(record_order->>'planned_date','')::date,due_date=nullif(record_order->>'due_date','')::date,
          priority=coalesce(record_order->>'priority','normal'),instructions=btrim(coalesce(record_order->>'instructions','')),
          manager_label=btrim(coalesce(record_order->>'manager_label','')),version=version+1 where id=sheet_ingest.order_id;
        for item in select value from jsonb_array_elements(tasks) loop
          select * into known_work from public.garage_works where code=item->>'work_code';
          select t.* into previous_task from public.garage_order_tasks t join public.garage_sheet_tasks st on st.task_id=t.id
            where st.source_id=source.id and st.external_task_id=(item->>'external_task_id')::uuid;
          if found and previous_task.status='pending' and previous_task.work_code=known_work.code
            and previous_task.options=coalesce(item->'options','{}'::jsonb)
            and selected_order.vehicle_group_code=record_order->>'vehicle_group_code' then
            task_id:=previous_task.id;
            if previous_task.instructions is distinct from btrim(coalesce(item->>'instructions','')) then
              update public.garage_order_tasks set instructions=btrim(coalesce(item->>'instructions','')),version=version+1 where id=sheet_ingest.task_id;
              insert into public.garage_task_events(order_id,task_id,actor_id,action,note)
                values(sheet_ingest.order_id,sheet_ingest.task_id,source.owner_id,'instructions_updated','Accepted spreadsheet revision.');
            end if;
          else
            insert into public.garage_order_tasks(order_id,work_code,work_name,options,instructions)
              values(sheet_ingest.order_id,known_work.code,known_work.name,coalesce(item->'options','{}'::jsonb),btrim(coalesce(item->>'instructions',''))) returning id into task_id;
            perform public.garage_snapshot_task(task_id,record_order->>'vehicle_group_code');
            insert into public.garage_task_events(order_id,task_id,actor_id,action,note)
              values(sheet_ingest.order_id,sheet_ingest.task_id,source.owner_id,'created','Accepted spreadsheet revision.');
          end if;
          insert into public.garage_sheet_tasks(source_id,external_task_id,external_order_id,task_id,active)
            values(source.id,(item->>'external_task_id')::uuid,external_order,sheet_ingest.task_id,true)
            on conflict(source_id,external_task_id) do update set task_id=excluded.task_id,active=true;
          insert into public.garage_sheet_task_versions(source_id,external_task_id,external_order_id,revision,task_id)
            values(source.id,(item->>'external_task_id')::uuid,external_order,sheet_ingest.revision,sheet_ingest.task_id);
        end loop;
      end if;
    end if;
    update public.garage_sheet_orders set last_revision=sheet_ingest.revision,
      last_order_version=(select version from public.garage_orders where id=sheet_ingest.order_id)
      where source_id=source.id and external_order_id=external_order;
    safe_state:=public.garage_sheet_order_status(source.id,external_order);
    response:=jsonb_build_object('status','accepted','submission_id',submission,'external_order_id',external_order,'revision',revision,
      'order_number',safe_state->'order_number','order_status',safe_state->'status','order_version',safe_state->'order_version','tasks',safe_state->'tasks');
  exception when others then
    failure_state:=sqlstate;
    if failure_state='40001' or failure_state='23505' then
      if error_code='VALIDATION_FAILED' then error_code:='ORDER_CHANGED'; end if;
      error_message:='This order or source identity changed. Ask the Owner to review before submitting again.';
    else error_message:='The complete submitted order could not be validated. Check its approved fields and task choices.'; end if;
    response:=jsonb_build_object('status',case when failure_state in ('40001','23505') then 'conflict' else 'rejected' end,
      'submission_id',submission,'external_order_id',external_order,'revision',revision,
      'error',jsonb_build_object('code',error_code,'message',error_message));
  end;
  -- Both successful and rejected subtransactions restore the caller's claims.
  perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
  perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
  insert into public.garage_sheet_submissions(source_id,submission_id,external_order_id,revision,payload_hash,status,receipt,scope_snapshot)
    values(source.id,submission,external_order,revision,hash,response->>'status',response,
      case when response->>'status'='accepted' then p_payload else null end);
  if response->>'status'='accepted' then
    update public.garage_sheet_sources set last_success_at=now(),last_error_at=null,last_error_code=null,last_error=null where id=source.id;
  else
    update public.garage_sheet_sources set last_error_at=now(),last_error_code=response#>>'{error,code}',last_error=response#>>'{error,message}' where id=source.id;
  end if;
  return response;
end $$;

do $$ declare tab text; begin
  foreach tab in array array['garage_sheet_sources','garage_sheet_orders','garage_sheet_tasks','garage_sheet_submissions','garage_sheet_task_versions'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on table public.%I from public,anon,authenticated',tab);
    execute format('grant all on table public.%I to service_role',tab);
  end loop;
end $$;
grant select(id,spreadsheet_id,name,owner_id,active,version,created_at,last_success_at,last_error_at,last_error_code,last_error)
  on public.garage_sheet_sources to authenticated;
grant select on public.garage_sheet_orders,public.garage_sheet_tasks,public.garage_sheet_submissions,public.garage_sheet_task_versions to authenticated;
create policy garage_sheet_sources_owner on public.garage_sheet_sources for select to authenticated using(public.garage_sheet_can_view(id));
create policy garage_sheet_orders_owner on public.garage_sheet_orders for select to authenticated using(public.garage_sheet_can_view(source_id));
create policy garage_sheet_tasks_owner on public.garage_sheet_tasks for select to authenticated using(public.garage_sheet_can_view(source_id));
create policy garage_sheet_submissions_owner on public.garage_sheet_submissions for select to authenticated using(public.garage_sheet_can_view(source_id));
create policy garage_sheet_task_versions_owner on public.garage_sheet_task_versions for select to authenticated using(public.garage_sheet_can_view(source_id));
revoke all on function public.garage_sheet_hash(text),public.garage_sheet_source_json(uuid),
  public.garage_sheet_authenticate(uuid,text),public.garage_sheet_order_status(uuid,uuid) from public,anon,authenticated;
revoke all on function public.garage_sheet_can_view(uuid),public.garage_sheet_sources(),
  public.garage_register_sheet(text,text,uuid,text),public.garage_rotate_sheet_secret(uuid,text,integer),
  public.garage_set_sheet_active(uuid,boolean,integer) from public,anon;
grant execute on function public.garage_sheet_can_view(uuid),public.garage_sheet_sources(),
  public.garage_register_sheet(text,text,uuid,text),public.garage_rotate_sheet_secret(uuid,text,integer),
  public.garage_set_sheet_active(uuid,boolean,integer) to authenticated;
revoke all on function public.garage_ingest_sheet(uuid,text,jsonb),public.garage_sheet_status(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.garage_ingest_sheet(uuid,text,jsonb),public.garage_sheet_status(uuid,text,jsonb) to service_role;

insert into public.garage_schema_migrations(version) values('202611120002');
notify pgrst,'reload schema';
commit;
