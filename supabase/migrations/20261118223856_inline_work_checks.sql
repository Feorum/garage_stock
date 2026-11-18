-- Personal checkmarks share one completed service. Existing clients retain their custody and roster APIs.
begin;
create schema garage_board;
revoke all on schema garage_board from public,anon,authenticated,service_role;

-- Only an opaque revision is delivered by Realtime. Clients re-read their own filtered work list.
create table public.garage_board_updates (
  recipient_id uuid primary key references public.profiles(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0)
);
alter table public.garage_board_updates enable row level security;
revoke all on public.garage_board_updates from public,anon,authenticated,service_role;
grant select on public.garage_board_updates to authenticated;
create policy garage_own_board_updates on public.garage_board_updates for select to authenticated using (
  recipient_id=(select auth.uid()) and exists(select from public.profiles p
    where p.id=(select auth.uid()) and p.active and p.role in ('admin','mechanic'))
);
do $$
begin
  if exists(select from pg_publication where pubname='supabase_realtime' and not puballtables) then
    alter publication supabase_realtime add table public.garage_board_updates;
  end if;
end $$;

-- A deferred notification runs after the business mutations have finished. Different
-- private orders can share recipients: serialize this short flush to avoid locking their
-- revision rows in competing orders across multiple assignment and order triggers.
create function garage_board.notify_change() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare order_key uuid; source_kind text; was_shared boolean; changed_member uuid;
begin
  if tg_table_name='garage_task_participants' then
    select o.id,o.source into order_key,source_kind
    from public.garage_order_tasks t join public.garage_orders o on o.id=t.order_id where t.id=new.task_id;
    if source_kind is distinct from 'owner' then return null; end if;
    changed_member:=new.mechanic_id;
  else
    order_key:=new.id;
    was_shared:=new.source='manager' and new.status='published';
    if tg_op='UPDATE' then was_shared:=was_shared or (old.source='manager' and old.status='published'); end if;
  end if;
  perform pg_advisory_xact_lock(1734439521,1836214051);
  insert into public.garage_board_updates as board(recipient_id)
  select p.id from public.profiles p where p.active and (
    (changed_member is null and p.role='admin') or
    (p.role='mechanic' and (
      changed_member=p.id or (changed_member is null and (was_shared or
        exists(select from public.garage_order_tasks t join public.garage_task_participants m on m.task_id=t.id
          where t.order_id=order_key and m.mechanic_id=p.id and m.departed_at is null) or
        exists(select from public.garage_vehicle_visits v where v.order_id=order_key and v.holder_id=p.id))))))
  order by p.id on conflict(recipient_id) do update set revision=board.revision+1;
  return null;
end $$;
create constraint trigger garage_board_order_change after insert or update on public.garage_orders
deferrable initially deferred for each row execute function garage_board.notify_change();
create constraint trigger garage_board_private_assignment after insert on public.garage_task_participants
deferrable initially deferred for each row execute function garage_board.notify_change();
create constraint trigger garage_board_private_departure after update of departed_at on public.garage_task_participants
deferrable initially deferred for each row when (old.departed_at is distinct from new.departed_at)
execute function garage_board.notify_change();

