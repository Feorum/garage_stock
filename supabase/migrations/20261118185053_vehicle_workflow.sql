-- Vehicle custody belongs to a visit. Repeated VINs are separate garage_orders.
begin;
create table public.garage_vehicle_visits (
  order_id uuid primary key references public.garage_orders(id),
  state text not null check (state in ('available','active','review')),
  holder_id uuid references public.profiles(id),
  origin text check (origin in ('explicit','existing_work')),
  taken_at timestamptz,
  handed_at timestamptz,
  handed_by uuid references public.profiles(id),
  handoff_note text not null default '',
  handoff_tasks jsonb not null default '[]' check (jsonb_typeof(handoff_tasks)='array'),
  returned_at timestamptz,
  return_note text not null default '',
  check ((state='available')=(holder_id is null)),
  check (state<>'review' or (handed_by=holder_id and handed_at is not null))
);
create table public.garage_vehicle_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.garage_orders(id),
  actor_id uuid not null references public.profiles(id),
  holder_id uuid references public.profiles(id),
  action text not null check (action in ('take','handoff','return','close')),
  note text not null default '',
  task_snapshot jsonb,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.garage_vehicle_visits enable row level security;
alter table public.garage_vehicle_events enable row level security;
revoke all on public.garage_vehicle_visits,public.garage_vehicle_events from public,anon,authenticated,service_role;
revoke all on sequence public.garage_vehicle_events_id_seq from public,anon,authenticated,service_role;
create index garage_vehicle_holder on public.garage_vehicle_visits(holder_id) where holder_id is not null;
create index garage_vehicle_event_order on public.garage_vehicle_events(order_id,id);

-- Adopt a documented current working mechanic on open visits that are already in progress.
-- Keep the adoption distinguishable from an explicit take; its actual take time is unknown.
insert into public.garage_vehicle_visits(order_id,state,holder_id,origin)
select distinct on (o.id) o.id,'active',m.mechanic_id,'existing_work'
from public.garage_orders o join public.garage_order_tasks t on t.order_id=o.id
join public.garage_task_participants m on m.task_id=t.id
join public.profiles p on p.id=m.mechanic_id
where o.status='published' and t.status in ('in_progress','blocked') and m.departed_at is null
  and m.status in ('working','blocked','confirmed') and p.active and p.role='mechanic'
order by o.id,case m.status when 'working' then 0 when 'blocked' then 1 else 2 end,
  m.started_at nulls last,m.joined_at,m.id;

-- A holder can still hand back a private visit after the Owner moves their last assignment.
-- Its other tasks and notes retain their existing independent visibility checks.
create or replace function public.garage_can_view_order(p_order_id uuid) returns boolean
language sql security definer stable set search_path=pg_catalog,public as $$
  select public.garage_is_owner() or exists(
    select 1 from public.profiles p join public.garage_orders o on o.id=p_order_id
    where p.id=auth.uid() and p.active and p.role='mechanic' and (
      (o.source='manager' and o.status='published')
      or exists(select from public.garage_vehicle_visits v where v.order_id=o.id and v.holder_id=p.id)
      or exists(select from public.garage_order_tasks t join public.garage_task_participants m on m.task_id=t.id
        where t.order_id=o.id and m.mechanic_id=p.id and m.departed_at is null)));
$$;

create function public.garage_vehicle_eligible(p_order_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select from public.garage_orders o join public.garage_order_tasks t on t.order_id=o.id
    join public.profiles p on p.id=auth.uid() where o.id=p_order_id and o.status='published' and t.status<>'cancelled'
    and p.role='mechanic' and p.active and ((o.source='manager' and t.status<>'completed') or public.garage_team_member(t.id)));
$$;

-- Both task APIs lock the parent before updating the task, including notes, roster changes and
-- cached single-worker actions. A rejected update rolls its entire transaction back. Existing
-- idempotent receipts can still be read after handoff because replay performs no task write.
create function public.garage_guard_vehicle_task() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if exists(select from public.profiles p where p.id=auth.uid() and p.active and p.role='mechanic')
     and not exists(select from public.garage_vehicle_visits where order_id=new.order_id and state='active') then
    raise exception using errcode='40001',message='Take the vehicle first or wait for the Owner to return it.';
  end if;
  return new;
