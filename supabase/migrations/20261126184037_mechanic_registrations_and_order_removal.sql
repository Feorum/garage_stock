begin;

alter table public.profiles
  add column registration_pending boolean not null default false,
  add column removed_at timestamptz,
  add check (not (registration_pending or removed_at is not null) or (role='mechanic' and not active)),
  add check (not registration_pending or removed_at is null);

alter policy "read own jobs or admin" on public.jobs using (
  public.garage_is_owner() or (mechanic_id=(select auth.uid()) and exists(
    select 1 from public.profiles p where p.id=(select auth.uid()) and p.active and p.role='mechanic'))
);

-- Only Auth's administrative API can set raw_app_meta_data at creation.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare pending boolean := coalesce(new.raw_app_meta_data->'garage_registration_pending'='true'::jsonb,false);
begin
  insert into public.profiles(id,name,active,registration_pending)
  values (new.id,coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),not pending,pending);
  return new;
end $$;

create or replace function garage_identity.mechanic_accounts() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then raise exception using errcode='42501', message='Owner access required.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'email',case when lower(u.email) not like '%@accounts.garage.invalid' then u.email end,
    'role',p.role,'active',p.active,'pending',p.registration_pending,'color',garage_board.mechanic_color(p.id)
  ) order by p.name collate pg_catalog."und-x-icu",p.id),'[]'::jsonb)
    from public.profiles p join auth.users u on u.id=p.id where p.role='mechanic' and p.removed_at is null);
end $$;

-- Bound anonymous use of the privileged account creation endpoint to a small hourly volume.
create table garage_identity.registration_limit (
  singleton boolean primary key default true check(singleton),
  hour_start timestamptz not null,
  attempts integer not null
);
alter table garage_identity.registration_limit enable row level security;
revoke all on garage_identity.registration_limit from public, anon, authenticated, service_role;
create function garage_identity.allow_registration() returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare current_hour timestamptz := date_trunc('hour',now()); allowed boolean;
begin
  insert into garage_identity.registration_limit as rate(hour_start,attempts) values(current_hour,1)
  on conflict (singleton) do update set hour_start=excluded.hour_start,
    attempts=case when rate.hour_start<excluded.hour_start then 1 else rate.attempts+1 end
  where rate.hour_start<excluded.hour_start or rate.attempts<30
  returning true into allowed;
  return coalesce(allowed,false);
end $$;
create function public.garage_allow_mechanic_registration() returns boolean
language sql security invoker set search_path=pg_catalog as $$select garage_identity.allow_registration()$$;
revoke all on function garage_identity.allow_registration(),public.garage_allow_mechanic_registration()
  from public,anon,authenticated,service_role;
grant execute on function garage_identity.allow_registration(),public.garage_allow_mechanic_registration() to service_role;

alter table public.garage_orders add column deleted_at timestamptz;
alter table garage_custom.orders add column deleted_at timestamptz;

create or replace function public.garage_protect_active_assignments() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if old.role='mechanic' and (not new.active or new.role<>'mechanic') and (
    exists(select 1 from public.garage_task_participants m join public.garage_order_tasks t on t.id=m.task_id
      join public.garage_orders o on o.id=t.order_id where m.mechanic_id=old.id and m.departed_at is null
        and m.status<>'confirmed' and t.status in ('pending','in_progress','blocked') and o.deleted_at is null)
  ) then
    raise exception 'Resolve this mechanic''s outstanding work before changing account access.';
  end if;
  return new;
end $$;

