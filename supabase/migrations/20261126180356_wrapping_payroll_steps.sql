begin;

-- Keep the scope used by an earlier close while installing the new work flags.
lock table public.garage_orders in share row exclusive mode;

create function garage_payroll.has_wrapping(p_order_id uuid) returns boolean
language sql stable set search_path=pg_catalog as $$
  select exists (select from public.garage_order_tasks
    where order_id=p_order_id and status<>'cancelled' and work_code<>'W19')
$$;
revoke all on function garage_payroll.has_wrapping(uuid) from public,anon,authenticated,service_role;

create or replace function garage_payroll.work_lines(p_order_id uuid,p_frozen jsonb) returns jsonb
language sql stable set search_path=pg_catalog as $$
  with locked as (
    select (j->>'task_id')::uuid as id,j as line from jsonb_array_elements(coalesce(p_frozen,'[]')) j
  ), tasks as (
    select c.task_id,c.work_name,(c.completed_at at time zone 'Europe/Minsk')::date work_date,
           coalesce((l.line->>'basis_kopeks')::bigint,price.internal_price_kopeks) basis_kopeks,
           l.line->'people' saved_people,r.shares manual_shares,
           case when l.line is not null then coalesce((l.line->>'wrapping')::boolean,true)
                else t.work_code<>'W19' end wrapping
    from public.garage_task_completions c join public.garage_order_tasks t on t.id=c.task_id and t.status='completed'
    join garage_pay.commercial_lines(p_order_id) price on price.task_id=c.task_id
    left join locked l on l.id=c.task_id left join garage_pay.items i on i.task_id=c.task_id
    left join garage_pay.revisions r on r.task_id=i.task_id and r.version=i.version
    where c.order_id=p_order_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('task_id',t.task_id,'work_name',t.work_name,'work_date',t.work_date,
    'basis_kopeks',t.basis_kopeks,'wrapping',t.wrapping,'manual_shares',t.manual_shares,'people',members.people) order by t.work_date,t.task_id),'[]')
  from tasks t cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('mechanic_id',p.mechanic_id,'name',p.name,'rate_bp',coalesce(p.rate_bp,r.rate_bp))
      order by p.mechanic_id),'[]') as people
    from (
      select c.mechanic_id,c.name,null::integer rate_bp from garage_pay.candidates(t.task_id) c where not c.former and t.saved_people is null
      union all
      select * from jsonb_to_recordset(coalesce(t.saved_people,'[]')) as saved(mechanic_id uuid,name text,rate_bp integer)
    ) p left join lateral (
      select rate_bp from garage_payroll.rates where mechanic_id=p.mechanic_id and effective_date<=t.work_date
      order by effective_date desc,id desc limit 1
    ) r on true
  ) members
$$;

