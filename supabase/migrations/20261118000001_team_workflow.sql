-- One catalogue work, completion and commercial snapshot; several actual contributors.
begin;
create table public.garage_task_participants (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.garage_order_tasks(id),
  mechanic_id uuid not null references public.profiles(id),
  status text not null check (status in ('assigned','working','blocked','confirmed')),
  joined_at timestamptz not null default now(),
  started_at timestamptz,
  confirmed_at timestamptz,
  confirmation_origin text check (confirmation_origin in ('mechanic','owner_recorded','historical')),
  departed_at timestamptz,
  blocker_reason text not null default '',
  check ((status='confirmed') = (confirmed_at is not null)),
  check ((confirmed_at is null) = (confirmation_origin is null)),
  -- A cached single-worker transfer can inherit a working/blocked state before the
  -- recipient personally acts. Only an evidenced start qualifies a former helper.
  check (status<>'confirmed' or started_at is not null)
);
create unique index garage_current_task_member on public.garage_task_participants(task_id,mechanic_id) where departed_at is null;
create index garage_task_note_history on public.garage_task_events(task_id,created_at,id) where task_id is not null and note<>'';
create index garage_member_work on public.garage_task_participants(mechanic_id,task_id) where departed_at is null;
-- An optimistic mutation may commute only with a complete uninterrupted run of the same safe operation.
create table public.garage_team_changes (
  task_id uuid not null references public.garage_order_tasks(id),
  version integer not null,
  action text not null,
  event_id bigint not null references public.garage_task_events(id),
  subject_mechanic_id uuid references public.profiles(id),
  replacement_mechanic_id uuid references public.profiles(id),
  primary key (task_id,version)
);
alter table public.garage_task_participants enable row level security;
alter table public.garage_team_changes enable row level security;
revoke all on public.garage_task_participants,public.garage_team_changes from public,anon,authenticated,service_role;
revoke all on sequence public.garage_task_participants_id_seq from public,anon,authenticated,service_role;

-- Migrate only a documented assignment, worker or actual completion. Old job logs stay intact.
insert into public.garage_task_participants(task_id,mechanic_id,status,joined_at,started_at,confirmed_at,confirmation_origin,blocker_reason)
select t.id,coalesce(c.mechanic_id,t.working_mechanic_id,t.assigned_to),
  case when c.task_id is not null then 'confirmed' when t.status='blocked' then 'blocked'
       when t.working_mechanic_id is not null then 'working' else 'assigned' end,
  coalesce(t.started_at,c.completed_at,t.created_at),
  coalesce((select min(e.created_at) from public.garage_task_events e
    where e.task_id=t.id and e.actor_id=coalesce(c.mechanic_id,t.working_mechanic_id)
      and e.action in ('start','block','resume','complete')),c.completed_at),
  c.completed_at,case when c.task_id is not null then case when exists(
    select 1 from public.garage_task_events e where e.task_id=t.id and e.action='record_omitted_completion')
    then 'owner_recorded' else 'historical' end end,t.blocker_reason
from public.garage_order_tasks t left join public.garage_task_completions c on c.task_id=t.id
where coalesce(c.mechanic_id,t.working_mechanic_id,t.assigned_to) is not null;

-- Existing order/import/omitted-work functions retain their single-person signatures.
-- A normal team transition changes membership first, then updates the compatibility columns.
create function public.garage_seed_task_member() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare candidate uuid;
begin
  if tg_op='UPDATE' then
    if new.assigned_to is not distinct from old.assigned_to then return new; end if;
    if exists(select 1 from public.garage_task_participants where task_id=new.id and mechanic_id=new.assigned_to and departed_at is null) then
      return new;
    end if;
    if old.status<>'pending' or (select count(*) from public.garage_task_participants where task_id=new.id and departed_at is null)>1 then
      raise exception using errcode='40001',message='Use the team roster to change this assignment.';
    end if;
    update public.garage_task_participants set departed_at=clock_timestamp()
      where task_id=new.id and mechanic_id=old.assigned_to and departed_at is null;
  end if;
  candidate:=coalesce(new.working_mechanic_id,new.assigned_to);
  if candidate is not null then
    insert into public.garage_task_participants(task_id,mechanic_id,status,started_at,confirmed_at,confirmation_origin,blocker_reason)
    values(new.id,candidate,case new.status when 'completed' then 'confirmed' when 'in_progress' then 'working'
      when 'blocked' then 'blocked' else 'assigned' end,
      case when new.status in ('in_progress','blocked','completed') then coalesce(new.started_at,new.completed_at,now()) end,
      new.completed_at,case when new.status='completed' then 'owner_recorded' end,new.blocker_reason);
  end if;
  return new;