end $$;
create trigger garage_guard_vehicle_task before update on public.garage_order_tasks
for each row execute function public.garage_guard_vehicle_task();

-- Also protect Owner clients that still close through the original order endpoint.
create function public.garage_require_vehicle_handoff() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if old.status='published' and new.status='closed' and exists (
      select from public.garage_vehicle_visits where order_id=new.id and state='active') then
    raise exception using errcode='40001',message='The mechanic must hand off the vehicle before closure.';
  end if;
  return new;
end $$;
create trigger garage_require_vehicle_handoff before update of status on public.garage_orders
for each row execute function public.garage_require_vehicle_handoff();

create function public.garage_vehicle_view(p_order jsonb) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  with visit as (
    select o.id,o.status,case when o.status='published' then coalesce(v.state,'available') else o.status end as stage,
      v.holder_id,p.name as holder_name,coalesce(p.active and p.role='mechanic',false) as holder_active,
      v.origin,v.taken_at,v.handed_at,v.handed_by,v.handoff_note,v.handoff_tasks,v.returned_at,v.return_note,
      public.garage_is_owner() as owner
    from public.garage_orders o left join public.garage_vehicle_visits v on v.order_id=o.id
    left join public.profiles p on p.id=v.holder_id where o.id=(p_order->>'id')::uuid
  ), totals as (
    select count(*) filter(where t->>'status'='completed') as completed,
      count(*) filter(where t->>'status' in ('pending','in_progress','blocked')) as unfinished
    from jsonb_array_elements(p_order->'tasks') t
  )
  select jsonb_build_object('state',v.stage,'origin',v.origin,'holder_id',v.holder_id,'holder_name',v.holder_name,
    'taken_at',v.taken_at,'handed_at',v.handed_at,'returned_at',v.returned_at,
    'handoff_note',case when v.owner or v.handed_by=auth.uid() then coalesce(v.handoff_note,'') else '' end,
    'return_note',case when v.owner or v.holder_id=auth.uid() then coalesce(v.return_note,'') else '' end,
    'completed_count',t.completed,'unfinished_count',t.unfinished,
    'can_take',v.stage='available' and public.garage_vehicle_eligible(v.id),
    'can_handoff',coalesce(v.stage='active' and v.holder_id=auth.uid() and v.holder_active,false),
    'can_return',v.owner and (v.stage='review' or (v.stage='active' and not v.holder_active)),
    'can_close',v.owner and v.stage in ('available','review') and t.completed>0 and t.unfinished=0,
    'handoff_tasks',coalesce((select jsonb_agg(item-'visible_to_holder' order by n)
      from jsonb_array_elements(v.handoff_tasks) with ordinality snap(item,n)
      where v.owner or (v.handed_by=auth.uid() and (item->>'visible_to_holder')::boolean)),'[]'::jsonb))
  from visit v cross join totals t;
$$;

alter function public.garage_list_orders() rename to garage_list_orders_before_vehicle;
revoke all on function public.garage_list_orders_before_vehicle() from public,anon,authenticated,service_role;
create function public.garage_list_orders() returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(o||jsonb_build_object('vehicle_workflow',public.garage_vehicle_view(o)) order by n),'[]'::jsonb)
  from jsonb_array_elements(public.garage_list_orders_before_vehicle()) with ordinality listed(o,n);
$$;

create function public.garage_vehicle_action(p_order_id uuid,p_action text,p_expected_version integer,p_request_id uuid,p_note text default '')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  actor uuid:=public.garage_lock_actor(); owner boolean:=public.garage_is_owner(); reason text:=btrim(coalesce(p_note,''));
  o public.garage_orders%rowtype; v public.garage_vehicle_visits%rowtype; payload jsonb; result jsonb;
  stage text; holder uuid; keep_holder boolean; snapshot jsonb; occurred timestamptz;