create or replace function garage_payroll.amounts(lines jsonb, prep uuid[], heat uuid[], overrides jsonb)
returns table(mechanic_id uuid,name text,automatic_kopeks bigint,override_kopeks bigint,kopeks bigint)
language sql stable set search_path=pg_catalog as $$
  with tasks as (
    select * from jsonb_to_recordset(lines) t(task_id uuid,basis_kopeks bigint,people jsonb,manual_shares jsonb,wrapping boolean)
  ), roles as (
    select which,worker,300::numeric/count(*) over(partition by which) as bp
    from (select 'prep' which, unnest(prep) worker union all select 'heat',unnest(heat)) x
  ), mains as (
    select t.task_id,t.basis_kopeks,p.mechanic_id,p.rate_bp,
      greatest(0,p.rate_bp - case when coalesce(t.wrapping,true) and cardinality(prep)>0 and not (p.mechanic_id=any(prep)) then 300 else 0 end
        - case when coalesce(t.wrapping,true) and cardinality(heat)>0 and not (p.mechanic_id=any(heat)) then 300 else 0 end) as weight
    from tasks t cross join lateral jsonb_to_recordset(t.people) p(mechanic_id uuid,rate_bp integer)
    where t.manual_shares is null
  ), helpers as (
    select t.task_id,t.basis_kopeks,r.worker,sum(r.bp) as bp
    from tasks t cross join roles r
    where t.manual_shares is null and coalesce(t.wrapping,true) and not exists (select from mains m where m.task_id=t.task_id and m.mechanic_id=r.worker)
    group by t.task_id,t.basis_kopeks,r.worker
  ), pools as (
    select m.*,count(*) over w as members,sum(weight) over w as weights,
      2500-coalesce((select sum(h.bp) from helpers h where h.task_id=m.task_id),0) as available
    from mains m window w as (partition by m.task_id)
  ), earnings as (
    select mechanic_id,rate_bp,coalesce(basis_kopeks,0)/10000.0 *
      case when members=1 then least(weight,available)
           when weights>0 then available*weight/weights else 0 end as amount
    from pools
    union all select worker,0,coalesce(basis_kopeks,0)*bp/10000.0 from helpers
  ), summed as (
    select mechanic_id,max(rate_bp) as rate,sum(amount) as exact,round(sum(amount)/100)::bigint as rubles
    from earnings group by mechanic_id
  ), remainder as (
    -- A fractionally higher rounded sum must never cross the automatic ceiling.
    select least(round(sum(exact)/100),floor((select coalesce(sum(basis_kopeks),0) from tasks where manual_shares is null)/400.0))
       - sum(rubles) as delta from summed
  ), ranked as (
    select s.*,row_number() over(order by rate desc nulls last,mechanic_id) as add_priority,
      row_number() over(order by (rubles>0) desc,rate asc nulls first,mechanic_id) as remove_priority
    from summed s
  ), combined as (
    select mechanic_id,100*(rubles+case when add_priority<=delta then 1 when remove_priority<=-delta then -1 else 0 end) as amount
    from ranked cross join remainder
    union all select s.mechanic_id,s.kopeks from tasks t cross join lateral jsonb_to_recordset(coalesce(t.manual_shares,'[]')) s(mechanic_id uuid,kopeks bigint)
  ), per_person as (
    select c.mechanic_id,sum(c.amount)::bigint as automatic_kopeks from combined c group by c.mechanic_id
  )
  select p.mechanic_id,pr.name,p.automatic_kopeks,o.kopeks,coalesce(o.kopeks,p.automatic_kopeks)
  from per_person p join public.profiles pr on pr.id=p.mechanic_id
  left join jsonb_to_recordset(overrides) o(mechanic_id uuid,kopeks bigint) using(mechanic_id)
$$;

create or replace function garage_payroll.calculate(lines jsonb,prep uuid[],heat uuid[],amount_overrides jsonb,
    reserve_override bigint,additional_override bigint,closed boolean,order_basis bigint) returns jsonb
language sql stable set search_path=pg_catalog as $$
  with work as (
    select * from jsonb_to_recordset(lines) l(task_id uuid,work_date date,basis_kopeks bigint,people jsonb,manual_shares jsonb,wrapping boolean)
  ), amounts as (
    select a.mechanic_id,a.name,
      case when u.incomplete then null else a.automatic_kopeks end as automatic_kopeks,a.override_kopeks,
      case when u.incomplete then a.override_kopeks else a.kopeks end as kopeks
    from garage_payroll.amounts(lines,prep,heat,amount_overrides) a
    cross join lateral (
      select exists(select from work w where w.manual_shares is null and
        (w.people @> jsonb_build_array(jsonb_build_object('mechanic_id',a.mechanic_id))
         or (coalesce(w.wrapping,true) and a.mechanic_id=any(prep||heat))) and
        (w.basis_kopeks is null or exists(select from jsonb_array_elements(w.people) p where (p->>'rate_bp') is null))) as incomplete
    ) u
  ), summary as (
    select (select case when count(*)=count(kopeks) then coalesce(sum(kopeks),0) end from amounts) as actual,round(order_basis*.25)::bigint as cap,
      round(order_basis*.05)::bigint as reserve,order_basis as basis
  )
  select jsonb_build_object('closed',closed,'lines',lines,'prep_ids',prep,'heat_ids',heat,
    'missing_rates',coalesce((select jsonb_agg(to_jsonb(m) order by work_date,mechanic_id) from (
      select distinct p.mechanic_id,p.name,w.work_date from work w cross join lateral jsonb_to_recordset(w.people) p(mechanic_id uuid,name text,rate_bp integer)
      where w.manual_shares is null and p.rate_bp is null
    ) m),'[]'::jsonb),
    'missing_prices',coalesce((select jsonb_agg(task_id order by task_id) from work where basis_kopeks is null),'[]'::jsonb),
    'people',coalesce((select jsonb_agg(to_jsonb(a) order by a.name,a.mechanic_id) from amounts a),'[]'),
    'basis_kopeks',basis,'cap_kopeks',cap,'total_kopeks',actual,'excess_kopeks',case when actual is not null and cap is not null then greatest(0,actual-cap) end,
    'automatic_reserve_kopeks',reserve,'reserve_kopeks',coalesce(reserve_override,reserve),'override_reserve_kopeks',reserve_override,
    'automatic_additional_kopeks',case when not closed then 0 when actual is not null and cap is not null then greatest(0,cap-actual) end,
    'additional_kopeks',coalesce(additional_override,case when not closed then 0 when actual is not null and cap is not null then greatest(0,cap-actual) end),'override_additional_kopeks',additional_override)
  from summary