end $$;
create trigger garage_seed_task_member after insert or update of assigned_to on public.garage_order_tasks
for each row execute function public.garage_seed_task_member();

create function public.garage_team_member(p_task_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.garage_task_participants m join public.profiles p on p.id=m.mechanic_id
    where m.task_id=p_task_id and m.mechanic_id=auth.uid() and m.departed_at is null and p.active and p.role='mechanic');
$$;
create or replace function public.garage_can_view_task(p_task_id uuid) returns boolean
language sql security definer stable set search_path=pg_catalog,public as $$
  select public.garage_is_owner() or public.garage_team_member(p_task_id) or exists (
    select 1 from public.profiles p join public.garage_order_tasks t on t.id=p_task_id
      join public.garage_orders o on o.id=t.order_id
    where p.id=auth.uid() and p.active and p.role='mechanic' and o.source='manager' and o.status='published');
$$;
create or replace function public.garage_can_view_order(p_order_id uuid) returns boolean
language sql security definer stable set search_path=pg_catalog,public as $$
  select public.garage_is_owner() or exists(
    select 1 from public.profiles p join public.garage_orders o on o.id=p_order_id
    where p.id=auth.uid() and p.active and p.role='mechanic' and (
      (o.source='manager' and o.status='published') or exists(
        select 1 from public.garage_order_tasks t join public.garage_task_participants m on m.task_id=t.id
        where t.order_id=o.id and m.mechanic_id=p.id and m.departed_at is null)));
$$;
-- Queue summaries are issued by the list RPC. Raw task rows contain a private blocker reason.
drop policy garage_tasks_read on public.garage_order_tasks;
create policy garage_tasks_read on public.garage_order_tasks for select to authenticated
using (public.garage_is_owner() or public.garage_team_member(id));
drop policy garage_events_read on public.garage_task_events;
create policy garage_events_read on public.garage_task_events for select to authenticated
using (public.garage_is_owner() or (task_id is not null and public.garage_team_member(task_id))
  or (actor_id=auth.uid() and note='' and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active)));
drop policy garage_completions_read on public.garage_task_completions;
create policy garage_completions_read on public.garage_task_completions for select to authenticated
using (public.garage_is_owner() or public.garage_team_member(task_id));

create function public.garage_team_details(p_task_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object(
    'can_see_notes',v.private,'roster_locked',exists(select 1 from public.garage_task_participants
      where task_id=t.id and status='confirmed' and departed_at is null),
    'my_status',(select status from public.garage_task_participants where task_id=t.id and mechanic_id=auth.uid() and departed_at is null),
    'blocker_reason',case when v.private then t.blocker_reason else '' end,
    'participants',coalesce((select jsonb_agg(jsonb_build_object('mechanic_id',m.mechanic_id,'name',p.name,'status',m.status,
      'confirmed_at',m.confirmed_at,'confirmation_origin',m.confirmation_origin,
      'blocker_reason',case when v.private then m.blocker_reason else '' end) order by m.joined_at,m.id)
      from public.garage_task_participants m join public.profiles p on p.id=m.mechanic_id
      where m.task_id=t.id and m.departed_at is null),'[]'::jsonb),
    'notes',case when v.private then coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'mechanic_id',e.actor_id,'name',p.name,
      'note',e.note,'created_at',e.created_at,'action',e.action,'subject_name',subject.name,
      'replacement_name',replacement.name) order by e.created_at,e.id)
      from public.garage_task_events e join public.profiles p on p.id=e.actor_id
      left join public.garage_team_changes change on change.task_id=e.task_id and change.event_id=e.id
      left join public.profiles subject on subject.id=change.subject_mechanic_id
      left join public.profiles replacement on replacement.id=change.replacement_mechanic_id where e.task_id=t.id and e.note<>'' and e.action in
        ('note','block','release','leave','remove','replace','reassign','cancel','record_omitted_completion')),'[]'::jsonb) else '[]'::jsonb end)
  from public.garage_order_tasks t cross join lateral (
    select public.garage_is_owner() or public.garage_team_member(p_task_id) as private) v
  where t.id=p_task_id and public.garage_can_view_task(t.id);
