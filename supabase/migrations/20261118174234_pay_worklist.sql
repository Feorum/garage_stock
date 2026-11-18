-- Private remuneration worklist. Enrol at INSERT time, including late-entered
-- completions. Historical completion dates cannot reconstruct a cutover boundary.
begin;

create schema garage_pay;
revoke all on schema garage_pay from public, anon, authenticated, service_role;
grant usage on schema garage_pay to authenticated;

create table garage_pay.items (
  task_id uuid primary key references public.garage_task_completions(task_id),
  version integer not null default 0 check (version >= 0)
);
create table garage_pay.revisions (
  task_id uuid not null references garage_pay.items(task_id),
  version integer not null check (version > 0),
  actor_id uuid not null references public.profiles(id),
  saved_at timestamptz not null default clock_timestamp(),
  pool_kopeks bigint not null check (pool_kopeks between 0 and 999999999999),
  shares jsonb not null,
  reason text not null check (length(reason) <= 2000),
  request_id uuid not null,
  request_payload jsonb not null,
  primary key(task_id, version),
  unique(actor_id, request_id)
);
alter table garage_pay.items enable row level security;
alter table garage_pay.revisions enable row level security;
revoke all on all tables in schema garage_pay from public, anon, authenticated, service_role;

create function garage_pay.enqueue_completion() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  insert into garage_pay.items(task_id) values(new.task_id);
  return new;
end $$;
create trigger garage_pay_enqueue after insert on public.garage_task_completions
  for each row execute function garage_pay.enqueue_completion();

create function garage_pay.candidates(p_task_id uuid)
returns table(mechanic_id uuid, name text, former boolean)
language sql stable set search_path=pg_catalog as $$
  with participants as (
    select p.mechanic_id, bool_or(p.departed_at is null and p.status='confirmed') as final
    from public.garage_task_participants p
    where p.task_id=p_task_id and (
      (p.departed_at is null and p.status='confirmed') or (p.departed_at is not null and p.started_at is not null))
    group by p.mechanic_id
  ), roster as (
    select mechanic_id, final from participants
    union all
    select c.mechanic_id, true from public.garage_task_completions c
    where c.task_id=p_task_id and not exists(select 1 from participants where final)
  )
  select r.mechanic_id, p.name, not bool_or(r.final)
  from roster r join public.profiles p on p.id=r.mechanic_id group by r.mechanic_id, p.name
$$;

create function garage_pay.worklist() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then raise exception using errcode='42501', message='Only an active Owner can view pay.'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'task_id',i.task_id,'version',i.version,'order_id',o.id,'order_number',o.order_number,'vehicle',o.vehicle,
      'work_name',c.work_name,'options',t.options,'completed_at',c.completed_at,
      'pool_kopeks',r.pool_kopeks,'shares',coalesce(r.shares,'[]'::jsonb),
      'candidates',(select jsonb_agg(to_jsonb(p) order by p.former,p.name,p.mechanic_id) from garage_pay.candidates(i.task_id) p)
    ) order by c.completed_at desc,i.task_id),'[]'::jsonb)
    from garage_pay.items i join public.garage_task_completions c on c.task_id=i.task_id
    join public.garage_orders o on o.id=c.order_id join public.garage_order_tasks t on t.id=i.task_id
    left join garage_pay.revisions r on r.task_id=i.task_id and r.version=i.version
  );
end $$;

create function garage_pay.history(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then raise exception using errcode='42501', message='Only an active Owner can view pay.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('version',r.version,'actor_name',p.name,
    'saved_at',r.saved_at,'pool_kopeks',r.pool_kopeks,'shares',r.shares,'reason',r.reason) order by r.version desc),'[]'::jsonb)
    from garage_pay.revisions r join public.profiles p on p.id=r.actor_id where r.task_id=p_task_id);
end $$;

create function garage_pay.save(p_task_id uuid,p_expected_version integer,p_pool_kopeks bigint,p_shares jsonb,
    p_reason text,p_zero_confirmed boolean,p_request_id uuid) returns integer