$$;

create or replace function garage_payroll.read_order(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare prior garage_payroll.revisions%rowtype; order_status text; lines jsonb; state jsonb; audit jsonb; wrapping_steps boolean;
begin
  perform garage_payroll.require_owner();
  select status into order_status from public.garage_orders where id=p_order_id;
  if not found or order_status='cancelled' then return '{"applicable":false}'::jsonb; end if;
  if exists(select from garage_payroll.legacy_orders where id=p_order_id) then return '{"applicable":false,"historical":true}'::jsonb; end if;
  select * into prior from garage_payroll.revisions where order_id=p_order_id order by version desc limit 1;
  lines:=garage_payroll.work_lines(p_order_id,prior.frozen_lines);
  wrapping_steps:=garage_payroll.has_wrapping(p_order_id)
    or (order_status='closed' and exists (select from jsonb_array_elements(lines) l
      where (l->>'wrapping')::boolean)
      and (cardinality(prior.prep_ids)>0 or cardinality(prior.heat_ids)>0));
  -- All active services count towards the order budget. Earnings accrue only
  -- on completed lines; preserve the known order budget when settling a closed visit.
  state:=garage_payroll.calculate(lines,
    case when wrapping_steps then coalesce(prior.prep_ids,'{}') else '{}'::uuid[] end,
    case when wrapping_steps then coalesce(prior.heat_ids,'{}') else '{}'::uuid[] end,
    coalesce(prior.amounts,'[]'),prior.reserve_kopeks,prior.additional_kopeks,order_status='closed',
    coalesce(case when order_status='closed' then (prior.result->>'basis_kopeks')::bigint end,
      garage_pay.internal_total_kopeks(p_order_id)));
  select coalesce(jsonb_agg(jsonb_build_object('version',r.version,'actor_name',p.name,'saved_at',r.saved_at,
      'operation',r.operation,'total_kopeks',r.result->'total_kopeks','reserve_kopeks',r.result->'reserve_kopeks',
      'additional_kopeks',r.result->'additional_kopeks','people',r.result->'people') order by r.version desc),'[]')
    into audit from garage_payroll.revisions r left join public.profiles p on p.id=r.actor_id where r.order_id=p_order_id;
  return state||jsonb_build_object('applicable',true,'historical',false,'wrapping_steps',wrapping_steps,'version',coalesce(prior.version,0),
      'token',md5(state::text||':'||coalesce(prior.version,0)::text||':'||wrapping_steps::text),'history',audit);
end $$;

create or replace function garage_payroll.save_order(p_order_id uuid,p_expected_token text,p_prep_ids uuid[],p_heat_ids uuid[],
    p_amounts jsonb,p_reserve_kopeks bigint,p_additional_kopeks bigint,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_lock_actor(); current_view jsonb; next_result jsonb; payload_input jsonb;
  receipt garage_payroll.revisions%rowtype; ordered_prep uuid[]; ordered_heat uuid[]; ordered_amounts jsonb;
begin
  perform garage_payroll.require_owner();
  if p_request_id is null or p_expected_token is null or p_prep_ids is null or p_heat_ids is null
     or p_reserve_kopeks not between 0 and 999999999999 or p_additional_kopeks not between 0 and 999999999999
     or jsonb_typeof(p_amounts) is distinct from 'array' then raise exception using errcode='22023',message='Invalid payroll settings.'; end if;
  if exists(select from jsonb_array_elements(p_amounts) a where jsonb_typeof(a) is distinct from 'object'
    or jsonb_typeof(a->'mechanic_id') is distinct from 'string' or a->>'mechanic_id' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    or jsonb_typeof(a->'kopeks') is distinct from 'number' or a->>'kopeks' !~ '^[0-9]{1,12}$' or a-'mechanic_id'-'kopeks'<>'{}') then
    raise exception using errcode='22023',message='Invalid payout override.';
  end if;
  select array(select distinct id from unnest(p_prep_ids) id order by id),
         array(select distinct id from unnest(p_heat_ids) id order by id),
         (select coalesce(jsonb_agg(to_jsonb(a) order by a.mechanic_id),'[]') from jsonb_to_recordset(p_amounts) a(mechanic_id uuid,kopeks bigint))
    into ordered_prep,ordered_heat,ordered_amounts;
  if cardinality(ordered_prep)<>cardinality(p_prep_ids) or cardinality(ordered_heat)<>cardinality(p_heat_ids)
    or (select count(distinct a.mechanic_id) from jsonb_to_recordset(ordered_amounts) a(mechanic_id uuid))<>jsonb_array_length(ordered_amounts) then
    raise exception using errcode='22023',message='Duplicate mechanic.';
  end if;
  payload_input:=jsonb_build_array(p_order_id,p_expected_token,ordered_prep,ordered_heat,ordered_amounts,p_reserve_kopeks,p_additional_kopeks);
  perform id from public.garage_orders where id=p_order_id for update;
  perform pg_advisory_xact_lock_shared(1863854945,1);
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,0));
  select * into receipt from garage_payroll.revisions where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.payload<>payload_input then raise exception using errcode='22023',message='Request ID reused with different settings.'; end if;
    return garage_payroll.read_order(p_order_id);
  end if;
  current_view:=garage_payroll.read_order(p_order_id);
  if (current_view->>'applicable')::boolean is not true then raise exception using errcode='22023',message='Payroll unavailable for this order.'; end if;
  if p_expected_token<>current_view->>'token' then raise exception using errcode='40001',message='Payroll inputs changed. Refresh the order.'; end if;
  if (current_view->>'wrapping_steps')::boolean is not true and cardinality(ordered_prep||ordered_heat)>0 then
    raise exception using errcode='22023',message='Preparation and heating apply to wrapping only.';
  end if;
  if exists(select from unnest(ordered_prep||ordered_heat) helper(id) where not exists(select from public.profiles p
    where p.id=helper.id and p.role='mechanic' and (p.active or helper.id::text in (select jsonb_array_elements_text(current_view->'prep_ids'))
      or helper.id::text in (select jsonb_array_elements_text(current_view->'heat_ids'))))) then
    raise exception using errcode='22023',message='Unknown helper.';
  end if;
  next_result:=garage_payroll.calculate(current_view->'lines',ordered_prep,ordered_heat,ordered_amounts,
      p_reserve_kopeks,p_additional_kopeks,(current_view->>'closed')::boolean,(current_view->>'basis_kopeks')::bigint);
  if exists(select from jsonb_to_recordset(ordered_amounts) a(mechanic_id uuid) where not exists (
    select from jsonb_to_recordset(next_result->'people') p(mechanic_id uuid) where a.mechanic_id=p.mechanic_id)) then
    raise exception using errcode='22023',message='Only actual participants may receive a payout override.';
  end if;
  insert into garage_payroll.revisions(order_id,version,actor_id,operation,prep_ids,heat_ids,amounts,reserve_kopeks,
    additional_kopeks,frozen_lines,result,request_id,payload) values(p_order_id,(current_view->>'version')::integer+1,actor,'save',
    ordered_prep,ordered_heat,ordered_amounts,p_reserve_kopeks,p_additional_kopeks,
    case when (current_view->>'closed')::boolean then current_view->'lines' end,next_result,p_request_id,payload_input);
  return garage_payroll.read_order(p_order_id);