create function garage_identity.manage_mechanic(p_id uuid,p_action text) returns uuid
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_lock_actor(); target public.profiles%rowtype;
begin
  if not public.garage_is_owner() or p_id=actor then
    raise exception using errcode='42501',message='Owner access required.';
  end if;
  select * into target from public.profiles where id=p_id and role='mechanic' for update;
  if not found then raise exception using errcode='42501',message='Mechanic unavailable.'; end if;
  if p_action='approve' and target.registration_pending then
    update public.profiles set registration_pending=false,active=true where id=p_id;
  elsif (p_action='reject' and target.registration_pending) or (p_action='delete' and not target.registration_pending) then
    if target.removed_at is null then
      if exists(select 1 from public.garage_vehicle_visits v join public.garage_orders o on o.id=v.order_id
        where v.holder_id=p_id and v.state='active' and o.status='published' and o.deleted_at is null) then
        raise exception using errcode='55000',message='Return the active visit before removing the mechanic.';
      end if;
      update public.profiles set registration_pending=false,active=false,removed_at=now() where id=p_id;
      delete from garage_identity.profile_names where profile_id=p_id;
    end if;
  elsif not (p_action='approve' and target.active or p_action='reject' and target.removed_at is not null) or p_action is null then
    raise exception using errcode='42501',message='Registration unavailable.';
  end if;
  return p_id;
end $$;
create function public.garage_manage_mechanic(p_id uuid,p_action text) returns uuid
language sql security invoker set search_path=pg_catalog as $$select garage_identity.manage_mechanic(p_id,p_action)$$;
revoke all on function garage_identity.manage_mechanic(uuid,text),public.garage_manage_mechanic(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function garage_identity.manage_mechanic(uuid,text),public.garage_manage_mechanic(uuid,text) to authenticated;

create or replace function public.garage_can_view_order(p_order_id uuid) returns boolean
language sql security definer stable set search_path=pg_catalog as $$
  select exists (
    select 1 from public.garage_orders o join public.profiles p on p.id=auth.uid()
    where o.id=p_order_id and o.deleted_at is null and p.active and (
      p.role='admin' or (p.role='mechanic' and (
        (o.source='manager' and o.status='published')
        or exists(select from public.garage_vehicle_visits v where v.order_id=o.id and v.holder_id=p.id)
        or exists(select from public.garage_order_tasks t join public.garage_task_participants m on m.task_id=t.id
          where t.order_id=o.id and m.mechanic_id=p.id and m.departed_at is null)))));
$$;

create or replace function public.garage_can_view_task(p_task_id uuid) returns boolean
language sql security definer stable set search_path=pg_catalog as $$
  select exists(
    select 1 from public.garage_order_tasks t join public.garage_orders o on o.id=t.order_id
      join public.profiles p on p.id=auth.uid()
    where t.id=p_task_id and o.deleted_at is null and p.active and (
      p.role='admin' or public.garage_team_member(p_task_id)
      or (p.role='mechanic' and o.source='manager' and o.status='published')));
$$;

create or replace function public.garage_list_orders() returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
  select coalesce(jsonb_agg(o||jsonb_build_object('vehicle_workflow',public.garage_vehicle_view(o))||
    case when public.garage_is_owner() then jsonb_build_object('closed_at',parent.closed_at) else '{}'::jsonb end order by pos),'[]'::jsonb)
  from jsonb_array_elements(public.garage_list_orders_before_vehicle()) with ordinality listed(o,pos)
  join public.garage_orders parent on parent.id=(o->>'id')::uuid
  where parent.deleted_at is null
$$;

alter function public.garage_manager_intakes() rename to garage_manager_intakes_before_removal;
revoke all on function public.garage_manager_intakes_before_removal() from public,anon,authenticated,service_role;
create function public.garage_manager_intakes() returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
  select coalesce(jsonb_agg(intake order by pos),'[]'::jsonb)
    from jsonb_array_elements(public.garage_manager_intakes_before_removal()) with ordinality listed(intake,pos)
    where not exists(select 1 from public.garage_orders o
      where o.id=(intake->>'order_id')::uuid and o.deleted_at is not null)
$$;
revoke all on function public.garage_manager_intakes() from public,anon,authenticated,service_role;
grant execute on function public.garage_manager_intakes() to authenticated;

create or replace function garage_custom.read_orders(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  if p_order_id is null then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'vehicle',vehicle,'visit_date',visit_date,'status',status)
      order by visit_date desc, updated_at desc, id),'[]'::jsonb)
      into result from garage_custom.orders where owner_id=auth.uid() and deleted_at is null;
  else
    select (to_jsonb(o)-'owner_id'-'deleted_at') || '{"order_type":"custom","source":"owner"}'::jsonb into result
      from garage_custom.orders o where o.id=p_order_id and o.owner_id=auth.uid() and o.deleted_at is null;
    if result is null then raise exception using errcode='42501',message='Order unavailable.'; end if;
  end if;
  return result;