begin
  payload:=jsonb_build_object('operation','vehicle','order_id',p_order_id,'action',p_action,'version',p_expected_version,'note',p_note);
  result:=public.garage_begin_request(p_request_id,payload);
  if result is not null then return result; end if;
  if p_action is null or p_action not in ('take','handoff','return','close') or p_expected_version is null or p_expected_version<1 then
    raise exception 'Invalid vehicle action or version.'; end if;
  if length(coalesce(p_note,''))>2000 or public.garage_private_note(reason) then raise exception 'Use an operational note without financial information.'; end if;
  if (p_action in ('return','close'))<>owner then raise exception using errcode='42501',message='This vehicle action is unavailable to your account.'; end if;
  select * into o from public.garage_orders where id=p_order_id for update;
  if o.id is null or not public.garage_can_view_order(o.id) then raise exception using errcode='42501',message='Vehicle unavailable.'; end if;
  if o.status<>'published' or o.version<>p_expected_version then raise exception using errcode='40001',message='This visit changed. Review it before continuing.'; end if;
  select * into v from public.garage_vehicle_visits where order_id=o.id;
  stage:=coalesce(v.state,'available'); holder:=v.holder_id; occurred:=clock_timestamp();
  case p_action
    when 'take' then
      if stage<>'available' then raise exception using errcode='40001',message='The vehicle is already taken or under review.'; end if;
      if not public.garage_vehicle_eligible(o.id) then raise exception using errcode='42501',message='No eligible work on this visit.'; end if;
      stage:='active'; holder:=actor;
      insert into public.garage_vehicle_visits(order_id,state,holder_id,origin,taken_at) values(o.id,stage,holder,'explicit',occurred)
      on conflict(order_id) do update set state=excluded.state,holder_id=excluded.holder_id,origin=excluded.origin,taken_at=excluded.taken_at,
        handed_at=null,handed_by=null,handoff_note='',handoff_tasks='[]',returned_at=null,return_note='';
    when 'handoff' then
      if stage<>'active' or holder is distinct from actor then raise exception using errcode='42501',message='Only the mechanic holding this vehicle can hand it off.'; end if;
      select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'work_code',t.work_code,'work_name',t.work_name,
        'options',t.options,'status',t.status,'completed_at',t.completed_at,
        'visible_to_holder',public.garage_can_view_task(t.id)) order by t.created_at,t.id),'[]'::jsonb)
      into snapshot from public.garage_order_tasks t where t.order_id=o.id;
      stage:='review';
      update public.garage_vehicle_visits set state=stage,handed_at=occurred,handed_by=actor,handoff_note=reason,handoff_tasks=snapshot
        where order_id=o.id;
    when 'return' then
      select exists(select from public.profiles where id=holder and active and role='mechanic' for share) into keep_holder;
      if stage<>'review' and not(stage='active' and not keep_holder) then raise exception 'This vehicle is not awaiting return.'; end if;
      stage:=case when keep_holder then 'active' else 'available' end;
      if not keep_holder then holder:=null; end if;
      update public.garage_vehicle_visits set state=stage,holder_id=holder,returned_at=occurred,return_note=reason where order_id=o.id;
    when 'close' then
      result:=public.garage_order_action(o.id,'close',o.version,gen_random_uuid(),reason);
      stage:='closed'; o.version:=(result->>'version')::integer;
  end case;
  if p_action<>'close' then update public.garage_orders set version=version+1 where id=o.id returning version into o.version; end if;
  insert into public.garage_vehicle_events(order_id,actor_id,holder_id,action,note,task_snapshot,created_at)
  values(o.id,actor,coalesce(holder,v.holder_id),p_action,reason,snapshot,occurred);
  return public.garage_finish_request(p_request_id,payload,jsonb_build_object('order_id',o.id,'state',stage,'version',o.version));
end $$;

revoke all on function public.garage_vehicle_eligible(uuid),public.garage_guard_vehicle_task(),public.garage_require_vehicle_handoff(),public.garage_vehicle_view(jsonb),
  public.garage_list_orders(),public.garage_vehicle_action(uuid,text,integer,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.garage_list_orders(),public.garage_vehicle_action(uuid,text,integer,uuid,text) to authenticated;
insert into public.garage_schema_migrations(version) values ('20261118185053');
notify pgrst,'reload schema';
commit;
