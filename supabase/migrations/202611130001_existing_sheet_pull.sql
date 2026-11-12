-- Read an existing operational Manager sheet without changing its layout.
-- Actual workbook IDs, row data and credentials are configured privately.
begin;

create table public.garage_sheet_pull_feeds (
  source_id uuid primary key references public.garage_sheet_sources(id),
  sheet_gid text not null check (sheet_gid ~ '^[0-9]{1,20}$'),
  adapter text not null default 'alfort_v1' check (adapter='alfort_v1'),
  reader_only boolean not null default true,
  credential_secret_id uuid not null,
  state jsonb not null default '{}' check (jsonb_typeof(state)='object'),
  state_version integer not null default 1 check (state_version>0),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_polled_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  summary jsonb not null default '{}' check (jsonb_typeof(summary)='object'),
  review jsonb not null default '[]' check (jsonb_typeof(review)='array'),
  check ((lease_token is null)=(lease_expires_at is null))
);
create table public.garage_sheet_pull_scheduler (
  singleton boolean primary key default true check (singleton),
  function_url text not null,
  credential_secret_id uuid not null
);
alter table public.garage_sheet_pull_feeds enable row level security;
alter table public.garage_sheet_pull_scheduler enable row level security;
revoke all on public.garage_sheet_pull_feeds,public.garage_sheet_pull_scheduler from public,anon,authenticated,service_role;

create function public.garage_sheet_pull_json(p_source_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',s.id,'source_id',s.id,'name',s.name,
    'spreadsheet_id',s.spreadsheet_id,'sheet_gid',f.sheet_gid,'mode','pull',
    'adapter',f.adapter,'reader_only',f.reader_only,'active',s.active,'version',s.version,'created_at',s.created_at,
    'last_polled_at',f.last_polled_at,'last_success_at',f.last_success_at,
    'last_error_code',f.last_error_code,'summary',f.summary,'review_count',jsonb_array_length(f.review))
  from public.garage_sheet_sources s join public.garage_sheet_pull_feeds f on f.source_id=s.id
  where s.id=p_source_id;
$$;