end $$;

create or replace function garage_payroll.on_close() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare prior garage_payroll.revisions%rowtype; lines jsonb; snapshot jsonb; prep uuid[]; heat uuid[];
begin
  perform pg_advisory_xact_lock_shared(1863854945,1);
  select * into prior from garage_payroll.revisions where order_id=new.id order by version desc limit 1;
  lines:=garage_payroll.work_lines(new.id,null);
  if garage_payroll.has_wrapping(new.id) then
    prep:=coalesce(prior.prep_ids,'{}');
    heat:=coalesce(prior.heat_ids,'{}');
  else
    prep:='{}';
    heat:='{}';
  end if;
  snapshot:=garage_payroll.calculate(lines,prep,heat,
    coalesce(prior.amounts,'[]'),prior.reserve_kopeks,prior.additional_kopeks,true,
    garage_pay.internal_total_kopeks(new.id));
  insert into garage_payroll.revisions(order_id,version,actor_id,operation,prep_ids,heat_ids,amounts,reserve_kopeks,additional_kopeks,
    frozen_lines,result) values(new.id,coalesce(prior.version,0)+1,auth.uid(),'close',prep,heat,
    coalesce(prior.amounts,'[]'),prior.reserve_kopeks,prior.additional_kopeks,lines,snapshot);
  return new;
end $$;

insert into public.garage_schema_migrations(version) values('20261126180356');
notify pgrst,'reload schema';
commit;