$$;

alter function public.garage_list_orders() rename to garage_list_orders_before_teams;
revoke all on function public.garage_list_orders_before_teams() from public,anon,authenticated,service_role;
create function public.garage_list_orders() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform public.garage_require_actor();
  return coalesce((
    select jsonb_agg(o.value || jsonb_build_object('tasks',coalesce((
      select jsonb_agg(t.value || public.garage_team_details((t.value->>'id')::uuid) order by t.ordinality)
      from jsonb_array_elements(o.value->'tasks') with ordinality t(value,ordinality)
    ),'[]'::jsonb)) order by o.ordinality)
    from jsonb_array_elements(public.garage_list_orders_before_teams()) with ordinality o(value,ordinality)
  ),'[]'::jsonb);
end $$;
revoke all on function public.garage_list_orders() from public,anon,authenticated,service_role;
grant execute on function public.garage_list_orders() to authenticated;

create or replace function public.garage_protect_active_assignments() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if old.role='mechanic' and (not new.active or new.role<>'mechanic') and exists(
    select 1 from public.garage_task_participants m join public.garage_order_tasks t on t.id=m.task_id
    where m.mechanic_id=old.id and m.departed_at is null and m.status<>'confirmed' and t.status in ('pending','in_progress','blocked'))
  then raise exception 'Resolve this mechanic''s outstanding work before changing account access.'; end if;
  return new;
end $$;

-- Preserve the original receipt vocabulary for an installed client retrying a request from before this migration.
alter function public.garage_task_action(uuid,text,integer,uuid,text,uuid) rename to garage_task_action_before_team;
revoke all on function public.garage_task_action_before_team(uuid,text,integer,uuid,text,uuid) from public,anon,authenticated,service_role;

