begin;

-- Capture the actual pre-check membership. The inline check is an upsert, so
-- AFTER triggers see whether it created a participant or updated an assignment.
create table garage_board.check_restore (
  member_id bigint not null,
  checked_at timestamptz not null,
  member_before jsonb,
  initial_worker uuid,
  initial_started_at timestamptz,
  primary key(member_id, checked_at)
);
alter table garage_board.check_restore enable row level security;
revoke all on garage_board.check_restore from public,anon,authenticated,service_role;

create function garage_board.remember_confirmation() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare previous jsonb; initial_worker uuid; initial_start timestamptz;
begin
  if tg_op='UPDATE' then
    if old.status='confirmed' then return new; end if;
    previous:=jsonb_build_object('status',old.status,'started_at',old.started_at,'blocker_reason',old.blocker_reason);
  end if;
  -- Shared checkmarks may be removed in any order. Carry the original task
  -- anchor and start time forward for the last remaining contributor to restore.
  select s.initial_worker,s.initial_started_at into initial_worker,initial_start
    from public.garage_task_participants m join garage_board.check_restore s
      on (s.member_id,s.checked_at)=(m.id,m.confirmed_at)
    where m.task_id=new.task_id and m.departed_at is null and m.status='confirmed'
    order by m.confirmed_at,m.id limit 1;
  if not found then
    select t.working_mechanic_id,t.started_at into initial_worker,initial_start
      from public.garage_order_tasks t where t.id=new.task_id;
  end if;
  insert into garage_board.check_restore values(new.id,new.confirmed_at,previous,initial_worker,initial_start);
  return new;
end $$;
create trigger garage_remember_confirmation after insert or update of status on public.garage_task_participants
  for each row when (new.status='confirmed' and new.confirmation_origin='mechanic')
  execute function garage_board.remember_confirmation();

-- Historical, Owner-entered and legacy team completions have different origins.
-- A current personal inline mark has a matching check event at its exact instant.
create function garage_board.inline_credit(p_task_id uuid,p_actor uuid,p_at timestamptz) returns boolean
language sql stable strict set search_path=pg_catalog as $$
  select exists(select from public.garage_team_changes c join public.garage_task_events e on e.id=c.event_id
    where c.task_id=p_task_id and c.subject_mechanic_id=p_actor and c.action='check_work' and e.created_at=p_at)
$$;

-- Keep the existing, actor-filtered team projection and its ACL behind this private helper.
alter function public.garage_team_details(uuid) rename to team_before_uncheck;
alter function public.team_before_uncheck(uuid) set schema garage_board;
create function public.garage_team_details(p_task_id uuid) returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$
  select base.info||jsonb_build_object('can_uncheck_work',not public.garage_is_owner() and exists(
    select from public.garage_task_participants m join public.garage_order_tasks t on t.id=m.task_id
    where m.task_id=p_task_id and m.mechanic_id=auth.uid() and m.departed_at is null
      and m.status='confirmed' and m.confirmation_origin='mechanic' and t.status='completed'
      and garage_board.work_open(t.order_id) and garage_board.inline_credit(m.task_id,m.mechanic_id,m.confirmed_at)))
  from (select garage_board.team_before_uncheck(p_task_id) as info) base where base.info is not null
$$;

create or replace function public.garage_guard_vehicle_task() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare stage text;
begin
  if exists(select from public.profiles p where p.id=auth.uid() and p.active and p.role='mechanic') then
    select state into stage from public.garage_vehicle_visits where order_id=new.order_id;
    if stage is distinct from 'active' and not (stage is distinct from 'review' and exists(
      select from public.garage_team_changes c where c.task_id=new.id and c.version=new.version
        and c.subject_mechanic_id=auth.uid() and
          ((c.action='check_work' and new.status='completed') or (c.action='uncheck_work' and old.status='completed')))) then
      raise exception using errcode='40001',message='The vehicle is unavailable for this change.';
    end if;
  end if;
  return new;
end $$;

