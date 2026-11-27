begin;

-- Keep only the fingerprints needed to suppress re-imports and recognize retries.
create table garage_board.removed_source_keys (
  source_id uuid not null references public.garage_sheet_sources(id) on delete cascade,
  key_hash text not null,
  primary key(source_id,key_hash)
);
create table garage_board.removed_order_receipts (
  order_hash text primary key,
  request_hash text not null unique,
  order_version integer not null
);
create table garage_board.removed_order_requests (request_hash text primary key);
create table garage_board.order_photo_cleanup (
  order_id uuid not null,
  custom boolean not null,
  primary key(order_id,custom)
);
alter table garage_board.removed_source_keys enable row level security;
alter table garage_board.removed_order_receipts enable row level security;
alter table garage_board.removed_order_requests enable row level security;
alter table garage_board.order_photo_cleanup enable row level security;
revoke all on garage_board.removed_source_keys,garage_board.removed_order_receipts,
  garage_board.removed_order_requests,garage_board.order_photo_cleanup from public,anon,authenticated,service_role;

-- Preparation holds the parent row lock while recording the cleanup. Reject
-- changes after that point so finalization still has the confirmed version.
create or replace function garage_board.protect_deleted_order() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if old.deleted_at is not null or exists(
    select from garage_board.order_photo_cleanup q where q.order_id=old.id and q.custom=(tg_table_schema='garage_custom')
  ) then
    -- The spreadsheet's independent comment sync can continue for other orders.
    if tg_table_schema='public'
      and (to_jsonb(new)-array['manager_comment','manager_comment_updated_at','order_number'])
        =(to_jsonb(old)-array['manager_comment','manager_comment_updated_at','order_number']) then
      return null;
    end if;
    raise exception using errcode='40001',
      message=case when old.deleted_at is not null then 'The order was deleted.' else 'The order is being deleted.' end;
  end if;
  return new;
end $$;

