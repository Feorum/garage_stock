-- Owner interpretation of free-form Manager requests. Raw source stays private.
begin;

create table public.garage_manager_intake (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.garage_sheet_sources(id),
  intake_key text not null,
  original_source_key text,
  owner_canonical_key text,
  original_snapshot jsonb not null check (jsonb_typeof(original_snapshot)='object'),
  original_observations jsonb not null check (jsonb_typeof(original_observations)='array'),
  latest_snapshot jsonb not null check (jsonb_typeof(latest_snapshot)='object'),
  observations jsonb not null default '[]' check (jsonb_typeof(observations)='array'),
  row_numbers integer[] not null,
  suggested_order jsonb,
  suggested_tasks jsonb not null default '[]' check (jsonb_typeof(suggested_tasks)='array'),
  issues jsonb not null default '[]' check (jsonb_typeof(issues)='array'),
  source_completed boolean not null default false,
  source_missing boolean not null default false,
  owner_managed boolean not null default false,
  order_id uuid references public.garage_orders(id),
  version integer not null default 1 check (version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_id,intake_key),
  check (octet_length(original_snapshot::text)<=2097152 and octet_length(latest_snapshot::text)<=2097152)
);
create index garage_intake_order_idx on public.garage_manager_intake(order_id);
create index garage_intake_owner_key_idx on public.garage_manager_intake(source_id,owner_canonical_key) where owner_managed;
create index garage_intake_original_key_idx on public.garage_manager_intake(source_id,original_source_key) where owner_managed;
alter table public.garage_manager_intake enable row level security;
revoke all on public.garage_manager_intake from public,anon,authenticated,service_role;
grant select on public.garage_manager_intake to authenticated;
create policy garage_intake_owner on public.garage_manager_intake for select to authenticated
  using (public.garage_sheet_can_view(source_id));

create function public.garage_intake_content(p_observations jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(v->'raw' order by (v->'raw')::text),'[]'::jsonb) from jsonb_array_elements(p_observations) v
$$;

