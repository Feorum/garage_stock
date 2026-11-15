-- Keep every Owner interpretation identity reserved across later corrections.
begin;
alter table public.garage_manager_intake add column owner_source_keys text[] not null default array[]::text[];

-- Recover previous successful interpretations as well as the current columns.
update public.garage_manager_intake i set owner_source_keys=(
  select coalesce(array_agg(distinct k order by k),array[]::text[]) from (
    select unnest(array[i.original_source_key,i.owner_canonical_key]) as k
    union all
    select (r.payload->'order'->>'planned_date')||'|'||upper(btrim(r.payload->'order'->>'vin'))
    from public.garage_requests r where r.response->>'order_id'=i.order_id::text
      and r.payload->>'operation' in ('edit_order','publish_manager_intake')
  ) history where k ~ '^\d{4}-\d{2}-\d{2}\|[A-HJ-NPR-Z0-9]{17}$'
) where i.owner_managed;
create index garage_intake_owner_aliases_idx on public.garage_manager_intake using gin(owner_source_keys) where owner_managed;

create function public.garage_preserve_intake_keys() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare retained text[]:=array[]::text[];
begin
  if tg_op='UPDATE' then retained:=old.owner_source_keys||array[old.original_source_key,old.owner_canonical_key]; end if;
  if new.owner_managed then
    select coalesce(array_agg(distinct k order by k),array[]::text[]) into new.owner_source_keys
      from unnest(retained||new.owner_source_keys||array[new.original_source_key,new.owner_canonical_key]) k
      where k ~ '^\d{4}-\d{2}-\d{2}\|[A-HJ-NPR-Z0-9]{17}$';
    -- Edit/publication already hold the source lock, before order/intake locks.
    -- This reservation also covers historical aliases missed by current columns.
    if exists(select 1 from public.garage_manager_intake i where i.source_id=new.source_id
      and i.id<>new.id and i.owner_managed and i.order_id is distinct from new.order_id
      and i.owner_source_keys && new.owner_source_keys) then
      raise exception using errcode='40001',message='This source visit already belongs to another order.';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.garage_preserve_intake_keys() from public,anon,authenticated,service_role;
create trigger garage_intake_preserve_keys before insert or update on public.garage_manager_intake
  for each row execute function public.garage_preserve_intake_keys();

create or replace function public.garage_capture_manager_rows(
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
  if not found or p_lease_token is null or feed.lease_token is null or feed.lease_expires_at is null
    or feed.lease_token is distinct from p_lease_token or feed.state_version is distinct from p_expected_version
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
    select coalesce('owner:'||owned.id::text,observed.key) as key,
      jsonb_agg(observed.item order by (observed.item->>'row_number')::integer) as items
    from (select value as item,case when nullif(value->>'source_key','') is not null then 'identity:'||(value->>'source_key')
      else 'observation:'||public.garage_sheet_hash((value->'raw')::text) end as key from jsonb_array_elements(p_rows)) observed
    left join lateral (select i.id from public.garage_manager_intake i where i.source_id=p_source_id and i.owner_managed
      and (i.intake_key=observed.key or i.owner_source_keys @> array[observed.item->>'source_key'])
      order by i.created_at,i.id limit 1) owned on true
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
      (i.intake_key=grouped.key or 'owner:'||i.id::text=grouped.key
        or (i.owner_managed and source_key is not null and i.owner_source_keys @> array[source_key]))
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
    from public.garage_manager_intake i cross join lateral unnest(i.owner_source_keys) k
    where i.source_id=p_source_id and i.owner_managed;
  select coalesce(array_agg(distinct public.garage_sheet_hash(i.original_snapshot::text)),array[]::text[]) into managed_hashes
    from public.garage_manager_intake i where i.source_id=p_source_id and i.owner_managed;
  return jsonb_build_object('version',feed.state_version,'owner_managed_rows',to_jsonb(managed_rows),
    'owner_managed_keys',to_jsonb(managed_keys),'owner_managed_observations',to_jsonb(managed_hashes),
    'intakes_count',cardinality(seen));
end $$;

create or replace function public.garage_ingest_sheet(p_source_id uuid,p_secret text,p_payload jsonb) returns jsonb
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
    (i.owner_source_keys @> array[key] or exists(select 1 from public.garage_sheet_orders so
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

revoke all on function public.garage_capture_manager_rows(uuid,uuid,integer,jsonb),public.garage_ingest_sheet(uuid,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.garage_capture_manager_rows(uuid,uuid,integer,jsonb),public.garage_ingest_sheet(uuid,text,jsonb) to service_role;
insert into public.garage_schema_migrations(version) values('20261115022416');
notify pgrst,'reload schema';
commit;