create or replace function public.garage_begin_request(p_request_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_require_actor(); receipt public.garage_requests%rowtype;
begin
  if p_request_id is null then raise exception 'A request ID is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,0));
  if exists(select from garage_board.removed_order_requests where
      request_hash=public.garage_sheet_hash(actor::text||':'||p_request_id::text))
    or exists(select from garage_board.removed_order_receipts where
      request_hash=public.garage_sheet_hash(actor::text||':'||p_request_id::text)) then
    raise exception using errcode='40001',message='The order was deleted.';
  end if;
  select * into receipt from public.garage_requests where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.payload is distinct from p_payload then raise exception 'This request ID was already used for a different operation.'; end if;
    return receipt.response;
  end if;
  return null;
end $$;

-- A storage deletion is authorized only after an Owner has checked this order's
-- version. The order remains accessible if the Storage API fails and is retried.
create function garage_photos.can_remove_order_photo(p_name text) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
  select public.garage_is_owner() and (
    exists(select from garage_board.order_photo_cleanup q
      where not q.custom and q.order_id::text=split_part(p_name,'/',1))
    or (split_part(p_name,'/',1)='custom' and exists(
      select from garage_board.order_photo_cleanup q join garage_custom.orders o on o.id=q.order_id
      where q.custom and q.order_id::text=split_part(p_name,'/',2) and o.owner_id=auth.uid()))
  )
$$;
create or replace function garage_photos.can_upload(object_name text) returns boolean
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare visit_id uuid:=garage_photos.order_id(object_name);
begin
  if visit_id is null or not public.garage_can_view_order(visit_id) then return false; end if;
  perform 1 from public.garage_orders o where o.id=visit_id and o.status='published' and o.deleted_at is null for share;
  return found and not exists(select from garage_board.order_photo_cleanup where order_id=visit_id and not custom);
end $$;
create or replace function garage_photos.can_upload_custom_photo(object_name text) returns boolean
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare visit_id uuid:=garage_photos.custom_order_id(object_name);
begin
  if not public.garage_is_owner() then return false; end if;
  perform 1 from garage_custom.orders where id=visit_id and owner_id=auth.uid() and status='open' and deleted_at is null for share;
  return found and not exists(select from garage_board.order_photo_cleanup where order_id=visit_id and custom);
end $$;

revoke all on function garage_photos.can_remove_order_photo(text) from public,anon,authenticated,service_role;
grant execute on function garage_photos.can_remove_order_photo(text) to authenticated;
do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  create policy garage_pending_order_photo_read on storage.objects for select to authenticated
    using (bucket_id='garage-order-photos' and garage_photos.can_remove_order_photo(name));
  create policy garage_pending_order_photo_remove on storage.objects for delete to authenticated
    using (bucket_id='garage-order-photos' and garage_photos.can_remove_order_photo(name));
end $$;

create function garage_board.removed_source_key(p_source uuid,p_key text) returns boolean
language sql stable strict set search_path=pg_catalog as $$
  select exists(select from garage_board.removed_source_keys
    where source_id=p_source and key_hash=public.garage_sheet_hash(p_key))
$$;
revoke all on function garage_board.removed_source_key(uuid,text) from public,anon,authenticated,service_role;

-- Prevent a later observation or an exact submission replay from rebuilding a
-- removed visit. Keep current Sheet identities private and leave the Sheet intact.
alter function public.garage_capture_manager_rows(uuid,uuid,integer,jsonb) set schema garage_board;
revoke all on function garage_board.garage_capture_manager_rows(uuid,uuid,integer,jsonb) from public,anon,authenticated,service_role;
create function public.garage_capture_manager_rows(p_source_id uuid,p_lease_token uuid,p_expected_version integer,p_rows jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare filtered jsonb; excluded jsonb; result jsonb;
begin
  perform public.garage_sheet_require_lease(p_source_id,p_lease_token,p_expected_version);
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>5000
    or octet_length(p_rows::text)>12582912 then raise exception 'Invalid source observations.'; end if;
  select coalesce(jsonb_agg(row_item order by seq) filter(where blocked is not true),'[]'::jsonb),
    coalesce(jsonb_agg(row_item->'row_number' order by seq) filter(where blocked),'[]'::jsonb)
    into filtered,excluded
    from (select row_item,seq,
      garage_board.removed_source_key(p_source_id,'identity:'||(row_item->>'source_key'))
      or garage_board.removed_source_key(p_source_id,'observation:'||public.garage_sheet_hash((row_item->'raw')::text)) as blocked
      from jsonb_array_elements(p_rows) with ordinality as items(row_item,seq)) observations;
  result:=garage_board.garage_capture_manager_rows(p_source_id,p_lease_token,p_expected_version,filtered);
  return jsonb_set(result,'{owner_managed_rows}',(result->'owner_managed_rows')||excluded);
end $$;

alter function public.garage_ingest_sheet(uuid,text,jsonb) set schema garage_board;
revoke all on function garage_board.garage_ingest_sheet(uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.garage_ingest_sheet(p_source_id uuid,p_secret text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform 1 from public.garage_sheet_sources where id=p_source_id for update;
  perform public.garage_sheet_authenticate(p_source_id,p_secret);
  if garage_board.removed_source_key(p_source_id,'external:'||lower(p_payload->>'external_order_id'))
    or garage_board.removed_source_key(p_source_id,'identity:'||(p_payload->'order'->>'planned_date')||'|'||
      upper(btrim(p_payload->'order'->>'vin'))) then
    return jsonb_build_object('status','conflict','submission_id',p_payload->'submission_id',
      'external_order_id',p_payload->'external_order_id','revision',p_payload->'revision',
      'error',jsonb_build_object('code','ORDER_CHANGED','message','The order was deleted.'));
  end if;
  return garage_board.garage_ingest_sheet(p_source_id,p_secret,p_payload);
end $$;
revoke all on function public.garage_capture_manager_rows(uuid,uuid,integer,jsonb),public.garage_ingest_sheet(uuid,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.garage_capture_manager_rows(uuid,uuid,integer,jsonb),public.garage_ingest_sheet(uuid,text,jsonb) to service_role;

create function garage_board.remove_sheet_order(p_order_id uuid,p_sources uuid[]) returns void
language plpgsql set search_path=pg_catalog as $$
begin
  insert into garage_board.removed_source_keys(source_id,key_hash)
  select source_id,public.garage_sheet_hash(source_key) from (
    select s.source_id,'external:'||s.external_order_id::text as source_key
      from public.garage_sheet_orders s where s.order_id=p_order_id
    union
    select k.source_id,'identity:'||entries.source_key from unnest(p_sources) k(source_id)
      cross join lateral public.garage_sheet_order_keys(k.source_id) entries
      where entries.order_id=p_order_id
    union
    select i.source_id,keys.key from public.garage_manager_intake i
      cross join lateral unnest(array[i.intake_key,'identity:'||i.original_source_key,'identity:'||i.owner_canonical_key,
        'observation:'||public.garage_sheet_hash(i.original_snapshot::text),
        'observation:'||public.garage_sheet_hash(i.latest_snapshot::text)]) keys(key)
      where i.order_id=p_order_id and keys.key is not null
    union
    select i.source_id,'identity:'||k from public.garage_manager_intake i
      cross join lateral unnest(i.owner_source_keys) k where i.order_id=p_order_id
    union
    select i.source_id,'observation:'||public.garage_sheet_hash((o.observation->'raw')::text)
      from public.garage_manager_intake i
      cross join lateral jsonb_array_elements(i.original_observations||i.observations) o(observation)
      where i.order_id=p_order_id and jsonb_typeof(o.observation->'raw')='object'
  ) identities
  on conflict do nothing;

  -- An importer can hold a lease between calls. Invalidate that lease before it
  -- can write its pre-deletion state or feedback back to the source cache.
  update public.garage_sheet_pull_feeds f set
    state=case when jsonb_typeof(f.state->'entries')='object' then jsonb_set(f.state,'{entries}',
      coalesce((select jsonb_object_agg(e.key,e.value) from jsonb_each(f.state->'entries') e
        where garage_board.removed_source_key(f.source_id,'identity:'||e.key) is not true
          and garage_board.removed_source_key(f.source_id,'external:'||(e.value->>'external_order_id')) is not true),'{}'::jsonb))
      else f.state end,
    review=coalesce((select jsonb_agg(r.value order by r.seq) from jsonb_array_elements(f.review) with ordinality r(value,seq)
      where garage_board.removed_source_key(f.source_id,'identity:'||(r.value->>'source_key')) is not true
        and not exists(select from public.garage_manager_intake i
          cross join lateral unnest(i.row_numbers) n
          where i.source_id=f.source_id and i.order_id=p_order_id and not i.source_missing
            and r.value->>'source_key' is null and r.value->>'row_number'=n::text)),'[]'::jsonb),
    state_version=f.state_version+1,lease_token=null,lease_expires_at=null
    where f.source_id=any(p_sources);
  delete from public.garage_sheet_submissions s using public.garage_sheet_orders l
    where l.order_id=p_order_id and s.source_id=l.source_id and s.external_order_id=l.external_order_id;
  delete from public.garage_sheet_task_versions s using public.garage_sheet_orders l
    where l.order_id=p_order_id and (s.source_id,s.external_order_id)=(l.source_id,l.external_order_id);
  delete from public.garage_sheet_tasks s using public.garage_sheet_orders l
    where l.order_id=p_order_id and (s.source_id,s.external_order_id)=(l.source_id,l.external_order_id);
  delete from public.garage_sheet_orders where order_id=p_order_id;
  delete from public.garage_sheet_feedback_outputs where order_id=p_order_id;
  delete from public.garage_manager_intake i where i.order_id=p_order_id
    or (i.source_id=any(p_sources) and i.order_id is null
      and (garage_board.removed_source_key(i.source_id,i.intake_key)
        or garage_board.removed_source_key(i.source_id,'identity:'||i.original_source_key)));
end $$;
revoke all on function garage_board.remove_sheet_order(uuid,uuid[]) from public,anon,authenticated,service_role;

-- Ledger transactions are independent business records. Remove the machine link
-- from saved records, revisions and retry responses without changing their values.
create function garage_ledger.clear_order_link(p_value jsonb,p_path text[],p_order_key text) returns jsonb
language sql immutable set search_path=pg_catalog as $$
  select case when p_value#>>p_path=p_order_key then p_value#-p_path else p_value end
$$;
create function garage_ledger.detach_removed_order(p_order_key text) returns void
language plpgsql set search_path=pg_catalog as $$
declare batches uuid[];
begin
  select array_agg(distinct s.import_id) into batches from garage_ledger.sheets s join garage_ledger.rows r on r.sheet_id=s.id
    where r.cells#>>'{C,origin_order}'=p_order_key or r.original_cells#>>'{C,origin_order}'=p_order_key
      or exists(select from garage_ledger.revisions h where h.row_id=r.id and
        (h.before_state#>>'{cells,C,origin_order}'=p_order_key or h.after_state#>>'{cells,C,origin_order}'=p_order_key));
  perform id from garage_ledger.imports where id=any(batches) order by id for update;
  update garage_ledger.rows set cells=garage_ledger.clear_order_link(cells,'{C,origin_order}',p_order_key),
    original_cells=garage_ledger.clear_order_link(original_cells,'{C,origin_order}',p_order_key),
    version=version+1,updated_at=clock_timestamp()
    where cells#>>'{C,origin_order}'=p_order_key or original_cells#>>'{C,origin_order}'=p_order_key;
  update garage_ledger.revisions set before_state=garage_ledger.clear_order_link(before_state,'{cells,C,origin_order}',p_order_key),
    after_state=garage_ledger.clear_order_link(after_state,'{cells,C,origin_order}',p_order_key)
    where before_state#>>'{cells,C,origin_order}'=p_order_key or after_state#>>'{cells,C,origin_order}'=p_order_key;
  update garage_ledger.requests set payload=garage_ledger.clear_order_link(payload,'{cells,C,origin_order}',p_order_key),
    response=garage_ledger.clear_order_link(
      garage_ledger.clear_order_link(response,'{row,cells,C,origin_order}',p_order_key),
      '{row,original_cells,C,origin_order}',p_order_key)
    where payload#>>'{cells,C,origin_order}'=p_order_key or response#>>'{row,cells,C,origin_order}'=p_order_key
      or response#>>'{row,original_cells,C,origin_order}'=p_order_key;
  update garage_ledger.imports set revision=revision+1 where id=any(batches);
end $$;
revoke all on function garage_ledger.clear_order_link(jsonb,text[],text),garage_ledger.detach_removed_order(text)
  from public,anon,authenticated,service_role;

create function garage_ledger.protect_order_link() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare order_key text:=new.cells#>>'{C,origin_order}';
begin
  if order_key is not null and (not pg_try_advisory_xact_lock(hashtextextended('garage-ledger-order:'||order_key,0))
    or exists(select from garage_board.removed_order_receipts where order_hash=public.garage_sheet_hash(order_key))) then
    raise exception using errcode='40001',message='The order is being deleted or has already been deleted.';
  end if;
  return new;
end $$;
revoke all on function garage_ledger.protect_order_link() from public,anon,authenticated,service_role;
create trigger garage_ledger_protect_order_link before insert or update of cells on garage_ledger.rows
  for each row execute function garage_ledger.protect_order_link();

-- The downloadable film file is stored as ordered byte ranges. Compact its
-- remaining ranges after removing a visit and serialize with film saves.
create function garage_pay.remove_order_film(p_order_id uuid) returns void
language plpgsql set search_path=pg_catalog as $$
begin
  if not exists(select from garage_pay.film_revisions where order_id=p_order_id) then return; end if;
  perform 1 from garage_pay.film_file for update;
  delete from garage_pay.film_revisions where order_id=p_order_id;
  with offsets as (
    select order_id,version,coalesce(sum(octet_length(bytes)) over (
      order by byte_start rows between unbounded preceding and 1 preceding),0) as start_at
    from garage_pay.film_revisions
  )
  update garage_pay.film_revisions r set byte_start=-1-offsets.start_at
    from offsets where (r.order_id,r.version)=(offsets.order_id,offsets.version) and r.byte_start<>offsets.start_at;
  update garage_pay.film_revisions set byte_start=-1-byte_start where byte_start<0;
  update garage_pay.film_file set size_bytes=(select coalesce(max(byte_end),0) from garage_pay.film_revisions);
end $$;
revoke all on function garage_pay.remove_order_film(uuid) from public,anon,authenticated,service_role;

create function garage_board.permanently_delete_order(p_order_id uuid,p_custom boolean,p_expected_version integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  actor uuid:=public.garage_lock_actor();
  order_key text:=case when p_custom then 'custom:' else 'standard:' end||p_order_id::text;
  order_fingerprint text:=public.garage_sheet_hash(order_key);
  request_fingerprint text:=public.garage_sheet_hash(actor::text||':'||p_request_id::text);
  prefix text:=case when p_custom then 'custom/' else '' end||p_order_id::text||'/';
  actual integer; previous garage_board.removed_order_receipts%rowtype;
  sources uuid[]; tasks uuid[]; intakes uuid[]; related jsonb; photos jsonb;
  standard public.garage_orders%rowtype;
  recipients uuid[];
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  if p_order_id is null or p_custom is null or p_expected_version is null or p_request_id is null then
    raise exception using errcode='22023',message='Invalid order deletion request.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,0));
  select * into previous from garage_board.removed_order_receipts r where r.request_hash=request_fingerprint;
  if found then
    if previous.order_hash=order_fingerprint and previous.order_version=p_expected_version then
      return jsonb_build_object('order_id',p_order_id);
    end if;
    raise exception using errcode='22023',message='This request ID was already used for another change.';
  end if;
  perform public.garage_begin_request(p_request_id,jsonb_build_object('operation','permanent_order_deletion'));
  perform pg_advisory_xact_lock(hashtextextended('garage-ledger-order:'||order_key,0));

  if p_custom then
    select version into actual from garage_custom.orders where id=p_order_id and owner_id=actor for update;
  else
    -- Imports lock source, then order, then tasks. Use the same order here.
    sources:=array(select i.source_id from public.garage_manager_intake i where i.order_id=p_order_id
      union select l.source_id from public.garage_sheet_orders l where l.order_id=p_order_id);
    perform id from public.garage_sheet_sources where id=any(sources) order by id for update;
    select * into standard from public.garage_orders where id=p_order_id for update;
    actual:=standard.version;
  end if;
  if actual is null then raise exception using errcode='42501',message='Order unavailable.'; end if;
  if actual is distinct from p_expected_version then raise exception using errcode='40001',message='The order changed.'; end if;

  if to_regclass('storage.objects') is not null then
    select jsonb_agg(stored.name order by stored.name) into photos from (select o.name from storage.objects o
      where o.bucket_id='garage-order-photos' and o.name like prefix||'%' order by o.name limit 100) stored;
    if photos is not null then
      insert into garage_board.order_photo_cleanup(order_id,custom) values(p_order_id,p_custom) on conflict do nothing;
      return jsonb_build_object('order_id',p_order_id,'photo_paths',photos);
    end if;
  end if;
  if not p_custom then
    begin
      tasks:=array(select id from public.garage_order_tasks where order_id=p_order_id order by id for update nowait);
    exception when lock_not_available then
      raise exception using errcode='40001',message='The order work is being updated.';
    end;
    intakes:=array(select id from public.garage_manager_intake where order_id=p_order_id);
    recipients:=array(select m.mechanic_id from public.garage_task_participants m where m.task_id=any(tasks) and m.departed_at is null
      union select v.holder_id from public.garage_vehicle_visits v where v.order_id=p_order_id);
    perform garage_board.remove_sheet_order(p_order_id,sources);
    delete from garage_act.documents where order_id=p_order_id;
    delete from garage_payroll.legacy_orders where id=p_order_id;
    delete from garage_payroll.revisions where order_id=p_order_id;
    delete from garage_pay.commercial_terms where order_id=p_order_id;
    perform garage_pay.remove_order_film(p_order_id);
    delete from garage_pay.revisions where task_id=any(tasks);
    delete from garage_pay.items where task_id=any(tasks);
    delete from garage_pay.task_pricing_revisions where task_id=any(tasks);
    delete from public.garage_task_financials where task_id=any(tasks);
    delete from public.garage_team_changes where task_id=any(tasks);
    delete from public.garage_task_events where order_id=p_order_id or task_id=any(tasks);
    delete from public.garage_task_completions where order_id=p_order_id or task_id=any(tasks);
    delete from garage_board.check_restore c using public.garage_task_participants m where m.task_id=any(tasks) and m.id=c.member_id;
    delete from public.garage_task_participants where task_id=any(tasks);
    delete from public.garage_order_tasks where order_id=p_order_id;
    delete from public.garage_vehicle_visits where order_id=p_order_id;
    delete from public.garage_vehicle_events where order_id=p_order_id;
    delete from public.garage_orders where id=p_order_id;

    -- Realtime refreshes owners and mechanics who could previously see the order.
    perform pg_advisory_xact_lock(1734439521,1836214051);
    insert into public.garage_board_updates as board(recipient_id)
    select p.id from public.profiles p where p.active and (p.role='admin'
      or (p.role='mechanic' and ((standard.source='manager' and standard.status='published') or p.id=any(recipients))))
    order by p.id on conflict(recipient_id) do update set revision=board.revision+1;
  else
    delete from garage_custom.orders where id=p_order_id;
  end if;

  related:=jsonb_build_object('ids',to_jsonb(array[p_order_id]||coalesce(tasks,array[]::uuid[])||coalesce(intakes,array[]::uuid[])));
  with removed as (
    delete from public.garage_requests r where
      jsonb_path_exists(r.payload,'$.** ? (@ == $ids[*])',related)
      or jsonb_path_exists(r.response,'$.** ? (@ == $ids[*])',related)
    returning actor_id,request_id
  )
  insert into garage_board.removed_order_requests(request_hash)
    select public.garage_sheet_hash(actor_id::text||':'||request_id::text) from removed on conflict do nothing;
  perform garage_ledger.detach_removed_order(order_key);
  delete from garage_board.order_photo_cleanup where order_id=p_order_id and custom=p_custom;
  insert into garage_board.removed_order_receipts(order_hash,request_hash,order_version) values(order_fingerprint,request_fingerprint,actual);
  return jsonb_build_object('order_id',p_order_id);
end $$;

-- Older clients still call garage_delete_order and retain order and payroll history.
create function public.garage_permanently_delete_order(p_order_id uuid,p_custom boolean,p_expected_version integer,p_request_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
  select garage_board.permanently_delete_order(p_order_id,p_custom,p_expected_version,p_request_id)
$$;
revoke all on function garage_board.permanently_delete_order(uuid,boolean,integer,uuid),
  public.garage_permanently_delete_order(uuid,boolean,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function garage_board.permanently_delete_order(uuid,boolean,integer,uuid),
  public.garage_permanently_delete_order(uuid,boolean,integer,uuid) to authenticated;

insert into public.garage_schema_migrations(version) values ('20261127112832');
notify pgrst,'reload schema';
commit;