-- Display metadata is never an authorization input. The fallback spreads UUIDs around
-- a 360-degree color wheel, including for sequential IDs, and matches ExecutorMarker.
create function garage_board.default_color(p_id uuid) returns text
language sql immutable strict set search_path=pg_catalog as $$
  with angle as (
    select (((('x'||left(p_id::text,8))::bit(32)::bigint # ('x'||right(p_id::text,8))::bit(32)::bigint)
      %360)*137%360)::integer as hue
  ), ramp as (
    select hue/60 as sector,round(106*(hue%60)/60.0)::integer as step from angle
  ), channels as (
    select case sector when 0 then array[226,120+step,120] when 1 then array[226-step,226,120]
      when 2 then array[120,226,120+step] when 3 then array[120,226-step,226]
      when 4 then array[120+step,120,226] else array[226,120,226-step] end as rgb from ramp
  )
  select '#'||to_hex(rgb[1])||to_hex(rgb[2])||to_hex(rgb[3]) from channels
$$;
create function garage_board.mechanic_color(p_mechanic_id uuid) returns text
language sql stable set search_path=pg_catalog as $$
  select case c.color when 'red' then '#ff939d' when 'blue' then '#8ac4ff' when 'yellow' then '#f1c75c'
    else case when c.color ~ '^#[0-9a-f]{6}$' then c.color else garage_board.default_color(p_mechanic_id) end end
  from (select (select lower(u.raw_app_meta_data->>'mechanic_color')
    from auth.users u where u.id=p_mechanic_id) as color) c
$$;

-- Preserve visibility from the existing order listing. Check eligibility always uses the
-- task, including assignment membership for private Owner work, never just the order ID.
create function garage_board.work_open(p_order_id uuid) returns boolean
language sql stable set search_path=pg_catalog as $$
  select exists(select from public.garage_orders o where o.id=p_order_id and o.status='published'
    and not exists(select from public.garage_vehicle_visits v where v.order_id=o.id and v.state='review'))
$$;
create function garage_board.can_submit(p_order_id uuid) returns boolean
language sql stable set search_path=pg_catalog as $$
  select garage_board.work_open(p_order_id) and exists(
    select from public.garage_order_tasks t join public.garage_task_participants m on m.task_id=t.id
    join public.profiles p on p.id=m.mechanic_id
    where t.order_id=p_order_id and t.status<>'cancelled' and p.active and p.role='mechanic'
      and m.mechanic_id=auth.uid() and m.status='confirmed' and m.departed_at is null)
$$;
alter function public.garage_team_details(uuid) set schema garage_board;
create function public.garage_team_details(p_task_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
  with details as materialized (
    select t.order_id,t.status,garage_board.garage_team_details(t.id) as info
    from public.garage_order_tasks t where t.id=p_task_id
  )
  select details.info || jsonb_build_object(
    'can_check_work',not public.garage_is_owner() and garage_board.work_open(details.order_id) and details.status<>'cancelled'
      and (details.info->>'my_status') is distinct from 'confirmed',
    'participants',coalesce((select jsonb_agg(person||jsonb_build_object(
      'color',garage_board.mechanic_color((person->>'mechanic_id')::uuid)) order by pos)
      from jsonb_array_elements(details.info->'participants') with ordinality members(person,pos)),'[]'::jsonb))
  from details where details.info is not null
$$;

-- The legacy UI continues to see a submitter in its review-holder field, but a return
-- of a checklist visit reopens the shared board without reserving it for that person.
alter table public.garage_vehicle_visits drop constraint garage_vehicle_visits_origin_check;
alter table public.garage_vehicle_visits add constraint garage_vehicle_visits_origin_check
  check (origin in ('explicit','existing_work','inline'));
create function garage_board.has_check(p_order_id uuid) returns boolean
language sql stable set search_path=pg_catalog as $$
  select exists(select from public.garage_order_tasks t join public.garage_team_changes c on c.task_id=t.id
    where t.order_id=p_order_id and c.action='check_work')
$$;
alter function public.garage_vehicle_view(jsonb) set schema garage_board;
create function public.garage_vehicle_view(p_order jsonb) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
  with old as materialized (select garage_board.garage_vehicle_view(p_order) as info)
  select old.info||jsonb_build_object('can_submit',garage_board.can_submit(o.id),
    'handed_by',case when public.garage_is_owner() or v.handed_by=auth.uid() then v.handed_by end,
    'return_note',case when v.origin='inline' and v.handed_by=auth.uid() then v.return_note else old.info->>'return_note' end,
    'can_close',(old.info->>'can_close')::boolean and (v.state='review' or not garage_board.has_check(o.id)) is true)
  from public.garage_orders o left join public.garage_vehicle_visits v on v.order_id=o.id
    cross join old
  where o.id=(p_order->>'id')::uuid
$$;

create or replace function public.garage_require_vehicle_handoff() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare stage text;
begin
  if old.status='published' and new.status='closed' then
    select state into stage from public.garage_vehicle_visits where order_id=new.id;
    if stage='active' or (stage is distinct from 'review' and garage_board.has_check(new.id)) then
      raise exception using errcode='40001',message='Submit the visit for review before closing it.';
    end if;
  end if;
  return new;
end $$;

-- Only this server-recorded operation may change a task without an active reservation.
-- The actor, task and next version must match the private audit row in this transaction.
create or replace function public.garage_guard_vehicle_task() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare stage text;
begin
  if exists(select from public.profiles p where p.id=auth.uid() and p.active and p.role='mechanic') then
    select state into stage from public.garage_vehicle_visits where order_id=new.order_id;
    if stage is distinct from 'active' and not (
      stage is distinct from 'review' and new.status='completed' and exists(
        select from public.garage_team_changes c where c.task_id=new.id and c.version=new.version
          and c.subject_mechanic_id=auth.uid() and c.action='check_work')) then
      raise exception using errcode='40001',message='The vehicle is unavailable for this change.';
    end if;
  end if;
  return new;
end $$;

create function garage_board.check_work(p_task_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_lock_actor(); task public.garage_order_tasks%rowtype; parent public.garage_orders%rowtype;
  member public.garage_task_participants%rowtype; occurred timestamptz; event_id_value bigint;
  payload jsonb:=jsonb_build_object('operation','check_work','task_id',p_task_id); result jsonb;
begin
  if public.garage_is_owner() then raise exception using errcode='42501',message='Only a mechanic can check work.'; end if;
  result:=public.garage_begin_request(p_request_id,payload);
  if result is not null then return result; end if;
  select * into parent from public.garage_orders where id=(select order_id from public.garage_order_tasks where id=p_task_id) for update;
  select * into task from public.garage_order_tasks where id=p_task_id for update;
  if task.id is null or not public.garage_can_view_task(task.id) then
    raise exception using errcode='42501',message='Work unavailable.'; end if;
  if not garage_board.work_open(parent.id) or task.status='cancelled' then
    raise exception using errcode='40001',message='This work is no longer open for checks.'; end if;
  select * into member from public.garage_task_participants where task_id=task.id and mechanic_id=actor and departed_at is null;
  if member.status is distinct from 'confirmed' then
    if task.status='completed' then
      -- A simultaneous Owner allocation must see a single, consistent participant set.
      perform from garage_pay.items where task_id=task.id for update;
    end if;
    occurred:=clock_timestamp();
    insert into public.garage_task_participants(task_id,mechanic_id,status,joined_at,started_at,confirmed_at,confirmation_origin)
      values(task.id,actor,'confirmed',occurred,occurred,occurred,'mechanic')
      on conflict(task_id,mechanic_id) where departed_at is null do update set
        status='confirmed',started_at=coalesce(garage_task_participants.started_at,excluded.started_at),
        confirmed_at=excluded.confirmed_at,confirmation_origin='mechanic',blocker_reason='';
    insert into public.garage_task_events(order_id,task_id,actor_id,action,created_at)
      values(parent.id,task.id,actor,'check_work',occurred) returning id into event_id_value;
    insert into public.garage_team_changes(task_id,version,action,event_id,subject_mechanic_id)
      values(task.id,task.version+1,'check_work',event_id_value,actor);
    update public.garage_order_tasks set status='completed',version=version+1,started_at=coalesce(started_at,occurred),
      completed_at=coalesce(completed_at,occurred),blocker_reason='',
      working_mechanic_id=case when status='completed' then working_mechanic_id else actor end
      where id=task.id returning * into task;
    -- The unique completion is the only source of a pay item. Later credit touches neither that row nor a saved division.
    insert into public.garage_task_completions(task_id,order_id,mechanic_id,work_code,work_name,completed_at)
      values(task.id,parent.id,actor,task.work_code,task.work_name,task.completed_at) on conflict(task_id) do nothing;
    update public.garage_orders set version=version+1 where id=parent.id;
  end if;
  return public.garage_finish_request(p_request_id,payload,jsonb_build_object('task_id',task.id,
    'order_id',parent.id,'version',task.version,'status',task.status));
end $$;

create function garage_board.submit_work(p_order_id uuid,p_expected_version integer,p_request_id uuid,p_note text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_lock_actor(); parent public.garage_orders%rowtype;
  reason text:=btrim(coalesce(p_note,'')); occurred timestamptz; snapshot jsonb; payload jsonb; result jsonb;
begin
  if public.garage_is_owner() then raise exception using errcode='42501',message='Only a mechanic can submit work.'; end if;
  payload:=jsonb_build_object('operation','submit_work','order_id',p_order_id,'version',p_expected_version,'note',p_note);
  result:=public.garage_begin_request(p_request_id,payload);
  if result is not null then return result; end if;
  if length(coalesce(p_note,''))>2000 or public.garage_private_note(reason) then raise exception 'Use an operational note without financial information.'; end if;
  select * into parent from public.garage_orders where id=p_order_id for update;
  if parent.id is null or not public.garage_can_view_order(parent.id) then
    raise exception using errcode='42501',message='Visit unavailable.'; end if;
  if parent.version is distinct from p_expected_version or not garage_board.work_open(parent.id) then
    raise exception using errcode='40001',message='The visit changed. Review the updated checklist before submitting.'; end if;
  if not garage_board.can_submit(parent.id) then raise exception using errcode='42501',message='Only a contributing mechanic can submit this visit.'; end if;
  occurred:=clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'work_code',t.work_code,'work_name',t.work_name,'options',t.options,
    'status',t.status,'completed_at',t.completed_at,'visible_to_holder',public.garage_can_view_task(t.id),
    'participants',coalesce((select jsonb_agg(jsonb_build_object('mechanic_id',p.id,'name',p.name,'status','confirmed',
       'color',garage_board.mechanic_color(p.id),'confirmed_at',m.confirmed_at) order by m.confirmed_at,m.id)
       from public.garage_task_participants m join public.profiles p on p.id=m.mechanic_id
       where m.task_id=t.id and m.status='confirmed' and m.departed_at is null),'[]'::jsonb)) order by t.created_at,t.id),'[]'::jsonb)
    into snapshot from public.garage_order_tasks t where t.order_id=parent.id;
  insert into public.garage_vehicle_visits(order_id,state,holder_id,origin,handed_at,handed_by,handoff_note,handoff_tasks)
    values(parent.id,'review',actor,'inline',occurred,actor,reason,snapshot)
    on conflict(order_id) do update set state='review',holder_id=actor,origin='inline',taken_at=null,
      handed_at=occurred,handed_by=actor,handoff_note=reason,handoff_tasks=snapshot,returned_at=null,return_note='';
  insert into public.garage_vehicle_events(order_id,actor_id,holder_id,action,note,task_snapshot,created_at)
    values(parent.id,actor,actor,'handoff',reason,snapshot,occurred);
  update public.garage_orders set version=version+1 where id=parent.id returning version into parent.version;
  return public.garage_finish_request(p_request_id,payload,jsonb_build_object('order_id',parent.id,'state','review','version',parent.version));
end $$;

alter function public.garage_vehicle_action(uuid,text,integer,uuid,text) set schema garage_board;
create function garage_board.vehicle_action(p_order_id uuid,p_action text,p_expected_version integer,p_request_id uuid,p_note text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid; parent public.garage_orders%rowtype; visit public.garage_vehicle_visits%rowtype;
  reason text:=btrim(coalesce(p_note,'')); payload jsonb; result jsonb; occurred timestamptz;
begin
  if p_action is distinct from 'return' then
    return garage_board.garage_vehicle_action(p_order_id,p_action,p_expected_version,p_request_id,p_note);
  end if;
  actor:=public.garage_lock_actor();
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only the Owner can return a visit.'; end if;
  payload:=jsonb_build_object('operation','vehicle','order_id',p_order_id,'action',p_action,'version',p_expected_version,'note',p_note);
  result:=public.garage_begin_request(p_request_id,payload);
  if result is not null then return result; end if;
  select * into parent from public.garage_orders where id=p_order_id for update;
  select * into visit from public.garage_vehicle_visits where order_id=p_order_id;
  if visit.origin is distinct from 'inline' then
    return garage_board.garage_vehicle_action(p_order_id,p_action,p_expected_version,p_request_id,p_note);
  end if;
  if parent.status<>'published' or parent.version is distinct from p_expected_version or visit.state<>'review' then
    raise exception using errcode='40001',message='This visit is no longer awaiting this review.'; end if;
  if length(coalesce(p_note,''))>2000 or public.garage_private_note(reason) then raise exception 'Use an operational note without financial information.'; end if;
  occurred:=clock_timestamp();
  update public.garage_vehicle_visits set state='available',holder_id=null,returned_at=occurred,return_note=reason where order_id=parent.id;
  insert into public.garage_vehicle_events(order_id,actor_id,holder_id,action,note,created_at)
    values(parent.id,actor,visit.handed_by,'return',reason,occurred);
  update public.garage_orders set version=version+1 where id=parent.id returning version into parent.version;
  return public.garage_finish_request(p_request_id,payload,jsonb_build_object('order_id',parent.id,'state','available','version',parent.version));
end $$;

-- Add the original close timestamp to the Owner's projection for reporting by calendar month.
create or replace function public.garage_list_orders() returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
  select coalesce(jsonb_agg(o||jsonb_build_object('vehicle_workflow',public.garage_vehicle_view(o))||
    case when public.garage_is_owner() then jsonb_build_object('closed_at',parent.closed_at) else '{}'::jsonb end order by pos),'[]'::jsonb)
  from jsonb_array_elements(public.garage_list_orders_before_vehicle()) with ordinality listed(o,pos)
  join public.garage_orders parent on parent.id=(o->>'id')::uuid
$$;
create function public.garage_check_work(p_task_id uuid,p_request_id uuid) returns jsonb
language sql security invoker set search_path=pg_catalog as $$select garage_board.check_work(p_task_id,p_request_id)$$;
create function public.garage_submit_work(p_order_id uuid,p_expected_version integer,p_request_id uuid,p_note text default '') returns jsonb
language sql security invoker set search_path=pg_catalog as $$select garage_board.submit_work(p_order_id,p_expected_version,p_request_id,p_note)$$;
create function public.garage_vehicle_action(p_order_id uuid,p_action text,p_expected_version integer,p_request_id uuid,p_note text default '') returns jsonb
language sql security invoker set search_path=pg_catalog as $$select garage_board.vehicle_action(p_order_id,p_action,p_expected_version,p_request_id,p_note)$$;
revoke all on all functions in schema garage_board from public,anon,authenticated,service_role;
grant usage on schema garage_board to authenticated;
grant execute on function garage_board.check_work(uuid,uuid),garage_board.submit_work(uuid,integer,uuid,text),
  garage_board.vehicle_action(uuid,text,integer,uuid,text) to authenticated;
revoke all on function public.garage_team_details(uuid),public.garage_vehicle_view(jsonb),
  public.garage_check_work(uuid,uuid),public.garage_submit_work(uuid,integer,uuid,text),
  public.garage_vehicle_action(uuid,text,integer,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.garage_check_work(uuid,uuid),public.garage_submit_work(uuid,integer,uuid,text),
  public.garage_vehicle_action(uuid,text,integer,uuid,text) to authenticated;
insert into public.garage_schema_migrations(version) values('20261118223856');
notify pgrst,'reload schema';
commit;