end $$;

create function garage_board.protect_deleted_order() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  if old.deleted_at is not null then
    -- Allow the spreadsheet's separate comment sync to ignore retired rows.
    if tg_table_name='garage_orders' and (to_jsonb(new)-'manager_comment'-'manager_comment_updated_at')
      =(to_jsonb(old)-'manager_comment'-'manager_comment_updated_at') then return null; end if;
    raise exception using errcode='40001',message='The order was deleted.';
  end if;
  return new;
end $$;
revoke all on function garage_board.protect_deleted_order() from public,anon,authenticated,service_role;
create trigger garage_protect_deleted_order before update on public.garage_orders
  for each row execute function garage_board.protect_deleted_order();
create trigger garage_protect_deleted_custom_order before update on garage_custom.orders
  for each row execute function garage_board.protect_deleted_order();

create or replace function garage_notes.check_order(p_order_id uuid,p_custom boolean) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
  if public.garage_is_owner() then
    if p_custom and exists(select from garage_custom.orders where id=p_order_id and owner_id=auth.uid() and deleted_at is null) then
      return;
    elsif not p_custom and public.garage_can_view_order(p_order_id) then
      return;
    end if;
  end if;
  raise exception using errcode='42501',message='Order unavailable.';
end $$;

create or replace function garage_photos.can_read_custom_photo(object_name text) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
  select public.garage_is_owner() and exists (
    select from garage_custom.orders where id=garage_photos.custom_order_id(object_name)
      and owner_id=auth.uid() and deleted_at is null)
$$;

create or replace function garage_photos.can_upload_custom_photo(object_name text) returns boolean
language plpgsql volatile security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then return false; end if;
  perform 1 from garage_custom.orders where id=garage_photos.custom_order_id(object_name)
    and owner_id=auth.uid() and status='open' and deleted_at is null for share;
  return found;
end $$;

-- Keep source links, work history, and already recorded amounts, while removing the
-- order from the work queue and invalidating edits opened on an earlier version.
create function garage_board.delete_order(p_order_id uuid,p_custom boolean,p_expected_version integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_lock_actor(); payload jsonb; receipt jsonb; actual integer; removed timestamptz;
begin
  if not public.garage_is_owner() or p_custom is null then
    raise exception using errcode='42501',message='Owner access required.';
  end if;
  payload:=jsonb_build_object('action','delete_order','order_id',p_order_id,'custom',p_custom,'version',p_expected_version);
  receipt:=public.garage_begin_request(p_request_id,payload);
  if receipt is not null then return receipt; end if;
  if p_custom then
    select version,deleted_at into actual,removed from garage_custom.orders where id=p_order_id and owner_id=actor for update;
  else
    select version,deleted_at into actual,removed from public.garage_orders where id=p_order_id for update;
  end if;
  if not found or removed is not null then raise exception using errcode='42501',message='Order unavailable.'; end if;
  if actual is distinct from p_expected_version then raise exception using errcode='40001',message='The order changed.'; end if;
  if p_custom then
    update garage_custom.orders set deleted_at=now(),version=version+1,updated_at=now() where id=p_order_id;
  else
    update public.garage_orders set deleted_at=now(),version=version+1 where id=p_order_id;
  end if;
  return public.garage_finish_request(p_request_id,payload,jsonb_build_object('order_id',p_order_id));
end $$;
create function public.garage_delete_order(p_order_id uuid,p_custom boolean,p_expected_version integer,p_request_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
  select garage_board.delete_order(p_order_id,p_custom,p_expected_version,p_request_id)
$$;
revoke all on function garage_board.delete_order(uuid,boolean,integer,uuid),public.garage_delete_order(uuid,boolean,integer,uuid)
  from public,anon,authenticated,service_role;
grant execute on function garage_board.delete_order(uuid,boolean,integer,uuid),public.garage_delete_order(uuid,boolean,integer,uuid)
  to authenticated;

insert into public.garage_schema_migrations(version) values ('20261126184037');
notify pgrst,'reload schema';
commit;
