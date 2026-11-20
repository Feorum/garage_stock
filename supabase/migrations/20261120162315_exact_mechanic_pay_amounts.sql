begin;

-- Supply the same editable job to the Owner's order detail and payroll list.
-- Historical allocations can outlive a withdrawn completion.
create or replace function garage_pay.payout(p_task_id uuid,p_catalogue_kopeks bigint)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object(
    'version',i.version,'pool_kopeks',r.pool_kopeks,'shares',coalesce(r.shares,'[]'::jsonb),
    'equal_split',coalesce((r.request_payload->>'equal_split')::boolean,false),
    'suggested_pool_kopeks',p_catalogue_kopeks,'suggested_shares',garage_pay.equal_shares(i.task_id,p_catalogue_kopeks),
    'candidates',(select coalesce(jsonb_agg(to_jsonb(p) order by p.former,p.name,p.mechanic_id),'[]'::jsonb)
                  from garage_pay.candidates(i.task_id) p))
  from garage_pay.items i
  join public.garage_task_completions c on c.task_id=i.task_id
  join public.garage_order_tasks t on t.id=i.task_id and t.status='completed'
  left join garage_pay.revisions r on r.task_id=i.task_id and r.version=i.version
  where i.task_id=p_task_id
$$;

create or replace function garage_pay.worklist() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('task_id',i.task_id,'order_id',o.id,'order_number',o.order_number,
      'vehicle',o.vehicle,'work_name',c.work_name,'options',t.options,'completed_at',c.completed_at)
      || garage_pay.price_fields(i.task_id,(f.net_amount*100)::bigint,f.vat_rate)
      || garage_pay.payout(i.task_id,(f.net_amount*100)::bigint)
      order by c.completed_at desc,i.task_id),'[]'::jsonb)
    from garage_pay.items i join public.garage_task_completions c on c.task_id=i.task_id
    join public.garage_orders o on o.id=c.order_id join public.garage_order_tasks t on t.id=i.task_id and t.status='completed'
    left join public.garage_task_financials f on f.task_id=i.task_id
  );
end $$;

create function garage_pay.save_amounts(p_task_id uuid,p_expected_version integer,p_amounts jsonb,
    p_reason text,p_zero_confirmed boolean,p_request_id uuid) returns integer