language plpgsql security definer set search_path=pg_catalog as $$
declare
  actor uuid:=public.garage_lock_actor();
  reason_text text:=btrim(coalesce(p_reason,''));
  payload jsonb;
  receipt garage_pay.revisions%rowtype;
  current_version integer;
  row_count integer;
  total_basis_points integer;
  amounts jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501', message='Only an active Owner can allocate pay.'; end if;
  if p_request_id is null or p_expected_version is null or p_expected_version<0 or p_pool_kopeks is null
    or p_pool_kopeks not between 0 and 999999999999 or (p_pool_kopeks=0 and p_zero_confirmed is not true)
    or jsonb_typeof(p_shares) is distinct from 'array' or length(reason_text)>2000 then
    raise exception using errcode='22023', message='Invalid allocation or unconfirmed zero pool.';
  end if;
  payload:=jsonb_build_object('task',p_task_id,'version',p_expected_version,'pool',p_pool_kopeks,
    'shares',p_shares,'reason',reason_text,'zero_confirmed',p_zero_confirmed);
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,0));
  select * into receipt from garage_pay.revisions where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.request_payload<>payload then raise exception using errcode='22023',message='Request ID reused with changed values.'; end if;
    return receipt.version;
  end if;
  select version into current_version from garage_pay.items where task_id=p_task_id for update;
  if not found then raise exception using errcode='22023',message='Completed work unavailable for allocation.'; end if;
  if current_version<>p_expected_version then raise exception using errcode='40001',message='Allocation changed. Review the latest version.'; end if;
  if current_version>0 and reason_text='' then raise exception using errcode='22023',message='Explain the correction.'; end if;
  if exists(select 1 from jsonb_array_elements(p_shares) x where jsonb_typeof(x) is distinct from 'object') then
    raise exception using errcode='22023',message='Invalid share.';
  end if;
  if exists(select 1 from jsonb_array_elements(p_shares) x where jsonb_typeof(x->'mechanic_id') is distinct from 'string'
    or jsonb_typeof(x->'basis_points') is distinct from 'number' or x->>'basis_points' !~ '^[0-9]{1,5}$'
    or (x - 'mechanic_id' - 'basis_points')<>'{}'::jsonb) then
    raise exception using errcode='22023',message='Enter one share per mechanic.';
  end if;
  select count(distinct s.mechanic_id),sum(s.basis_points) into row_count,total_basis_points
  from jsonb_to_recordset(p_shares) s(mechanic_id uuid,basis_points int);
  if total_basis_points is distinct from 10000 or row_count<>jsonb_array_length(p_shares) then
    raise exception using errcode='22023',message='Shares must total 100 percent across distinct mechanics.';
  end if;
  if exists(select 1 from garage_pay.candidates(p_task_id) c
    full join jsonb_to_recordset(p_shares) s(mechanic_id uuid,basis_points int) using(mechanic_id)
    where c.mechanic_id is null or (not c.former and s.mechanic_id is null)
      or (c.former and s.mechanic_id is not null and reason_text='')) then
    raise exception using errcode='22023',message='Include all final participants; explain any former helper.';
  end if;
  -- Largest fractional remainder; UUID breaks exact ties consistently on retries.
  with quotas as (
    select s.mechanic_id,c.name,c.former,s.basis_points,
      (p_pool_kopeks*s.basis_points)/10000 as base_kopeks,
      (p_pool_kopeks*s.basis_points)%10000 as remainder
    from jsonb_to_recordset(p_shares) s(mechanic_id uuid,basis_points int)
    join garage_pay.candidates(p_task_id) c using(mechanic_id)
  ), ranked as (
    select *,row_number() over(order by remainder desc,mechanic_id) as rank,
      p_pool_kopeks-sum(base_kopeks) over() as leftover from quotas
  )
  select jsonb_agg(jsonb_build_object('mechanic_id',mechanic_id,'name',name,'former',former,'basis_points',basis_points,
    'kopeks',base_kopeks+case when rank<=leftover then 1 else 0 end) order by mechanic_id) into amounts from ranked;
  insert into garage_pay.revisions(task_id,version,actor_id,pool_kopeks,shares,reason,request_id,request_payload)
  values(p_task_id,current_version+1,actor,p_pool_kopeks,amounts,reason_text,p_request_id,payload);
  update garage_pay.items set version=current_version+1 where task_id=p_task_id;
  return current_version+1;
end $$;

create function public.garage_pay_worklist() returns jsonb language sql stable security invoker set search_path=pg_catalog
  as $$ select garage_pay.worklist() $$;
create function public.garage_pay_history(p_task_id uuid) returns jsonb language sql stable security invoker set search_path=pg_catalog
  as $$ select garage_pay.history(p_task_id) $$;
create function public.garage_pay_save(p_task_id uuid,p_expected_version integer,p_pool_kopeks bigint,p_shares jsonb,
  p_reason text,p_zero_confirmed boolean,p_request_id uuid) returns integer language sql security invoker set search_path=pg_catalog
  as $$ select garage_pay.save(p_task_id,p_expected_version,p_pool_kopeks,p_shares,p_reason,p_zero_confirmed,p_request_id) $$;
revoke all on all functions in schema garage_pay from public,anon,authenticated,service_role;
grant execute on function garage_pay.worklist(),garage_pay.history(uuid),
  garage_pay.save(uuid,integer,bigint,jsonb,text,boolean,uuid) to authenticated;
revoke all on function public.garage_pay_worklist(),public.garage_pay_history(uuid),
  public.garage_pay_save(uuid,integer,bigint,jsonb,text,boolean,uuid) from public,anon,authenticated,service_role;
grant execute on function public.garage_pay_worklist(),public.garage_pay_history(uuid),
  public.garage_pay_save(uuid,integer,bigint,jsonb,text,boolean,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values('20261118174234');
notify pgrst,'reload schema';
commit;