create or replace function public.garage_sheet_source_json(p_source_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select coalesce(public.garage_sheet_pull_json(p_source_id),
    (select jsonb_build_object('id',id,'source_id',id,'name',name,'spreadsheet_id',spreadsheet_id,
      'mode','push','active',active,'version',version,'created_at',created_at,'last_success_at',last_success_at,
      'last_error_at',last_error_at,'last_error_code',last_error_code,'last_error',last_error)
      from public.garage_sheet_sources where id=p_source_id));
$$;

create function public.garage_sheet_pull_sources() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform public.garage_require_actor();
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only the Owner can manage spreadsheet connections.'; end if;
  return coalesce((select jsonb_agg(public.garage_sheet_pull_json(s.id) order by s.created_at,s.id)
    from public.garage_sheet_sources s join public.garage_sheet_pull_feeds f on f.source_id=s.id
    where s.owner_id=auth.uid()),'[]'::jsonb);
end $$;

create function public.garage_sheet_pull_reviews(p_source_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  perform public.garage_require_actor();
  if not public.garage_sheet_can_view(p_source_id) then raise exception using errcode='42501',message='This spreadsheet connection is unavailable.'; end if;
  select review into result from public.garage_sheet_pull_feeds where source_id=p_source_id;
  if not found then raise exception using errcode='42501',message='This spreadsheet connection is unavailable.'; end if;
  return result;
end $$;

create function public.garage_connect_sheet_pull(p_name text,p_spreadsheet_id text,p_sheet_gid text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor uuid:=public.garage_lock_actor(); source public.garage_sheet_sources%rowtype;
  feed public.garage_sheet_pull_feeds%rowtype; new_source_id uuid; secret text; secret_id uuid;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only the Owner can connect a Manager spreadsheet.'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120
    or p_spreadsheet_id is null or p_spreadsheet_id !~ '^[A-Za-z0-9_-]{10,200}$'
    or p_sheet_gid is null or p_sheet_gid !~ '^[0-9]{1,20}$' then
    raise exception 'Provide the existing spreadsheet link, tab ID and connection name.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('garage-sheet-pull:'||p_spreadsheet_id,0));
  select * into source from public.garage_sheet_sources where spreadsheet_id=p_spreadsheet_id for update;
  if found then
    if source.owner_id<>actor then raise exception using errcode='42501',message='This spreadsheet connection is unavailable.'; end if;
    select * into feed from public.garage_sheet_pull_feeds where source_id=source.id;
    if not found or feed.sheet_gid<>p_sheet_gid then
      raise exception using errcode='40001',message='This spreadsheet is already connected with different settings.';
    end if;
    return public.garage_sheet_pull_json(source.id);
  end if;
  new_source_id:=gen_random_uuid();
  secret:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  perform public.garage_register_sheet(btrim(p_name),p_spreadsheet_id,new_source_id,secret);
  select vault.create_secret(secret,'garage-pull-source-'||new_source_id::text,
    'Dedicated credential for the read-only operational-sheet importer') into secret_id;
  insert into public.garage_sheet_pull_feeds(source_id,sheet_gid,credential_secret_id)
    values(new_source_id,p_sheet_gid,secret_id);
  return public.garage_sheet_pull_json(new_source_id);
end $$;

-- A private read-only worker runs in the Owner's Google account. The browser
-- supplies a newly generated scoped secret once; it is never returned by SQL.
create function public.garage_prepare_sheet_reader(p_source_id uuid,p_secret text,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor uuid:=public.garage_lock_actor(); source public.garage_sheet_sources%rowtype;
  feed public.garage_sheet_pull_feeds%rowtype; changed boolean;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only the Owner can prepare a private spreadsheet reader.'; end if;
  select * into source from public.garage_sheet_sources where id=p_source_id and owner_id=actor for update;
  if not found then raise exception using errcode='42501',message='This spreadsheet connection is unavailable.'; end if;
  select * into feed from public.garage_sheet_pull_feeds where source_id=p_source_id for update;
  if not found then raise exception using errcode='42501',message='This spreadsheet connection is unavailable.'; end if;
  changed:=source.secret_hash is distinct from public.garage_sheet_hash(p_secret);
  perform public.garage_rotate_sheet_secret(p_source_id,p_secret,p_expected_version);
  perform vault.update_secret(feed.credential_secret_id,p_secret);
  update public.garage_sheet_pull_feeds set reader_only=true,
    lease_token=case when changed then null else lease_token end,
    lease_expires_at=case when changed then null else lease_expires_at end where source_id=p_source_id;
  return public.garage_sheet_pull_json(p_source_id);
end $$;

-- The service worker leases a feed. Opaque state and credentials are never
-- selectable by either browser role, including the Owner.
create function public.garage_acquire_sheet_pulls() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare feed public.garage_sheet_pull_feeds%rowtype; source public.garage_sheet_sources%rowtype;
  result jsonb:='[]'; credential text; token uuid;
begin
  for feed in select f.* from public.garage_sheet_pull_feeds f
    join public.garage_sheet_sources s on s.id=f.source_id
    join public.profiles p on p.id=s.owner_id
    where not f.reader_only and s.active and p.active and p.role='admin'
      and (f.lease_expires_at is null or f.lease_expires_at<=clock_timestamp())
    order by f.last_polled_at nulls first,f.source_id limit 5 for update of f skip locked
  loop
    select * into source from public.garage_sheet_sources where id=feed.source_id;
    select decrypted_secret into credential from vault.decrypted_secrets where id=feed.credential_secret_id;
    if credential is null or public.garage_sheet_hash(credential) is distinct from source.secret_hash then
      update public.garage_sheet_pull_feeds set last_polled_at=clock_timestamp(),last_error_code='CONNECTION_UNAVAILABLE' where source_id=feed.source_id;
      continue;
    end if;
    token:=gen_random_uuid();
    update public.garage_sheet_pull_feeds set lease_token=token,
      lease_expires_at=clock_timestamp()+interval '5 minutes',last_polled_at=clock_timestamp()
      where source_id=feed.source_id;
    result:=result||jsonb_build_array(jsonb_build_object('source_id',source.id,
      'spreadsheet_id',source.spreadsheet_id,'sheet_gid',feed.sheet_gid,'adapter',feed.adapter,
      'state',feed.state,'summary',feed.summary,'review',feed.review,
      'version',feed.state_version,'lease_token',token,'credential',credential));
  end loop;
  return result;
end $$;

create function public.garage_acquire_sheet_reader(p_source_id uuid,p_secret text,p_spreadsheet_id text,p_sheet_gid text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare source public.garage_sheet_sources%rowtype; feed public.garage_sheet_pull_feeds%rowtype; token uuid;
begin
  source:=public.garage_sheet_authenticate(p_source_id,p_secret);
  if p_spreadsheet_id is distinct from source.spreadsheet_id then
    raise exception using errcode='42501',message='This spreadsheet connection is unavailable.';
  end if;
  select * into feed from public.garage_sheet_pull_feeds where source_id=source.id for update;
  if not found or not feed.reader_only or p_sheet_gid is distinct from feed.sheet_gid then
    raise exception using errcode='42501',message='This spreadsheet connection is unavailable.';
  end if;
  if feed.lease_expires_at>clock_timestamp() then return null; end if;
  token:=gen_random_uuid();
  update public.garage_sheet_pull_feeds set lease_token=token,
    lease_expires_at=clock_timestamp()+interval '5 minutes',last_polled_at=clock_timestamp()
    where source_id=source.id;
  return jsonb_build_object('source_id',source.id,'spreadsheet_id',source.spreadsheet_id,
    'sheet_gid',feed.sheet_gid,'adapter',feed.adapter,'state',feed.state,'summary',feed.summary,'review',feed.review,
    'version',feed.state_version,'lease_token',token,'credential',p_secret);
end $$;

create function public.garage_checkpoint_sheet_pull(p_source_id uuid,p_lease_token uuid,p_expected_version integer,p_state jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare next_version integer;
begin
  if p_state is null or jsonb_typeof(p_state)<>'object' or octet_length(p_state::text)>4194304 then
    raise exception 'Invalid private importer state.';
  end if;
  update public.garage_sheet_pull_feeds set state=p_state,state_version=state_version+1,
    lease_expires_at=clock_timestamp()+interval '5 minutes'
    where source_id=p_source_id and lease_token=p_lease_token and lease_expires_at>clock_timestamp()
      and state_version=p_expected_version returning state_version into next_version;
  if not found then raise exception using errcode='40001',message='The importer lease changed. Retry from the durable state.'; end if;
  return jsonb_build_object('version',next_version);
end $$;

create function public.garage_commit_sheet_pull(p_source_id uuid,p_lease_token uuid,p_expected_version integer,
  p_state jsonb,p_summary jsonb,p_review jsonb,p_error_code text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare next_version integer; item jsonb;
begin
  if p_state is null or jsonb_typeof(p_state)<>'object' or octet_length(p_state::text)>4194304
    or p_summary is null or jsonb_typeof(p_summary)<>'object' or octet_length(p_summary::text)>16384
    or p_review is null or jsonb_typeof(p_review)<>'array' or jsonb_array_length(p_review)>2000
    or octet_length(p_review::text)>1048576
    or (p_error_code is not null and p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception 'Invalid importer result.';
  end if;
  for item in select value from jsonb_array_elements(p_review) loop
    if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) k
      where k not in ('row_number','reason_codes','vehicle','planned_date','source_key'))
      or jsonb_typeof(item->'row_number') is distinct from 'number'
      or (item->>'row_number') !~ '^[0-9]{1,7}$' or (item->>'row_number')::integer<1
      or jsonb_typeof(item->'reason_codes') is distinct from 'array'
      or jsonb_array_length(item->'reason_codes')>30
      or exists(select 1 from jsonb_array_elements(item->'reason_codes') r
        where jsonb_typeof(r)<>'string' or (r#>>'{}') !~ '^[A-Z][A-Z0-9_]{0,63}$')
      or (item ? 'vehicle' and (jsonb_typeof(item->'vehicle')<>'string' or length(item->>'vehicle')>200))
      or (item ? 'planned_date' and item->'planned_date'<>'null'::jsonb and
        (jsonb_typeof(item->'planned_date')<>'string' or (item->>'planned_date') !~ '^\d{4}-\d{2}-\d{2}$'))
      or (item ? 'source_key' and item->'source_key'<>'null'::jsonb and
        (jsonb_typeof(item->'source_key')<>'string' or length(item->>'source_key')>200)) then
      raise exception 'Invalid private review fields.';
    end if;
  end loop;
  update public.garage_sheet_pull_feeds set state=p_state,state_version=state_version+1,
    summary=p_summary,review=p_review,last_error_code=p_error_code,
    last_success_at=case when p_error_code is null then clock_timestamp() else last_success_at end,
    last_polled_at=clock_timestamp(),lease_token=null,lease_expires_at=null
    where source_id=p_source_id and lease_token=p_lease_token and lease_expires_at>clock_timestamp()
      and state_version=p_expected_version returning state_version into next_version;
  if not found then raise exception using errcode='40001',message='The importer lease changed. Retry from the durable state.'; end if;
  if p_error_code is null then
    update public.garage_sheet_sources set last_success_at=clock_timestamp(),last_error_at=null,last_error_code=null,last_error=null where id=p_source_id;
  else
    update public.garage_sheet_sources set last_error_at=clock_timestamp(),last_error_code=p_error_code,
      last_error='The latest spreadsheet check could not finish. Review the connection status.' where id=p_source_id;
  end if;
  return jsonb_build_object('version',next_version);
end $$;

-- Project-bound scheduler target. The cron command contains only a function
-- call; its random credential is kept in Vault and read just before the HTTP call.
create function public.garage_configure_sheet_pull_scheduler(p_url text,p_secret text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare secret_id uuid;
begin
  if p_url is distinct from 'https://cjcevfdhzaemxqhhxtrt.supabase.co/functions/v1/pull-manager-sheets'
    or p_secret is null or length(p_secret) not between 32 and 256 or p_secret !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Provide the project importer endpoint and a private scheduler credential.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('garage-sheet-pull-scheduler',0));
  select credential_secret_id into secret_id from public.garage_sheet_pull_scheduler where singleton;
  if found then
    perform vault.update_secret(secret_id,p_secret);
    update public.garage_sheet_pull_scheduler set function_url=p_url where singleton;
  else
    select vault.create_secret(p_secret,'garage-sheet-pull-scheduler','Scheduled importer authorization') into secret_id;
    insert into public.garage_sheet_pull_scheduler(singleton,function_url,credential_secret_id) values(true,p_url,secret_id);
  end if;
  return jsonb_build_object('configured',true);
end $$;

create function public.garage_run_sheet_pull() returns bigint
language plpgsql security definer set search_path=pg_catalog,public as $$
declare config public.garage_sheet_pull_scheduler%rowtype; credential text; request_id bigint;
begin
  select * into config from public.garage_sheet_pull_scheduler where singleton;
  if not found then raise exception 'The importer schedule is not configured.'; end if;
  select decrypted_secret into credential from vault.decrypted_secrets where id=config.credential_secret_id;
  if credential is null then raise exception 'The importer schedule is not configured.'; end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 120000)'
    into request_id using config.function_url,
    jsonb_build_object('Authorization','Bearer '||credential,'Content-Type','application/json'),'{}'::jsonb;
  return request_id;
end $$;

revoke all on function public.garage_sheet_pull_json(uuid) from public,anon,authenticated,service_role;
revoke all on function public.garage_sheet_pull_sources(),public.garage_sheet_pull_reviews(uuid),
  public.garage_connect_sheet_pull(text,text,text),public.garage_prepare_sheet_reader(uuid,text,integer) from public,anon;
grant execute on function public.garage_sheet_pull_sources(),public.garage_sheet_pull_reviews(uuid),
  public.garage_connect_sheet_pull(text,text,text),public.garage_prepare_sheet_reader(uuid,text,integer) to authenticated;
revoke all on function public.garage_acquire_sheet_pulls(),public.garage_acquire_sheet_reader(uuid,text,text,text),public.garage_checkpoint_sheet_pull(uuid,uuid,integer,jsonb),
  public.garage_commit_sheet_pull(uuid,uuid,integer,jsonb,jsonb,jsonb,text),
  public.garage_configure_sheet_pull_scheduler(text,text),public.garage_run_sheet_pull() from public,anon,authenticated;
grant execute on function public.garage_acquire_sheet_pulls(),public.garage_acquire_sheet_reader(uuid,text,text,text),public.garage_checkpoint_sheet_pull(uuid,uuid,integer,jsonb),
  public.garage_commit_sheet_pull(uuid,uuid,integer,jsonb,jsonb,jsonb,text),
  public.garage_configure_sheet_pull_scheduler(text,text),public.garage_run_sheet_pull() to service_role;

insert into public.garage_schema_migrations(version) values('202611130001');
notify pgrst,'reload schema';
commit;