language plpgsql security definer set search_path=pg_catalog as $$
declare
  actor uuid:=public.garage_lock_actor();
  reason_text text:=btrim(coalesce(p_reason,''));
  receipt garage_pay.revisions%rowtype;
  current_version integer;
  total numeric;
  pool bigint;
  people integer;
  ordered jsonb;
  payload jsonb;
  shares jsonb;
  changed_roster boolean;
  includes_former boolean;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  if p_task_id is null or p_request_id is null or p_expected_version is null or p_expected_version<0
    or length(reason_text)>2000 or jsonb_typeof(p_amounts) is distinct from 'array' or p_amounts='[]'::jsonb then
    raise exception using errcode='22023',message='Enter a payout amount for each mechanic.';
  end if;
  if exists(select from jsonb_array_elements(p_amounts) x where jsonb_typeof(x) is distinct from 'object') then
    raise exception using errcode='22023',message='Invalid payout entry.';
  end if;
  if exists(select from jsonb_array_elements(p_amounts) x
    where jsonb_typeof(x->'mechanic_id') is distinct from 'string'
      or x->>'mechanic_id' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or jsonb_typeof(x->'kopeks') is distinct from 'number' or x->>'kopeks' !~ '^[0-9]{1,12}$'
      or x-'mechanic_id'-'kopeks'<>'{}'::jsonb) then
    raise exception using errcode='22023',message='Invalid mechanic or amount in kopeks.';
  end if;
  select count(distinct a.mechanic_id),sum(a.kopeks),jsonb_agg(to_jsonb(a) order by a.mechanic_id)
    into people,total,ordered from jsonb_to_recordset(p_amounts) a(mechanic_id uuid,kopeks bigint);
  if people<>jsonb_array_length(p_amounts) or total>999999999999 or (total=0 and p_zero_confirmed is not true) then
    raise exception using errcode='22023',message='Check the recipients, total amount and zero confirmation.';
  end if;
  pool:=total::bigint;
  payload:=jsonb_build_object('operation','pay_amounts','task',p_task_id,'version',p_expected_version,
    'amounts',ordered,'reason',reason_text,'zero_confirmed',p_zero_confirmed);
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,0));
  select * into receipt from garage_pay.revisions where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.request_payload<>payload then raise exception using errcode='22023',message='Request ID reused with changed values.'; end if;
    return receipt.version;
  end if;
  select i.version into current_version from garage_pay.items i where i.task_id=p_task_id for update;
  if not found or current_version<>p_expected_version
     or not exists(select from public.garage_task_completions c join public.garage_order_tasks t on t.id=c.task_id
                   where c.task_id=p_task_id and t.status='completed') then
    raise exception using errcode='40001',message='Job or allocation changed. Refresh the allocation.';
  end if;
  if current_version>0 and reason_text='' then raise exception using errcode='22023',message='Explain the correction.'; end if;
  select bool_or(c.mechanic_id is null or (not c.former and a.mechanic_id is null)),
         bool_or(c.former and a.mechanic_id is not null) into changed_roster,includes_former
  from garage_pay.candidates(p_task_id) c full join jsonb_to_recordset(ordered) a(mechanic_id uuid) using(mechanic_id);
  if changed_roster then raise exception using errcode='40001',message='The mechanic roster changed. Refresh the allocation.'; end if;
  if includes_former and reason_text='' then raise exception using errcode='22023',message='Explain the inclusion of a former participant.'; end if;

  -- The entered kopeks are authoritative. Older clients also display a ratio,
  -- so distribute its rounding remainder independently of the money.
  with weights as (
    select c.*,a.kopeks,case when pool=0 then 1 else a.kopeks end as weight,
      case when pool=0 then people else pool end as denominator
    from jsonb_to_recordset(ordered) a(mechanic_id uuid,kopeks bigint)
    join garage_pay.candidates(p_task_id) c using(mechanic_id)
  ), portions as (
    select *,weight*10000/denominator as base,weight*10000%denominator as remainder from weights
  ), ranked as (
    select *,row_number() over(order by remainder desc,mechanic_id) as position,10000-sum(base) over() as extra
    from portions
  )
  select jsonb_agg(jsonb_build_object('mechanic_id',mechanic_id,'name',name,'former',former,
    'kopeks',kopeks,'basis_points',base+(position<=extra)::integer) order by mechanic_id)
    into shares from ranked;
  insert into garage_pay.revisions(task_id,version,actor_id,pool_kopeks,shares,reason,request_id,request_payload)
    values(p_task_id,current_version+1,actor,pool,shares,reason_text,p_request_id,payload);
  update garage_pay.items set version=current_version+1 where task_id=p_task_id;
  return current_version+1;
end $$;

create function public.garage_pay_save_amounts(p_task_id uuid,p_expected_version integer,p_amounts jsonb,
    p_reason text,p_zero_confirmed boolean,p_request_id uuid) returns integer
language sql security invoker set search_path=pg_catalog as $$
  select garage_pay.save_amounts(p_task_id,p_expected_version,p_amounts,p_reason,p_zero_confirmed,p_request_id)
$$;
revoke all on function garage_pay.save_amounts(uuid,integer,jsonb,text,boolean,uuid),
  public.garage_pay_save_amounts(uuid,integer,jsonb,text,boolean,uuid) from public,anon,authenticated,service_role;
grant execute on function garage_pay.save_amounts(uuid,integer,jsonb,text,boolean,uuid),
  public.garage_pay_save_amounts(uuid,integer,jsonb,text,boolean,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values('20261120162315');
notify pgrst,'reload schema';
commit;