create function public.garage_apply_team_action(p_task_id uuid,p_action text,p_expected_version integer,p_request_id uuid,
  p_note text,p_mechanic_id uuid,p_replacement_id uuid,p_legacy boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  actor uuid:=public.garage_lock_actor(); owner boolean:=public.garage_is_owner();
  t public.garage_order_tasks%rowtype; o public.garage_orders%rowtype; m public.garage_task_participants%rowtype;
  act text:=p_action; reason text:=btrim(coalesce(p_note,'')); payload jsonb; receipt jsonb;
  target uuid:=p_mechanic_id; recipient uuid:=p_replacement_id; frozen boolean;
  next_state text; n integer; anchor uuid; mandatory uuid;
  action_time timestamptz; completed_at_value timestamptz; next_blocker text; event_action text; event_id_value bigint;
begin
  if p_legacy then
    payload:=jsonb_build_object('operation','task','task_id',p_task_id,'action',p_action,'version',p_expected_version,'note',p_note,'assignee',p_mechanic_id);
  else
    payload:=jsonb_build_object('operation','team','task_id',p_task_id,'action',p_action,'version',p_expected_version,
      'note',p_note,'mechanic_id',target,'replacement_id',recipient);
  end if;
  receipt:=public.garage_begin_request(p_request_id,payload);
  if receipt is not null then return receipt; end if;
  if p_expected_version is null or p_expected_version<1 or length(coalesce(p_note,''))>2000 then raise exception 'Invalid action version or note.'; end if;
  if p_legacy and (act is null or act not in ('start','block','resume','complete','release','cancel','reassign')
     or (target is not null and act<>'reassign')) then raise exception 'Unsupported task action or assignee.'; end if;
  if not p_legacy and (act is null or act not in ('join','start','block','resume','confirm','leave','note','assign','remove','replace')
     or (target is not null and act not in ('assign','remove','replace')) or (recipient is not null and act<>'replace')) then
    raise exception 'Unsupported team action or participant.';
  end if;
  select * into o from public.garage_orders where id=(select order_id from public.garage_order_tasks where id=p_task_id) for update;
  select * into t from public.garage_order_tasks where id=p_task_id for update;
  if t.id is null or not public.garage_can_view_task(t.id) then raise exception using errcode='42501', message='Task unavailable.'; end if;
  if p_legacy and act='cancel' then
    return public.garage_task_action_before_team(p_task_id,p_action,p_expected_version,p_request_id,p_note,p_mechanic_id);
  end if;
  if o.status<>'published' or t.status in ('completed','cancelled') then raise exception 'This task is already finished.'; end if;
  select count(*),coalesce(bool_or(status='confirmed'),false) into n,frozen from public.garage_task_participants
    where task_id=t.id and departed_at is null;
  if p_legacy and n>1 then raise exception using errcode='40001',message='This task has a team. Open the updated task before changing it.'; end if;
  if p_legacy then
    if act='reassign' then
      recipient:=target;
      select mechanic_id into target from public.garage_task_participants where task_id=t.id and departed_at is null;
      act:='replace';
    elsif act='complete' then act:='confirm';
    elsif act='release' then act:='leave';
    elsif act='start' and o.source='manager' and not public.garage_team_member(t.id) then act:='join'; end if;
  end if;
  if p_expected_version<>t.version then
    if p_legacy or p_expected_version>t.version or act not in ('join','confirm') or
      (select count(*) from public.garage_team_changes c where c.task_id=t.id and c.version>p_expected_version
        and c.version<=t.version and c.action=act)<>t.version-p_expected_version then
      raise exception using errcode='40001',message='The team or task changed. Review it and retry.';
    end if;
  end if;
  if act in ('assign','remove','replace') then
    if not owner then raise exception using errcode='42501',message='Only the Owner may change another participant.'; end if;
    if target is null then raise exception 'Choose a participant.'; end if;
  elsif owner and act<>'note' then raise exception using errcode='42501',message='Only a mechanic can perform this action.'; end if;
  if act in ('note','block','leave','remove','replace') and reason='' then raise exception 'An operational reason or note is required.'; end if;
  if reason<>'' and public.garage_private_note(reason) then raise exception 'Use an operational note without financial information.'; end if;
  action_time:=clock_timestamp();
  select * into m from public.garage_task_participants where task_id=t.id and departed_at is null
    and mechanic_id=case when act in ('remove','replace') then target else actor end;
  case act
  when 'join' then
    if o.source<>'manager' or frozen or m.id is not null or (p_legacy and t.status<>'pending') then raise exception 'This shared work is unavailable for joining.'; end if;
    insert into public.garage_task_participants(task_id,mechanic_id,status,joined_at,started_at) values(t.id,actor,'working',action_time,action_time);
  when 'assign' then
    if o.source<>'owner' or frozen then raise exception 'This task cannot accept new assignments.'; end if;
    perform public.garage_lock_mechanic(target);
    insert into public.garage_task_participants(task_id,mechanic_id,status,joined_at) values(t.id,target,'assigned',action_time);
  when 'remove','replace','leave' then
    if m.id is null then raise exception using errcode='42501',message='That mechanic is not on this task.'; end if;
    if m.status='confirmed' then raise exception 'A confirmed contribution cannot be removed.'; end if;
    if act='leave' and (o.source<>'manager' or frozen) then raise exception 'Ask the Owner for a roster change.'; end if;
    if act='remove' and o.source='owner' and n=1 then raise exception 'Replace the last mandatory assignee.'; end if;
    if act='replace' then
      if recipient is null or recipient=m.mechanic_id then raise exception 'Choose a different replacement mechanic.'; end if;
      perform public.garage_lock_mechanic(recipient);
      -- A transferred working/blocked job retains its state for installed clients. New transfers
      -- require the replacement to start personally so a reassignment alone never proves work.
      insert into public.garage_task_participants(task_id,mechanic_id,status,joined_at,started_at,blocker_reason)
      values(t.id,recipient,case when p_legacy then m.status else 'assigned' end,action_time,
        null,case when p_legacy then m.blocker_reason else '' end);
    end if;
    update public.garage_task_participants set departed_at=action_time where id=m.id;
  when 'start','block','resume','confirm' then
    if m.id is null then raise exception using errcode='42501',message='Only a current participant can perform this action.'; end if;
    if (act='start' and m.status<>'assigned') or (act in ('block','confirm') and m.status<>'working')
      or (act='resume' and m.status<>'blocked') then raise exception 'This action is unavailable for your current participation state.'; end if;
    update public.garage_task_participants set status=case act when 'block' then 'blocked' when 'confirm' then 'confirmed' else 'working' end,
      started_at=coalesce(started_at,action_time),confirmed_at=case when act='confirm' then action_time end,
      confirmation_origin=case when act='confirm' then 'mechanic' end,blocker_reason=case when act='block' then reason else '' end where id=m.id;
  when 'note' then
    if not owner and m.id is null then raise exception using errcode='42501',message='Only a current participant or the Owner can write notes.'; end if;
  end case;

  select count(*),
    case when count(*)=0 then 'pending'
         when bool_and(status='confirmed') then 'completed'
         when bool_and(status='assigned') then 'pending'
         when bool_and(status in ('blocked','confirmed')) then 'blocked'
         else 'in_progress' end,
    (array_agg(mechanic_id order by (status='assigned'),(mechanic_id=t.working_mechanic_id) desc nulls last,joined_at,id))[1],
    (array_agg(mechanic_id order by (mechanic_id=t.assigned_to) desc nulls last,joined_at,id))[1],
    coalesce((array_agg(blocker_reason order by joined_at,id) filter(where status='blocked'))[1],'')
  into n,next_state,anchor,mandatory,next_blocker
  from public.garage_task_participants where task_id=t.id and departed_at is null;
  completed_at_value:=case when next_state='completed' then action_time end;
  update public.garage_order_tasks set status=next_state,version=version+1,
    assigned_to=case when o.source='owner' then mandatory end,
    working_mechanic_id=case when next_state<>'pending' then anchor end,
    started_at=case when next_state<>'pending' then coalesce(started_at,action_time) else started_at end,
    blocker_reason=case when next_state='blocked' then next_blocker else '' end,
    completed_at=completed_at_value
  where id=t.id returning * into t;
  if next_state='completed' then
    -- Compatibility column records a real confirmer, including Owner excusal of the last holdout.
    insert into public.garage_task_completions(task_id,order_id,mechanic_id,work_code,work_name,completed_at)
    select t.id,o.id,participant.mechanic_id,t.work_code,t.work_name,completed_at_value from public.garage_task_participants participant
    where participant.task_id=t.id and participant.status='confirmed' and participant.departed_at is null
    order by participant.confirmed_at desc,participant.id desc limit 1;
  end if;
  event_action:=case when p_legacy then p_action else act end;
  insert into public.garage_task_events(order_id,task_id,actor_id,action,note,created_at) values(o.id,t.id,actor,event_action,reason,action_time) returning id into event_id_value;
  insert into public.garage_team_changes(task_id,version,action,event_id,subject_mechanic_id,replacement_mechanic_id)
  values(t.id,t.version,act,event_id_value,coalesce(target,actor),recipient);
  update public.garage_orders set version=version+1 where id=o.id;
  return public.garage_finish_request(p_request_id,payload,jsonb_build_object('task_id',t.id,'status',t.status,'version',t.version));
end $$;

create function public.garage_team_action(p_task_id uuid,p_action text,p_expected_version integer,p_request_id uuid,
  p_note text default '',p_mechanic_id uuid default null,p_replacement_id uuid default null)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.garage_apply_team_action(p_task_id,p_action,p_expected_version,p_request_id,p_note,p_mechanic_id,p_replacement_id,false);
$$;
create function public.garage_task_action(p_task_id uuid,p_action text,p_expected_version integer,p_request_id uuid,p_note text default '',p_assignee uuid default null)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.garage_apply_team_action(p_task_id,p_action,p_expected_version,p_request_id,p_note,p_assignee,null,true);
$$;

revoke all on function public.garage_seed_task_member(),public.garage_team_details(uuid),public.garage_team_member(uuid),
  public.garage_apply_team_action(uuid,text,integer,uuid,text,uuid,uuid,boolean),
  public.garage_team_action(uuid,text,integer,uuid,text,uuid,uuid),public.garage_task_action(uuid,text,integer,uuid,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.garage_team_member(uuid),public.garage_team_action(uuid,text,integer,uuid,text,uuid,uuid),
  public.garage_task_action(uuid,text,integer,uuid,text,uuid) to authenticated;

-- Preserve the I/J protocol and every previously issued block. Only the operational
-- description of confirmed contributors changes. Financial amounts and notes stay private.
create or replace function public.garage_sheet_feedback(p_source_id uuid,p_lease_token uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare parent public.garage_orders%rowtype; keys text[]; tasks jsonb; selected record;
  block text; complete boolean; known jsonb; scope jsonb; name_budget integer; rows jsonb:='[]';
begin
  perform public.garage_sheet_require_lease(p_source_id,p_lease_token,p_expected_version);
  for selected in
    select k.order_id,array_agg(k.source_key order by k.source_key) as keys
      from public.garage_sheet_order_keys(p_source_id) k group by k.order_id order by k.order_id
  loop
    select * into parent from public.garage_orders where id=selected.order_id for share;
    keys:=selected.keys;
    select coalesce(jsonb_agg(jsonb_build_object('work_code',t.work_code,'work_name',left(t.work_name,200),'options',t.options,
      'status',t.status,'mechanic_name',people.display_names,'completed_at',c.completed_at) order by t.created_at,t.id),'[]'::jsonb),
      coalesce(count(*) filter(where t.status='completed')>0 and bool_and(t.status in('completed','cancelled')),false),
      string_agg(left(t.work_name,200)||case when t.work_code='W19' then ' · '||(t.options->>'tint_percent')||'%' else '' end
        ||' — '||case t.status when 'completed' then 'Completed' when 'in_progress' then 'In progress'
          when 'pending' then 'Pending' when 'blocked' then 'Blocked' when 'cancelled' then 'Cancelled' end
        ||case when people.display_names is not null then ' · '||people.display_names else '' end,E'\n' order by t.created_at,t.id)
      into tasks,complete,block from (
        select * from public.garage_order_tasks where order_id=parent.id and status<>'cancelled'
        union all
        (select distinct on(work_code,options) * from public.garage_order_tasks where order_id=parent.id and status='cancelled'
          order by work_code,options,created_at desc,id)
      ) t
      left join public.garage_task_completions c on c.task_id=t.id and c.order_id=t.order_id
      left join lateral (
        select string_agg(left(regexp_replace(p.name,'[[:cntrl:]]+',' ','g'),120),', ' order by m.joined_at,m.id) as display_names
        from public.garage_task_participants m join public.profiles p on p.id=m.mechanic_id
        where m.task_id=t.id and m.departed_at is null and m.status='confirmed'
      ) people on true where t.order_id=parent.id;
    complete:=complete and parent.status<>'cancelled';
    if length(block)>19920 then
      name_budget:=greatest(8,((19800 / greatest(1,jsonb_array_length(tasks)))-40)/2);
      select string_agg(left(item->>'work_name',name_budget)||
        case when item->>'work_code'='W19' then ' · '||(item#>>'{options,tint_percent}')||'%' else '' end||
        ' — '||upper(left(item->>'status',1))||replace(substr(item->>'status',2),'_',' ')||
        case when item->>'mechanic_name' is not null then ' · '||left(item->>'mechanic_name',name_budget)||
          case when length(item->>'mechanic_name')>name_budget then '…' else '' end else '' end,E'\n' order by ord)
      into block from jsonb_array_elements(tasks) with ordinality a(item,ord);
    end if;
    block:='[Garage '||parent.order_number||']'||E'\n'||coalesce(block,'No approved work.')||E'\n[/Garage]';
    if length(block)>20000 then raise exception 'The completion summary exceeds the supported size.'; end if;
    insert into public.garage_sheet_feedback_outputs(source_id,order_id,block_hash,block,complete)
      values(p_source_id,parent.id,public.garage_sheet_hash(block||complete::text),block,complete) on conflict do nothing;
    select coalesce(jsonb_agg(jsonb_build_object('block',f.block,'complete',f.complete) order by f.created_at,f.block_hash),'[]')
      into known from public.garage_sheet_feedback_outputs f where f.source_id=p_source_id and f.order_id=parent.id;
    scope:=jsonb_build_object('order',jsonb_build_object('vehicle',parent.vehicle,'vin',parent.vin,'colour',parent.colour,
      'vehicle_group_code',parent.vehicle_group_code,'planned_date',parent.planned_date,'due_date',parent.due_date,
      'priority',parent.priority,'manager_label',parent.manager_label),
      'tasks',coalesce((select jsonb_agg(jsonb_build_object('work_code',t.work_code,'options',t.options,'instructions',t.instructions)
        order by t.work_code,t.id) from public.garage_order_tasks t where t.order_id=parent.id and t.status<>'cancelled'),'[]'::jsonb));
    rows:=rows||jsonb_build_array(jsonb_build_object('order_id',parent.id,'order_number',parent.order_number,
      'order_version',parent.version,'source_keys',to_jsonb(keys),'complete',complete,'tasks',tasks,
      'block',block,'known_outputs',known,'operational_scope',scope));
  end loop;
  return jsonb_build_object('version',p_expected_version,'rows',rows);
end $$;
-- Historical separate-template readers still consume a single display field.
-- Retain its wire shape and bound while accurately naming participating workers.
create or replace function public.garage_sheet_order_status(p_source_id uuid,p_external_order_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('external_order_id',s.external_order_id,'revision',s.last_revision,
    'order_number',o.order_number,'status',o.status,'order_version',o.version,
    'tasks',coalesce((select jsonb_agg(jsonb_build_object('external_task_id',st.external_task_id,
      'work_code',t.work_code,'status',t.status,'working_name',people.names,'completed_at',t.completed_at)
      order by st.external_task_id) from public.garage_sheet_tasks st
      join public.garage_order_tasks t on t.id=st.task_id left join lateral (
        select left(string_agg(regexp_replace(p.name,'[[:cntrl:]]+',' ','g'),', ' order by m.joined_at,m.id),200) as names
        from public.garage_task_participants m join public.profiles p on p.id=m.mechanic_id
        where m.task_id=t.id and m.departed_at is null and m.status<>'assigned') people on true
      where st.source_id=s.source_id and st.external_order_id=s.external_order_id and st.active),'[]'::jsonb))
  from public.garage_sheet_orders s join public.garage_orders o on o.id=s.order_id
  where s.source_id=p_source_id and s.external_order_id=p_external_order_id;
$$;

insert into public.garage_schema_migrations(version) values('20261118000001');
notify pgrst,'reload schema';
commit;