create function public.garage_capture_manager_rows(
  p_source_id uuid,p_lease_token uuid,p_expected_version integer,p_rows jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
<<capture>>
declare
  source public.garage_sheet_sources%rowtype; feed public.garage_sheet_pull_feeds%rowtype;
  item jsonb; raw jsonb; grouped record; selected public.garage_manager_intake%rowtype;
  row_key text; source_key text; hashes text[]; rows integer[]; observations jsonb; issues jsonb;
  first_item jsonb; suggested jsonb; safe_tasks jsonb; completed boolean; linked uuid; seen uuid[]:=array[]::uuid[];
  managed_rows integer[]:=array[]::integer[]; managed_keys text[]; managed_hashes text[];
begin
  select * into source from public.garage_sheet_sources where id=p_source_id for update;
  if not found then raise exception using errcode='42501',message='Source unavailable.'; end if;
  select * into feed from public.garage_sheet_pull_feeds where source_id=p_source_id for update;
  if not found or feed.lease_token is distinct from p_lease_token or feed.state_version is distinct from p_expected_version
    or feed.lease_expires_at<=clock_timestamp() then
    raise exception using errcode='40001',message='The importer lease changed.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>5000
    or octet_length(p_rows::text)>12582912 then raise exception 'Invalid source observations.'; end if;
  for item in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) k where k not in
      ('row_number','source_key','raw','suggested_order','suggested_tasks','issues'))
      or (item->>'row_number') is null or (item->>'row_number') !~ '^[0-9]{1,7}$'
      or (item->>'row_number')::integer not between 1 and 5000
      or (item->'source_key' is not null and item->'source_key'<>'null'::jsonb and
        (jsonb_typeof(item->'source_key')<>'string' or item->>'source_key' !~ '^\d{4}-\d{2}-\d{2}\|[A-HJ-NPR-Z0-9]{17}$'))
      or jsonb_typeof(item->'raw') is distinct from 'object'
      or jsonb_typeof(item->'suggested_tasks') is distinct from 'array'
      or jsonb_array_length(item->'suggested_tasks')>50
      or jsonb_typeof(item->'issues') is distinct from 'array' then raise exception 'Invalid source observation.'; end if;
    raw:=item->'raw';
    if exists(select 1 from jsonb_object_keys(raw) k where k not in
      ('date','manager_label','vehicle','vin','colour','wrapping','tint','completion','notes'))
      or exists(select 1 from jsonb_each(raw) f where jsonb_typeof(f.value)<>'string')
      or octet_length(raw::text)>2097152 then raise exception 'Invalid private source fields.'; end if;
  end loop;
  for grouped in
    select case when nullif(value->>'source_key','') is not null then 'identity:'||(value->>'source_key')
      else 'observation:'||public.garage_sheet_hash((value->'raw')::text) end as key,
      jsonb_agg(value order by (value->>'row_number')::integer) as items
    from jsonb_array_elements(p_rows)
    group by 1
  loop
    first_item:=grouped.items->0; raw:=first_item->'raw'; source_key:=nullif(first_item->>'source_key','');
    suggested:=first_item->'suggested_order';
    if jsonb_typeof(suggested)='object' and public.garage_private_note(suggested->>'instructions') then
      suggested:=jsonb_set(suggested,'{instructions}','""'::jsonb);
    end if;
    select coalesce(jsonb_agg(case when public.garage_private_note(t->>'instructions') then jsonb_set(t,'{instructions}','""'::jsonb) else t end),'[]'::jsonb)
      into safe_tasks from jsonb_array_elements(first_item->'suggested_tasks') t;
    select array_agg((v->>'row_number')::integer order by (v->>'row_number')::integer),
      jsonb_agg(jsonb_build_object('row_number',(v->>'row_number')::integer,'raw',v->'raw') order by (v->>'row_number')::integer),
      bool_and(lower(btrim(v->'raw'->>'completion'))='true')
      into rows,observations,completed from jsonb_array_elements(grouped.items) v;
    completed:=coalesce(completed,false);
    select coalesce(jsonb_agg(code order by code),'[]'::jsonb) into issues from (
      select distinct code from jsonb_array_elements(grouped.items) v
      cross join lateral jsonb_array_elements_text(v->'issues') code
      union select 'DUPLICATE_SOURCE_OBSERVATION' where cardinality(rows)>1
    ) all_codes;
    select i.* into selected from public.garage_manager_intake i where i.source_id=p_source_id and
      (i.intake_key=grouped.key or (i.owner_managed and source_key is not null and source_key in(i.original_source_key,i.owner_canonical_key)))
      order by i.owner_managed desc,i.created_at,i.id limit 1 for update;
    if not found and completed then continue; end if;
    linked:=selected.order_id;
    if linked is null and source_key is not null then
      select so.order_id into linked from public.garage_sheet_orders so
      where so.source_id=p_source_id and so.external_order_id::text=feed.state->'entries'->source_key->>'external_order_id';
    end if;
    if selected.id is null then
      insert into public.garage_manager_intake(source_id,intake_key,original_source_key,original_snapshot,original_observations,latest_snapshot,
        observations,row_numbers,suggested_order,suggested_tasks,issues,source_completed,order_id)
      values(p_source_id,grouped.key,source_key,raw,observations,raw,observations,rows,suggested,safe_tasks,issues,completed,linked)
      returning * into selected;
    else
      update public.garage_manager_intake i set latest_snapshot=raw,observations=capture.observations,row_numbers=rows,
        suggested_order=suggested,suggested_tasks=safe_tasks,issues=capture.issues,
        source_completed=completed,source_missing=false,order_id=coalesce(i.order_id,linked),
        version=i.version+case when i.latest_snapshot is distinct from raw or i.suggested_order is distinct from suggested
          or i.suggested_tasks is distinct from safe_tasks or i.issues is distinct from capture.issues
          or i.source_completed is distinct from completed or i.source_missing or i.order_id is distinct from coalesce(i.order_id,linked)
          or public.garage_intake_content(i.observations) is distinct from public.garage_intake_content(capture.observations)
          or cardinality(i.row_numbers)<>cardinality(rows) then 1 else 0 end,
        updated_at=clock_timestamp()
      where i.id=selected.id returning * into selected;
    end if;
    seen:=array_append(seen,selected.id);
    if selected.owner_managed then managed_rows:=managed_rows||rows; end if;
  end loop;
  update public.garage_manager_intake set source_missing=true,version=version+1,updated_at=clock_timestamp()
    where source_id=p_source_id and not(id=any(seen)) and not source_missing;
  select coalesce(array_agg(distinct k) filter(where k is not null),array[]::text[]) into managed_keys
    from public.garage_manager_intake i cross join lateral unnest(array[i.original_source_key,i.owner_canonical_key]) k
    where i.source_id=p_source_id and i.owner_managed;
  select coalesce(array_agg(distinct public.garage_sheet_hash(i.original_snapshot::text)),array[]::text[]) into managed_hashes
    from public.garage_manager_intake i where i.source_id=p_source_id and i.owner_managed;
  return jsonb_build_object('version',feed.state_version,'owner_managed_rows',to_jsonb(managed_rows),
    'owner_managed_keys',to_jsonb(managed_keys),'owner_managed_observations',to_jsonb(managed_hashes),
    'intakes_count',cardinality(seen));
end $$;

