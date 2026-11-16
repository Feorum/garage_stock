-- Manager comments remain independent of approved work and Owner instructions.
begin;
alter table public.garage_orders add column manager_comment text not null default '' check (length(manager_comment)<=4000);
alter table public.garage_orders add column manager_comment_updated_at timestamptz;

create function public.garage_sheet_require_lease(p_source_id uuid,p_lease_token uuid,p_expected_version integer) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare source public.garage_sheet_sources%rowtype; feed public.garage_sheet_pull_feeds%rowtype;
begin
  select * into source from public.garage_sheet_sources where id=p_source_id for update;
  if not found or not source.active then raise exception using errcode='42501',message='Source unavailable.'; end if;
  perform 1 from public.profiles where id=source.owner_id and active and role='admin' for share;
  if not found then raise exception using errcode='42501',message='Source unavailable.'; end if;
  select * into feed from public.garage_sheet_pull_feeds where source_id=p_source_id for update;
  if not found or p_lease_token is null or feed.lease_token is null or feed.lease_expires_at is null
    or feed.lease_token is distinct from p_lease_token or feed.state_version is distinct from p_expected_version
    or feed.lease_expires_at<=clock_timestamp() then
    raise exception using errcode='40001',message='The importer lease changed.';
  end if;
end $$;

create function public.garage_sheet_order_keys(p_source_id uuid) returns table(order_id uuid,source_key text)
language sql stable security definer set search_path=pg_catalog,public as $$
  with candidates as (
    select i.order_id,k as source_key from public.garage_manager_intake i
      cross join lateral unnest(i.owner_source_keys||array[i.original_source_key,i.owner_canonical_key]) k
      where i.source_id=p_source_id and i.order_id is not null
    union
    select so.order_id,e.key from public.garage_sheet_pull_feeds f
      cross join lateral jsonb_each(coalesce(f.state->'entries','{}')) e
      join public.garage_sheet_orders so on so.source_id=f.source_id and so.external_order_id::text=e.value->>'external_order_id'
      where f.source_id=p_source_id
    union
    select so.order_id,o.planned_date::text||'|'||upper(btrim(o.vin)) from public.garage_sheet_orders so
      join public.garage_orders o on o.id=so.order_id where so.source_id=p_source_id
  ), unique_keys as (
    select source_key from candidates where source_key ~ '^\d{4}-\d{2}-\d{2}\|[A-HJ-NPR-Z0-9]{17}$'
    group by source_key having count(distinct order_id)=1
  ) select distinct c.order_id,c.source_key from candidates c join unique_keys u using(source_key)
$$;

create function public.garage_sync_manager_comments(
  p_source_id uuid,p_lease_token uuid,p_expected_version integer,p_comments jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare item jsonb; changed integer:=0; withheld integer:=0; selected record;
begin
  perform public.garage_sheet_require_lease(p_source_id,p_lease_token,p_expected_version);
  if p_comments is null or jsonb_typeof(p_comments)<>'array' or jsonb_array_length(p_comments)>5000
    or octet_length(p_comments::text)>12582912 then raise exception 'Invalid Manager comments.'; end if;
  for item in select value from jsonb_array_elements(p_comments) loop
    if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) k where k not in('source_key','comment'))
      or jsonb_typeof(item->'source_key') is distinct from 'string'
      or item->>'source_key' !~ '^\d{4}-\d{2}-\d{2}\|[A-HJ-NPR-Z0-9]{17}$'
      or jsonb_typeof(item->'comment') is distinct from 'string' or length(item->>'comment')>4000 then
      raise exception 'Invalid Manager comment.';
    end if;
  end loop;
  select count(*) into withheld from jsonb_array_elements(p_comments) c where public.garage_private_note(c->>'comment');
  for selected in
    select k.order_id,min(c->>'comment') as comment from jsonb_array_elements(p_comments) c
      join public.garage_sheet_order_keys(p_source_id) k on k.source_key=c->>'source_key'
      group by k.order_id having count(distinct c->>'comment')=1 and not bool_or(public.garage_private_note(c->>'comment'))
  loop
    update public.garage_orders set manager_comment=selected.comment,manager_comment_updated_at=clock_timestamp()
      where id=selected.order_id and manager_comment is distinct from selected.comment;
    if found then changed:=changed+1; end if;
  end loop;
  return jsonb_build_object('version',p_expected_version,'updated',changed,'withheld',withheld);
end $$;

-- Extend the existing permission-filtered list without duplicating its policy.
alter function public.garage_list_orders() rename to garage_list_orders_before_comments;
create function public.garage_list_orders() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform public.garage_require_actor();
  return coalesce((select jsonb_agg(item.value||jsonb_build_object('manager_comment',o.manager_comment,
    'manager_comment_updated_at',o.manager_comment_updated_at,'instructions_from_manager',
    not exists(select 1 from public.garage_manager_intake i where i.order_id=o.id and i.owner_managed)
      and exists(select 1 from public.garage_sheet_orders so join lateral (
        select s.scope_snapshot from public.garage_sheet_submissions s where s.source_id=so.source_id
          and s.external_order_id=so.external_order_id and s.status='accepted' order by s.revision desc,s.created_at desc limit 1
        ) accepted on true where so.order_id=o.id and accepted.scope_snapshot#>>'{order,instructions}'=o.instructions)
    ) order by item.ordinality)
    from jsonb_array_elements(public.garage_list_orders_before_comments()) with ordinality item(value,ordinality)
    join public.garage_orders o on o.id=(item.value->>'id')::uuid),'[]'::jsonb);
end $$;

revoke all on function public.garage_sheet_require_lease(uuid,uuid,integer),public.garage_sheet_order_keys(uuid),
  public.garage_sync_manager_comments(uuid,uuid,integer,jsonb),public.garage_list_orders_before_comments(),public.garage_list_orders()
  from public,anon,authenticated,service_role;
grant execute on function public.garage_sync_manager_comments(uuid,uuid,integer,jsonb) to service_role;
grant execute on function public.garage_list_orders() to authenticated;
insert into public.garage_schema_migrations(version) values('20261116203155');
notify pgrst,'reload schema';
commit;
