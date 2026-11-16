-- Private source snapshots and an independently editable Owner working ledger.
begin;
create schema garage_ledger;
revoke all on schema garage_ledger from public,anon,authenticated,service_role;
grant usage on schema garage_ledger to authenticated;

create table garage_ledger.imports (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  filename text not null check (length(filename) between 1 and 300),
  source_sha256 text not null unique check (source_sha256 ~ '^[0-9a-f]{64}$'),
  revision integer not null default 1 check (revision>0),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata)='object'),
  status text not null default 'staging' check (status in ('staging','ready')),
  imported_by uuid references public.profiles(id),
  imported_at timestamptz not null default now()
);
create table garage_ledger.sheets (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references garage_ledger.imports(id),
  sheet_key text not null,
  name text not null,
  sort integer not null,
  state text not null default 'visible' check (state in ('visible','hidden','veryHidden')),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata)='object'),
  unique(import_id,sheet_key), unique(import_id,name)
);
create table garage_ledger.rows (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references garage_ledger.sheets(id),
  source_row integer check (source_row>0),
  section text not null check (length(section) between 1 and 100),
  position numeric not null,
  original_cells jsonb not null default '{}' check (jsonb_typeof(original_cells)='object'),
  original_section text not null,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata)='object'),
  cells jsonb not null default '{}' check (jsonb_typeof(cells)='object'),
  version integer not null default 1 check (version>0),
  archived boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(sheet_id,source_row)
);
create index ledger_rows_sheet_order on garage_ledger.rows(sheet_id,position,id);
create table garage_ledger.revisions (
  id uuid primary key default gen_random_uuid(),
  row_id uuid not null references garage_ledger.rows(id),
  version integer not null,
  actor_id uuid not null references public.profiles(id),
  action text not null check (action in ('add','edit','archive','restore')),
  before_state jsonb,
  after_state jsonb not null,
  reason text not null check (length(reason) between 1 and 2000),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique(row_id,version)
);
create table garage_ledger.requests (
  actor_id uuid not null references public.profiles(id),
  request_id uuid not null,
  payload jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_id,request_id)
);

alter table garage_ledger.imports enable row level security;
alter table garage_ledger.sheets enable row level security;
alter table garage_ledger.rows enable row level security;
alter table garage_ledger.revisions enable row level security;
alter table garage_ledger.requests enable row level security;
revoke all on all tables in schema garage_ledger from public,anon,authenticated,service_role;
grant select on garage_ledger.imports,garage_ledger.sheets,garage_ledger.rows,garage_ledger.revisions to authenticated;
create policy owner_imports on garage_ledger.imports for select to authenticated
  using ((select public.garage_is_owner()) and status='ready');
create policy owner_sheets on garage_ledger.sheets for select to authenticated
  using ((select public.garage_is_owner()) and exists(select 1 from garage_ledger.imports i where i.id=import_id));
create policy owner_rows on garage_ledger.rows for select to authenticated
  using ((select public.garage_is_owner()) and exists(select 1 from garage_ledger.sheets s where s.id=sheet_id));
create policy owner_revisions on garage_ledger.revisions for select to authenticated
  using ((select public.garage_is_owner()) and exists(select 1 from garage_ledger.rows r where r.id=row_id));

create function garage_ledger.require_owner() returns uuid
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_lock_actor();
begin
  if not public.garage_is_owner() then
    raise exception using errcode='42501',message='Only an active Owner can change the business ledger.';
  end if;
  return actor;
end $$;
revoke all on function garage_ledger.require_owner() from public,anon,authenticated,service_role;

create function garage_ledger.validate_cells(p_cells jsonb) returns void
language plpgsql immutable set search_path=pg_catalog as $$
declare item record; cell jsonb; val jsonb; typ text; date_value date;
begin
  if p_cells is null or jsonb_typeof(p_cells)<>'object' or octet_length(p_cells::text)>131072
    or (select count(*) from jsonb_object_keys(p_cells))>256 then raise exception 'Invalid ledger cells.'; end if;
  for item in select * from jsonb_each(p_cells) loop
    cell:=item.value; val:=cell->'value'; typ:=cell->>'type';
    if item.key !~ '^[A-Z]{1,3}$' or jsonb_typeof(cell) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(cell) k where k not in ('value','type','formula','cached','format','override'))
      or typ is null or typ not in ('number','string','date','boolean','error')
      or not (cell ? 'value') or jsonb_typeof(val) not in ('null','number','string','boolean')
      or (cell ? 'cached' and jsonb_typeof(cell->'cached') not in ('null','number','string','boolean'))
      or (cell ? 'override' and jsonb_typeof(cell->'override')<>'boolean')
      or (cell->>'formula' is not null and (jsonb_typeof(cell->'formula')<>'string' or length(cell->>'formula')>8000))
      or (cell ? 'format' and (jsonb_typeof(cell->'format')<>'string' or length(cell->>'format')>300)) then
      raise exception 'Invalid ledger cell definition.';
    end if;
    if val<>'null'::jsonb then
      if (typ='number' and jsonb_typeof(val)<>'number')
        or (typ='boolean' and jsonb_typeof(val)<>'boolean')
        or (typ in ('string','date','error') and jsonb_typeof(val)<>'string')
        or (jsonb_typeof(val)='string' and length(cell->>'value')>8000) then raise exception 'Invalid ledger value type.'; end if;
      if typ='date' then
        if cell->>'value' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Use an ISO calendar date.'; end if;
        date_value:=(cell->>'value')::date;
      end if;
      if typ='number' and abs((cell->>'value')::numeric)>1000000000000000 then
        raise exception 'The ledger number is outside the supported range.';
      end if;
    end if;
  end loop;
end $$;
revoke all on function garage_ledger.validate_cells(jsonb) from public,anon,authenticated,service_role;

insert into public.garage_schema_migrations(version) values ('20261116215609');
commit;