create function public.garage_manager_intakes() returns jsonb
language plpgsql security definer stable set search_path=pg_catalog,public as $$
begin
  perform public.garage_require_actor();
  if not public.is_admin() then raise exception using errcode='42501',message='Only the Owner can interpret Manager orders.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',i.id,'version',i.version,'source_id',i.source_id,'source_name',s.name,'row_numbers',i.row_numbers,
    'source_key',i.original_source_key,'status',case when i.owner_managed then 'owner_managed' when i.source_completed then 'source_completed'
      when i.source_missing then 'source_missing' when i.order_id is not null then 'published' else 'pending' end,
    'original',i.original_snapshot,'latest',i.latest_snapshot,'original_observations',i.original_observations,'observations',i.observations,
    'suggested_order',i.suggested_order,'suggested_tasks',i.suggested_tasks,'issues',i.issues,
    'order_id',i.order_id,'owner_managed',i.owner_managed,'source_changed',i.source_missing or public.garage_intake_content(i.original_observations) is distinct from public.garage_intake_content(i.observations),
    'source_missing',i.source_missing,'source_completed',i.source_completed
  ) order by s.created_at,s.id,i.row_numbers[1],i.id)
    from public.garage_manager_intake i join public.garage_sheet_sources s on s.id=i.source_id where s.owner_id=auth.uid()),'[]'::jsonb);
end $$;

create function public.garage_validate_edit_fields(p_order jsonb) returns void
language plpgsql set search_path=pg_catalog,public as $$
begin
  if p_order is null or jsonb_typeof(p_order)<>'object' or exists(select 1 from jsonb_object_keys(p_order) k where k not in
    ('vehicle','vehicle_group_code','vin','colour','manager_label','instructions','due_date','planned_date','priority'))
    or exists(select 1 from jsonb_each(p_order) f where jsonb_typeof(f.value) not in ('string','null')) then raise exception 'Unsupported order fields.'; end if;
  if length(btrim(coalesce(p_order->>'vehicle',''))) not between 1 and 200
    or not exists(select 1 from public.garage_vehicle_groups where code=p_order->>'vehicle_group_code')
    or length(coalesce(p_order->>'vin',''))>40 or length(coalesce(p_order->>'colour',''))>80
    or length(coalesce(p_order->>'manager_label',''))>120 or length(coalesce(p_order->>'instructions',''))>4000
    or coalesce(p_order->>'priority','normal') not in ('normal','high','urgent') then raise exception 'Check the order fields.'; end if;
  if nullif(p_order->>'planned_date','') is not null then
    if p_order->>'planned_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Choose a complete planned date.'; end if;
    perform (p_order->>'planned_date')::date;
  end if;
  if nullif(p_order->>'due_date','') is not null then
    if p_order->>'due_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Choose a complete deadline.'; end if;
    perform (p_order->>'due_date')::date;
  end if;
end $$;

create function public.garage_validate_edit_tasks(p_group text,p_tasks jsonb,p_source text default null) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare item jsonb; options jsonb; ids uuid[]:=array[]::uuid[]; task_id uuid; codes text[]:=array[]::text[];
begin
  if p_tasks is null or jsonb_typeof(p_tasks)<>'array' or jsonb_array_length(p_tasks) not between 1 and 50 then raise exception 'Select at least one catalogue work.'; end if;
  for item in select value from jsonb_array_elements(p_tasks) loop
    if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) k where k not in
      ('id','work_code','options','instructions','assigned_to')) then raise exception 'Unsupported task fields.'; end if;
    if not exists(select 1 from public.garage_works w join public.garage_work_availability a on a.work_code=w.code
      where w.code=item->>'work_code' and w.active and a.vehicle_group_code=p_group) then raise exception 'The work is unavailable for this vehicle group.'; end if;
    if (item->>'work_code')=any(codes) then raise exception 'Select each work once.'; end if;
    codes:=array_append(codes,item->>'work_code');
    options:=coalesce(item->'options','{}'::jsonb);
    if (item->>'work_code'='W19' and options not in ('{"tint_percent":5}'::jsonb,'{"tint_percent":15}'::jsonb))
      or (item->>'work_code'<>'W19' and options<>'{}'::jsonb) then raise exception 'Choose an approved work variant.'; end if;
    if length(coalesce(item->>'instructions',''))>2000 then raise exception 'Task details are too long.'; end if;
    task_id:=nullif(item->>'id','')::uuid;
    if task_id is not null then
      if task_id=any(ids) then raise exception 'A task identity is duplicated.'; end if;
      ids:=array_append(ids,task_id);
    end if;
    if p_source='owner' then
      if task_id is null or not exists(select 1 from public.garage_order_tasks t where t.id=task_id
        and t.status in ('in_progress','blocked','completed') and t.assigned_to is not distinct from nullif(item->>'assigned_to','')::uuid) then
        perform public.garage_lock_mechanic(nullif(item->>'assigned_to','')::uuid);
      end if;
    elsif p_source='manager' and nullif(item->>'assigned_to','') is not null then raise exception 'Manager work remains shared.'; end if;
  end loop;
  if (select count(*) from unnest(codes) c where c in ('W01','W03','W04'))>1 then raise exception 'Choose one hood coverage option.'; end if;
end $$;