create function garage_board.uncheck_work(p_task_id uuid,p_expected_version integer,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_lock_actor(); parent public.garage_orders%rowtype; task public.garage_order_tasks%rowtype;
  member public.garage_task_participants%rowtype; saved garage_board.check_restore%rowtype;
  remaining public.garage_task_participants%rowtype; previous jsonb; anchor uuid; reason text;
  next_state text; started timestamptz; event_id_value bigint; result jsonb; payload jsonb;
begin
  if public.garage_is_owner() then raise exception using errcode='42501',message='Only a mechanic can withdraw a check.'; end if;
  payload:=jsonb_build_object('operation','uncheck_work','task_id',p_task_id,'version',p_expected_version);
  result:=public.garage_begin_request(p_request_id,payload);
  if result is not null then return result; end if;
  select * into parent from public.garage_orders where id=(select order_id from public.garage_order_tasks where id=p_task_id) for update;
  select * into task from public.garage_order_tasks where id=p_task_id for update;
  if task.id is null or not public.garage_can_view_task(task.id) then
    raise exception using errcode='42501',message='Work unavailable.'; end if;
  if task.version is distinct from p_expected_version or not garage_board.work_open(parent.id) then
    raise exception using errcode='40001',message='Review the updated work before changing a check.'; end if;
  select * into member from public.garage_task_participants where task_id=task.id and mechanic_id=actor and departed_at is null;
  if task.status<>'completed' or member.status is distinct from 'confirmed' or member.confirmation_origin is distinct from 'mechanic'
    or not garage_board.inline_credit(task.id,actor,member.confirmed_at) then
    raise exception using errcode='42501',message='Only your own current check can be withdrawn.'; end if;

  perform from garage_pay.items where task_id=task.id for update;
  select * into saved from garage_board.check_restore where (member_id,checked_at)=(member.id,member.confirmed_at);
  previous:=saved.member_before;
  if saved.member_id is null and (parent.source='owner' or member.joined_at<>member.confirmed_at) then
    -- Old inline checks already recorded whether the mechanic joined/started
    -- before checking. Keep that membership and any evidenced earlier start.
    previous:=case when member.started_at<member.confirmed_at then
      jsonb_build_object('status','working','started_at',member.started_at,'blocker_reason','')
      else jsonb_build_object('status','assigned','started_at',null,'blocker_reason','') end;
  end if;
  if previous is null then
    delete from public.garage_task_participants where id=member.id;
  else
    update public.garage_task_participants set status=previous->>'status',started_at=(previous->>'started_at')::timestamptz,
      blocker_reason=previous->>'blocker_reason',confirmed_at=null,confirmation_origin=null where id=member.id;
  end if;
  insert into public.garage_task_events(order_id,task_id,actor_id,action)
    values(parent.id,task.id,actor,'uncheck_work') returning id into event_id_value;
  insert into public.garage_team_changes(task_id,version,action,event_id,subject_mechanic_id)
    values(task.id,task.version+1,'uncheck_work',event_id_value,actor);

  select * into remaining from public.garage_task_participants where task_id=task.id and departed_at is null
    and status='confirmed' order by confirmed_at,id limit 1;
  if remaining.id is not null then
    update public.garage_task_completions set mechanic_id=remaining.mechanic_id,completed_at=remaining.confirmed_at
      where task_id=task.id and mechanic_id=actor;
    update public.garage_order_tasks t set version=t.version+1,
      working_mechanic_id=case when t.working_mechanic_id=actor then remaining.mechanic_id else t.working_mechanic_id end,
      completed_at=c.completed_at
      from public.garage_task_completions c where c.task_id=t.id and t.id=task.id returning t.* into strict task;
  else
    -- Only the live completion is withdrawn. Saved Owner allocations and all
    -- personal pricing/audit revisions stay attached to the catalogue task.
    delete from garage_pay.items where task_id=task.id and version=0;
    delete from public.garage_task_completions where task_id=task.id;
    select case when count(*)=0 or bool_and(status='assigned') then 'pending'
         when bool_and(status='blocked') then 'blocked' else 'in_progress' end,
      (array_agg(mechanic_id order by (status='assigned'),(mechanic_id=saved.initial_worker) desc nulls last,joined_at,id))[1],
      coalesce((array_agg(blocker_reason order by joined_at,id) filter(where status='blocked'))[1],''),
      min(started_at)
      into next_state,anchor,reason,started from public.garage_task_participants where task_id=task.id and departed_at is null;
    if saved.member_id is not null then started:=saved.initial_started_at;
    elsif not exists(select from public.garage_task_events e where e.task_id=task.id and e.action='check_work'
      and e.created_at=task.started_at) then started:=task.started_at; end if;
    update public.garage_order_tasks set version=version+1,status=next_state,completed_at=null,started_at=started,
      working_mechanic_id=case when next_state<>'pending' then anchor end,
      blocker_reason=case when next_state='blocked' then reason else '' end where id=task.id returning * into task;
  end if;
  update public.garage_orders set version=version+1 where id=parent.id;
  return public.garage_finish_request(p_request_id,payload,jsonb_build_object('task_id',task.id,
    'order_id',parent.id,'version',task.version,'status',task.status));
end $$;
create function public.garage_uncheck_work(p_task_id uuid,p_expected_version integer,p_request_id uuid) returns jsonb
language sql security invoker set search_path=pg_catalog as $$
  select garage_board.uncheck_work(p_task_id,p_expected_version,p_request_id)
$$;
revoke all on function garage_board.remember_confirmation(),garage_board.inline_credit(uuid,uuid,timestamptz),
  garage_board.uncheck_work(uuid,integer,uuid),public.garage_uncheck_work(uuid,integer,uuid),
  public.garage_team_details(uuid) from public,anon,authenticated,service_role;
grant execute on function garage_board.uncheck_work(uuid,integer,uuid),public.garage_uncheck_work(uuid,integer,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values('20261120155825');
notify pgrst,'reload schema';
commit;