create function public.garage_private_note(p_value text) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
  select normalize(coalesce(p_value,''),NFKC) ~* '((^|[^[:alpha:]])(BYN|EUR|USD|VAT|prices?|costs?|rates?|discounts?|скидк[аиеуы]|тариф[ауы]?|ставк[аиеуы]|прайс|НДС|цен[аыуе]|стоимост[ьи])([^[:alpha:]]|$)|[\$€£₽][[:space:]]*[0-9]|[0-9][0-9[:space:].,]*[[:space:]]*(руб|р\.|\$|€|£|₽))'
$$;

create function public.garage_quote_order(p_vehicle_group_code text,p_tasks jsonb,p_order_id uuid default null) returns jsonb
language plpgsql security definer stable set search_path=pg_catalog,public as $$
declare
  item jsonb; task public.garage_order_tasks%rowtype; parent public.garage_orders%rowtype; amount record;
  items jsonb:='[]'; net numeric:=0; tax numeric:=0; gross numeric:=0; missing boolean:=false;
  status text; n numeric; v numeric; g numeric;
begin
  perform public.garage_require_actor();
  if not public.is_admin() then raise exception using errcode='42501',message='Only the Owner can view amounts.'; end if;
  perform public.garage_validate_edit_tasks(p_vehicle_group_code,p_tasks,null);
  if p_order_id is not null then
    select * into parent from public.garage_orders where id=p_order_id;
    if not found then raise exception 'Order unavailable.'; end if;
  end if;
  for item in select value from jsonb_array_elements(p_tasks) loop
    status:=null; n:=null;v:=null;g:=null;
    if nullif(item->>'id','') is not null then
      if p_order_id is null then raise exception 'Existing task needs its order.'; end if;
      select t.* into task from public.garage_order_tasks t where t.id=(item->>'id')::uuid and t.order_id=p_order_id and t.status<>'cancelled';
      if not found then raise exception 'Task unavailable.'; end if;
      if task.work_code=item->>'work_code' and task.options=coalesce(item->'options','{}'::jsonb) and parent.vehicle_group_code=p_vehicle_group_code then
        select f.pricing_status,f.net_amount,f.vat_amount,f.gross_amount into status,n,v,g from public.garage_task_financials f where f.task_id=task.id;
      end if;
    end if;
    if status is null then
      select m.net_amount,l.vat_rate into amount from public.garage_price_lists l join public.garage_price_matrix m on m.price_list_id=l.id
        where l.status='active' and l.effective_date<=current_date and m.vehicle_group_code=p_vehicle_group_code and m.work_code=item->>'work_code';
      if found then status:='priced';n:=amount.net_amount;v:=round(n*amount.vat_rate,2);g:=n+v;
      else status:='needs_pricing'; end if;
    end if;
    missing:=missing or status<>'priced';net:=net+coalesce(n,0);tax:=tax+coalesce(v,0);gross:=gross+coalesce(g,0);
    items:=items||jsonb_build_array(jsonb_build_object('task_id',item->>'id','work_code',item->>'work_code','status',status,'net_amount',n,'vat_amount',v,'gross_amount',g));
  end loop;
  return jsonb_build_object('currency','BYN','status',case when missing then 'needs_pricing' else 'priced' end,
    'net_amount',case when missing then null else net end,'vat_amount',case when missing then null else tax end,
    'gross_amount',case when missing then null else gross end,'items',items);
end $$;

create function public.garage_edit_order(p_order_id uuid,p_expected_version integer,p_order jsonb,p_tasks jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
<<edit_order>>
declare
  actor uuid; payload jsonb; cached jsonb; parent public.garage_orders%rowtype; item jsonb;
  old_task public.garage_order_tasks%rowtype; new_id uuid; keep_ids uuid[]:=array[]::uuid[];
  retain boolean; options jsonb; assignee uuid; source_id uuid; original_key text; canonical_key text;
begin
  actor:=public.garage_require_actor();
  if not public.is_admin() then raise exception using errcode='42501',message='Only the Owner can edit orders.'; end if;
  -- Source before actor before order matches the registered-source ingestion path.
  perform 1 from public.garage_sheet_sources s where s.id in(
    select so.source_id from public.garage_sheet_orders so where so.order_id=p_order_id
    union select i.source_id from public.garage_manager_intake i where i.order_id=p_order_id) order by s.id for update;
  actor:=public.garage_lock_actor();
  payload:=jsonb_build_object('operation','edit_order','order_id',p_order_id,'expected',p_expected_version,'order',p_order,'tasks',p_tasks);
  cached:=public.garage_begin_request(p_request_id,payload);if cached is not null then return cached;end if;
  select * into parent from public.garage_orders where id=p_order_id for update;
  if not found then raise exception 'Order unavailable.'; end if;
  if parent.status<>'published' or parent.version is distinct from p_expected_version then
    raise exception using errcode='40001',message='The order changed. Refresh before editing.';
  end if;
  perform 1 from public.garage_order_tasks where order_id=p_order_id order by id for update;
  perform public.garage_validate_edit_fields(p_order);
  perform public.garage_validate_edit_tasks(p_order->>'vehicle_group_code',p_tasks,parent.source);
  canonical_key:=case when upper(btrim(coalesce(p_order->>'vin',''))) ~ '^[A-HJ-NPR-Z0-9]{17}$' and nullif(p_order->>'planned_date','') is not null
    then (p_order->>'planned_date')||'|'||upper(btrim(p_order->>'vin')) else null end;
  if canonical_key is not null and (
    exists(select 1 from public.garage_sheet_orders other_link join public.garage_orders other_order on other_order.id=other_link.order_id
      where other_link.order_id<>p_order_id and other_link.source_id in (
        select so.source_id from public.garage_sheet_orders so where so.order_id=p_order_id
        union select i.source_id from public.garage_manager_intake i where i.order_id=p_order_id)
      and other_order.planned_date=nullif(p_order->>'planned_date','')::date and upper(btrim(other_order.vin))=upper(btrim(p_order->>'vin')))
    or exists(select 1 from public.garage_manager_intake i where i.owner_managed and i.order_id is distinct from p_order_id
      and canonical_key in(i.original_source_key,i.owner_canonical_key) and i.source_id in(
        select so.source_id from public.garage_sheet_orders so where so.order_id=p_order_id
        union select own_intake.source_id from public.garage_manager_intake own_intake where own_intake.order_id=p_order_id))) then
    raise exception using errcode='40001',message='This source visit already belongs to another order.';
  end if;
  if public.garage_private_note(p_order->>'instructions') or exists(select 1 from jsonb_array_elements(p_tasks) t
    where public.garage_private_note(t->>'instructions')) then raise exception 'Keep commercial notes in Owner-only information.'; end if;
  if exists(select 1 from public.garage_order_tasks where order_id=p_order_id and status in ('in_progress','blocked','completed'))
    and parent.vehicle_group_code is distinct from p_order->>'vehicle_group_code' then
    raise exception 'The vehicle group cannot change after work has started.';
  end if;
  for item in select value from jsonb_array_elements(p_tasks) loop
    if nullif(item->>'id','') is not null then
      select * into old_task from public.garage_order_tasks where id=(item->>'id')::uuid and order_id=p_order_id and status<>'cancelled';
      if not found then raise exception 'A selected task no longer belongs to this order.'; end if;
      if old_task.status<>'pending' and (old_task.work_code is distinct from item->>'work_code'
        or old_task.options is distinct from coalesce(item->'options','{}'::jsonb)
        or old_task.instructions is distinct from btrim(coalesce(item->>'instructions',''))
        or old_task.assigned_to is distinct from nullif(item->>'assigned_to','')::uuid) then
        raise exception 'Started and completed work must remain unchanged. Use task actions for reassignment.';
      end if;
      if old_task.status<>'pending' or (old_task.work_code=item->>'work_code'
        and old_task.options=coalesce(item->'options','{}'::jsonb) and parent.vehicle_group_code=p_order->>'vehicle_group_code') then
        keep_ids:=array_append(keep_ids,old_task.id);
      end if;
    end if;
  end loop;
  if exists(select 1 from public.garage_order_tasks where order_id=p_order_id and status in ('in_progress','blocked','completed')
    and not(id=any(keep_ids))) then raise exception 'Include all started and completed tasks unchanged.'; end if;
  -- No task or financial history is deleted. Removed/replaced pending work is cancelled.
  insert into public.garage_task_events(order_id,task_id,actor_id,action,note)
    select p_order_id,id,actor,'cancel','Replaced or removed by the Owner.' from public.garage_order_tasks
    where order_id=p_order_id and status='pending' and not(id=any(keep_ids));
  update public.garage_order_tasks set status='cancelled',version=version+1
    where order_id=p_order_id and status='pending' and not(id=any(keep_ids));
  for item in select value from jsonb_array_elements(p_tasks) loop
    options:=coalesce(item->'options','{}'::jsonb);assignee:=nullif(item->>'assigned_to','')::uuid;
    new_id:=nullif(item->>'id','')::uuid;
    if new_id=any(keep_ids) then
      select * into old_task from public.garage_order_tasks where id=new_id;
      if old_task.status='pending' and (old_task.instructions is distinct from btrim(coalesce(item->>'instructions',''))
        or old_task.assigned_to is distinct from assignee) then
        update public.garage_order_tasks set instructions=btrim(coalesce(item->>'instructions','')),assigned_to=assignee,version=version+1 where id=new_id;
        insert into public.garage_task_events(order_id,task_id,actor_id,action,note)
          values(p_order_id,new_id,actor,'owner_task_edited','Owner changed pending task details.');
      end if;
    else
      insert into public.garage_order_tasks(order_id,work_code,work_name,options,instructions,assigned_to)
        select p_order_id,w.code,w.name,options,btrim(coalesce(item->>'instructions','')),assignee from public.garage_works w
        where w.code=item->>'work_code' returning id into new_id;
      perform public.garage_snapshot_task(new_id,p_order->>'vehicle_group_code');
      insert into public.garage_task_events(order_id,task_id,actor_id,action,note)
        values(p_order_id,new_id,actor,'created','Added by the Owner.');
    end if;
  end loop;
  update public.garage_orders set vehicle=btrim(p_order->>'vehicle'),vin=upper(btrim(coalesce(p_order->>'vin',''))),
    colour=btrim(coalesce(p_order->>'colour','')),vehicle_group_code=p_order->>'vehicle_group_code',
    manager_label=case when parent.source='manager' then btrim(coalesce(p_order->>'manager_label','')) else '' end,
    instructions=btrim(coalesce(p_order->>'instructions','')),due_date=nullif(p_order->>'due_date','')::date,
    planned_date=nullif(p_order->>'planned_date','')::date,priority=coalesce(p_order->>'priority','normal'),version=version+1
    where id=p_order_id;
  -- Bind not-yet-acknowledged automatic imports via their durable external ID.
  update public.garage_manager_intake i set order_id=p_order_id
    where i.order_id is null and exists(select 1 from public.garage_sheet_orders so join public.garage_sheet_pull_feeds f on f.source_id=so.source_id
      cross join lateral jsonb_each(f.state->'entries') e where so.order_id=p_order_id and so.source_id=i.source_id
      and e.value->>'external_order_id'=so.external_order_id::text and e.key=i.original_source_key);
  if exists(select 1 from public.garage_sheet_orders where order_id=p_order_id)
    and not exists(select 1 from public.garage_manager_intake where order_id=p_order_id) then
    raise exception using errcode='40001',message='Source details are still synchronizing. Refresh shortly.';
  end if;
  update public.garage_manager_intake set owner_managed=true,owner_canonical_key=canonical_key,version=version+1,updated_at=clock_timestamp()
    where order_id=p_order_id;
  insert into public.garage_task_events(order_id,actor_id,action,note) values(p_order_id,actor,'owner_edited','Owner interpreted or edited the order.');
  return public.garage_finish_request(p_request_id,payload,jsonb_build_object('order_id',p_order_id,'order_number',parent.order_number,
    'version',parent.version+1,'status','published'));
end $$;

create function public.garage_publish_manager_intake(p_intake_id uuid,p_expected_version integer,p_order jsonb,p_tasks jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
<<publish_intake>>
declare
  actor uuid; source public.garage_sheet_sources%rowtype; intake public.garage_manager_intake%rowtype;
  source_id uuid; payload jsonb; cached jsonb; created jsonb; order_id uuid; canonical_key text; clean_tasks jsonb;
  item jsonb; task record; external_task uuid;
begin
  actor:=public.garage_require_actor();
  if not public.is_admin() then raise exception using errcode='42501',message='Only the Owner can interpret Manager orders.'; end if;
  select i.source_id into source_id from public.garage_manager_intake i where i.id=p_intake_id;
  select * into source from public.garage_sheet_sources where id=source_id and owner_id=actor for update;
  if not found then raise exception using errcode='42501',message='Manager request unavailable.'; end if;
  actor:=public.garage_lock_actor();
  payload:=jsonb_build_object('operation','publish_manager_intake','intake_id',p_intake_id,'expected',p_expected_version,'order',p_order,'tasks',p_tasks);
  cached:=public.garage_begin_request(p_request_id,payload);if cached is not null then return cached;end if;
  select * into intake from public.garage_manager_intake where id=p_intake_id for update;
  if intake.version is distinct from p_expected_version or intake.order_id is not null or intake.source_completed or intake.source_missing then
    raise exception using errcode='40001',message='The Manager request changed. Refresh before interpreting it.';
  end if;
  if cardinality(intake.row_numbers)<>1 then raise exception 'Clarify duplicated source identities before publishing.'; end if;
  perform public.garage_validate_edit_fields(p_order);
  perform public.garage_validate_edit_tasks(p_order->>'vehicle_group_code',p_tasks,'manager');
  if upper(btrim(coalesce(p_order->>'vin',''))) !~ '^[A-HJ-NPR-Z0-9]{17}$' or nullif(p_order->>'planned_date','') is null then
    raise exception 'Complete the Manager visit date and VIN before publishing.';
  end if;
  if length(btrim(coalesce(p_order->>'manager_label','')))=0 then raise exception 'Enter the Manager reference.'; end if;
  if public.garage_private_note(p_order->>'instructions') or exists(select 1 from jsonb_array_elements(p_tasks) t
    where public.garage_private_note(t->>'instructions')) then raise exception 'Keep commercial notes in Owner-only information.'; end if;
  if exists(select 1 from jsonb_array_elements(p_tasks) t where nullif(t->>'id','') is not null) then raise exception 'New Manager tasks cannot reuse existing task IDs.'; end if;
  canonical_key:=(p_order->>'planned_date')||'|'||upper(btrim(p_order->>'vin'));
  if exists(select 1 from public.garage_manager_intake i where i.source_id=source.id and i.id<>intake.id and i.owner_managed
    and canonical_key in(i.original_source_key,i.owner_canonical_key))
    or exists(select 1 from public.garage_sheet_orders so join public.garage_orders o on o.id=so.order_id
      where so.source_id=source.id and o.planned_date=nullif(p_order->>'planned_date','')::date and upper(btrim(o.vin))=upper(btrim(p_order->>'vin'))) then
    raise exception using errcode='40001',message='This visit already has an order. Refresh and edit that order.';
  end if;
  select jsonb_agg(t-'id') into clean_tasks from jsonb_array_elements(p_tasks) t;
  created:=public.garage_create_order(p_order->>'vehicle',p_order->>'vehicle_group_code','manager',clean_tasks,
    md5('garage-intake-create:'||actor::text||':'||p_request_id::text)::uuid,coalesce(p_order->>'instructions',''),
    nullif(p_order->>'due_date','')::date,coalesce(p_order->>'priority','normal'),coalesce(p_order->>'vin',''),
    coalesce(p_order->>'colour',''),coalesce(p_order->>'manager_label',''),nullif(p_order->>'planned_date','')::date);
  order_id:=(created->>'order_id')::uuid;
  -- Reserve an external identity now; later reader snapshots cannot create a second order.
  insert into public.garage_sheet_orders(source_id,external_order_id,order_id,last_revision,last_order_version)
    values(source.id,intake.id,order_id,1,1);
  for task in select t.id from public.garage_order_tasks t where t.order_id=publish_intake.order_id order by t.id loop
    external_task:=md5('garage-intake-task:'||intake.id::text||':'||task.id::text)::uuid;
    insert into public.garage_sheet_tasks(source_id,external_task_id,external_order_id,task_id) values(source.id,external_task,intake.id,task.id);
    insert into public.garage_sheet_task_versions(source_id,external_task_id,external_order_id,revision,task_id) values(source.id,external_task,intake.id,1,task.id);
  end loop;
  update public.garage_manager_intake set order_id=publish_intake.order_id,owner_managed=true,owner_canonical_key=canonical_key,
    version=version+1,updated_at=clock_timestamp() where id=intake.id;
  insert into public.garage_task_events(order_id,actor_id,action,note)
    values(order_id,actor,'manager_interpreted','Owner selected catalogue tasks from the original Manager request.');
  return public.garage_finish_request(p_request_id,payload,created||jsonb_build_object('version',1));
end $$;

-- The existing service function retains all receipt/idempotency validation.
-- This wrapper adds a final source-locked Owner override guard, including races
-- where an automatic immutable request was captured before the Owner's edit.
alter function public.garage_ingest_sheet(uuid,text,jsonb) rename to garage_ingest_sheet_unmanaged;
revoke all on function public.garage_ingest_sheet_unmanaged(uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.garage_ingest_sheet(p_source_id uuid,p_secret text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare source public.garage_sheet_sources%rowtype; key text; owned boolean; receipt jsonb; linked_order uuid;
begin
  select * into source from public.garage_sheet_sources where id=p_source_id for update;
  if not found or not source.active or p_secret is null or source.secret_hash is distinct from public.garage_sheet_hash(p_secret) then
    raise exception using errcode='42501',message='Spreadsheet source authentication failed.';
  end if;
  perform 1 from public.profiles where id=source.owner_id and active and role='admin' for share;
  if not found then raise exception using errcode='42501',message='Spreadsheet source authentication failed.'; end if;
  -- Previously recorded receipts remain immutable even after an Owner edit.
  -- Delegate their exact replay/payload-hash conflict to the original function.
  if p_payload->>'submission_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists(select 1 from public.garage_sheet_submissions where source_id=p_source_id
      and submission_id=(p_payload->>'submission_id')::uuid) then
    return public.garage_ingest_sheet_unmanaged(p_source_id,p_secret,p_payload);
  end if;
  key:=case when p_payload->'order'->>'planned_date' ~ '^\d{4}-\d{2}-\d{2}$' and upper(btrim(p_payload->'order'->>'vin')) ~ '^[A-HJ-NPR-Z0-9]{17}$'
    then (p_payload->'order'->>'planned_date')||'|'||upper(btrim(p_payload->'order'->>'vin')) else null end;
  select exists(select 1 from public.garage_manager_intake i where i.source_id=p_source_id and i.owner_managed and
    (key in(i.original_source_key,i.owner_canonical_key) or exists(select 1 from public.garage_sheet_orders so
      where so.source_id=p_source_id and so.external_order_id::text=p_payload->>'external_order_id' and so.order_id=i.order_id))) into owned;
  if owned then return jsonb_build_object('status','conflict','submission_id',p_payload->'submission_id',
    'external_order_id',p_payload->'external_order_id','revision',p_payload->'revision',
    'error',jsonb_build_object('code','ORDER_CHANGED','message','The Owner manages this order in the application.'));
  end if;
  receipt:=public.garage_ingest_sheet_unmanaged(p_source_id,p_secret,p_payload);
  if receipt->>'status'='accepted' and key is not null then
    select so.order_id into linked_order from public.garage_sheet_orders so
      where so.source_id=p_source_id and so.external_order_id::text=p_payload->>'external_order_id';
    if linked_order is not null then
      update public.garage_manager_intake set order_id=linked_order,version=version+1,updated_at=clock_timestamp()
        where source_id=p_source_id and original_source_key=key and order_id is null and not owner_managed;
    end if;
  end if;
  return receipt;
end $$;

create function public.garage_order_source_info(p_order_id uuid) returns jsonb
language sql security definer stable set search_path=pg_catalog,public as $$
  select jsonb_build_object('source_id',i.source_id,'source_name',s.name,'source_row_number',case when i.source_missing then null else i.row_numbers[1] end,
    'source_row_numbers',i.row_numbers,'owner_managed',i.owner_managed,
    'source_changed',i.source_missing or public.garage_intake_content(i.original_observations) is distinct from public.garage_intake_content(i.observations),'source_missing',i.source_missing)
  from public.garage_manager_intake i join public.garage_sheet_sources s on s.id=i.source_id where i.order_id=p_order_id
  order by i.created_at,i.id limit 1
$$;

create or replace function public.garage_list_orders() returns jsonb
language plpgsql security definer stable set search_path=pg_catalog,public as $$
begin
  perform public.garage_require_actor();
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',o.id,'order_number',o.order_number,'vehicle',o.vehicle,'vin',o.vin,'colour',o.colour,
    'vehicle_group_code',o.vehicle_group_code,'vehicle_group_name',g.name,'source',o.source,'manager_label',o.manager_label,
    'status',o.status,'instructions',o.instructions,'due_date',o.due_date,'planned_date',o.planned_date,
    'priority',o.priority,'version',o.version,'created_at',o.created_at,
    'source_id',meta.info->'source_id','source_name',meta.info->'source_name','source_row_number',meta.info->'source_row_number',
    'source_row_numbers',meta.info->'source_row_numbers','owner_managed',coalesce(meta.info->'owner_managed','false'::jsonb),
    'source_changed',coalesce(meta.info->'source_changed','false'::jsonb),
    'source_missing',coalesce(meta.info->'source_missing','false'::jsonb),
    'tasks',coalesce((select jsonb_agg(jsonb_build_object(
      'id',t.id,'work_code',t.work_code,'work_name',t.work_name,'options',t.options,'instructions',t.instructions,
      'status',t.status,'assigned_to',t.assigned_to,'assigned_name',a.name,'working_mechanic_id',t.working_mechanic_id,
      'working_name',w.name,'blocker_reason',t.blocker_reason,'version',t.version,'completed_at',t.completed_at
    ) order by t.created_at,t.id) from public.garage_order_tasks t
      left join public.profiles a on a.id=t.assigned_to left join public.profiles w on w.id=t.working_mechanic_id
      where t.order_id=o.id and public.garage_can_view_task(t.id)),'[]'::jsonb))
    order by coalesce(meta.info->>'source_name',''),nullif(meta.info->>'source_row_number','')::integer nulls last,o.created_at desc,o.id)
    from public.garage_orders o join public.garage_vehicle_groups g on g.code=o.vehicle_group_code
    left join lateral (select public.garage_order_source_info(o.id) as info) meta on true
    where public.garage_can_view_order(o.id)),'[]'::jsonb);
end $$;

revoke all on function public.garage_capture_manager_rows(uuid,uuid,integer,jsonb),public.garage_manager_intakes(),
  public.garage_validate_edit_fields(jsonb),public.garage_validate_edit_tasks(text,jsonb,text),public.garage_private_note(text),public.garage_intake_content(jsonb),
  public.garage_quote_order(text,jsonb,uuid),public.garage_edit_order(uuid,integer,jsonb,jsonb,uuid),
  public.garage_publish_manager_intake(uuid,integer,jsonb,jsonb,uuid),public.garage_order_source_info(uuid),
  public.garage_ingest_sheet(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.garage_capture_manager_rows(uuid,uuid,integer,jsonb),public.garage_ingest_sheet(uuid,text,jsonb) to service_role;
grant execute on function public.garage_manager_intakes(),public.garage_quote_order(text,jsonb,uuid),
  public.garage_edit_order(uuid,integer,jsonb,jsonb,uuid),public.garage_publish_manager_intake(uuid,integer,jsonb,jsonb,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values('20261115015355');
notify pgrst,'reload schema';
commit;
