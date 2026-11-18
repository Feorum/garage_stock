-- Private BYN amounts are integer kopeks. The immutable catalogue snapshot,
-- the effective pre-VAT customer price and the confirmed payout are distinct.
begin;
create table garage_pay.task_pricing_revisions (
  task_id uuid not null references public.garage_order_tasks(id),
  version integer not null check(version>0),
  override_kopeks bigint check(override_kopeks between 0 and 999999999999),
  private_comment text not null check(length(private_comment)<=2000),
  actor_id uuid not null references public.profiles(id),
  saved_at timestamptz not null default clock_timestamp(),
  request_id uuid not null,
  primary key(task_id,version), unique(actor_id,request_id)
);
alter table garage_pay.task_pricing_revisions enable row level security;
revoke all on garage_pay.task_pricing_revisions from public,anon,authenticated,service_role;

create function garage_pay.save_task_pricing(p_task_id uuid,p_expected_version integer,p_override_kopeks bigint,
    p_private_comment text,p_request_id uuid) returns integer
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_lock_actor(); receipt garage_pay.task_pricing_revisions%rowtype;
  task_status text; current_version integer;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  if p_request_id is null or p_expected_version is null or p_expected_version<0
    or p_override_kopeks not between 0 and 999999999999 or p_private_comment is null or length(p_private_comment)>2000 then
    raise exception using errcode='22023',message='Invalid price or private comment.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,0));
  select * into receipt from garage_pay.task_pricing_revisions where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.task_id is distinct from p_task_id or receipt.version<>p_expected_version+1
      or receipt.override_kopeks is distinct from p_override_kopeks or receipt.private_comment<>p_private_comment then
      raise exception using errcode='22023',message='Request ID reused with different private fields.';
    end if;
    return receipt.version;
  end if;
  select status into task_status from public.garage_order_tasks where id=p_task_id for update;
  if not found or task_status='cancelled' then raise exception using errcode='22023',message='Task unavailable.'; end if;
  select coalesce(max(version),0) into current_version from garage_pay.task_pricing_revisions where task_id=p_task_id;
  if p_expected_version<>current_version then raise exception using errcode='40001',message='Private fields changed.'; end if;
  insert into garage_pay.task_pricing_revisions(task_id,version,override_kopeks,private_comment,actor_id,request_id)
    values(p_task_id,current_version+1,p_override_kopeks,p_private_comment,actor,p_request_id);
  return current_version+1;
end $$;

create function garage_pay.price_fields(p_task_id uuid,p_catalogue_kopeks bigint,p_vat_rate numeric default null)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('catalogue_kopeks',p_catalogue_kopeks,'override_kopeks',r.override_kopeks,
    'effective_kopeks',price.net,'vat_rate',p_vat_rate,'effective_tax_kopeks',vat.tax,'effective_gross_kopeks',price.net+vat.tax,
    'private_comment',coalesce(r.private_comment,''),'private_version',coalesce(r.version,0))
  from (values(1)) one(seed) left join lateral (
    select override_kopeks,private_comment,version from garage_pay.task_pricing_revisions
    where task_id=p_task_id order by version desc limit 1
  ) r on true
  cross join lateral (select coalesce(r.override_kopeks,p_catalogue_kopeks) as net) price
  cross join lateral (select case when price.net=0 then 0 else round(price.net*p_vat_rate)::bigint end as tax) vat
$$;

-- Equal work is divided in currency units. Displayed percentages receive their
-- own rounding remainder; calculation from rounded percentages would skew pay.
create function garage_pay.equal_shares(p_task_id uuid,p_pool_kopeks bigint)
returns jsonb language sql stable set search_path=pg_catalog as $$
  with roster as (
    select c.*,row_number() over(order by mechanic_id) as n,count(*) over() as total
    from garage_pay.candidates(p_task_id) c where not former
  )
  select coalesce(jsonb_agg(jsonb_build_object('mechanic_id',mechanic_id,'name',name,'former',false,
    'basis_points',10000/total+(n<=10000%total)::int,
    'kopeks',p_pool_kopeks/total+(n<=p_pool_kopeks%total)::int) order by mechanic_id),'[]'::jsonb)
  from roster
$$;

create function garage_pay.payout(p_task_id uuid,p_catalogue_kopeks bigint)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('version',i.version,'pool_kopeks',r.pool_kopeks,'shares',coalesce(r.shares,'[]'::jsonb),
    'equal_split',coalesce((r.request_payload->>'equal_split')::boolean,false),
    'suggested_pool_kopeks',p_catalogue_kopeks,'suggested_shares',garage_pay.equal_shares(i.task_id,p_catalogue_kopeks))
  from garage_pay.items i left join garage_pay.revisions r on r.task_id=i.task_id and r.version=i.version
  where i.task_id=p_task_id
$$;

-- Keep the original quote/validation contract as the source of snapshot values.
alter function public.garage_quote_order(text,jsonb,uuid) set schema garage_pay;
alter function garage_pay.garage_quote_order(text,jsonb,uuid) rename to catalogue_quote;
alter function public.garage_order_financials(uuid) set schema garage_pay;
alter function garage_pay.garage_order_financials(uuid) rename to catalogue_financials;

create function garage_pay.quote(p_vehicle_group_code text,p_tasks jsonb,p_order_id uuid) returns jsonb
language plpgsql security definer stable set search_path=pg_catalog as $$
declare snapshot jsonb:=garage_pay.catalogue_quote(p_vehicle_group_code,p_tasks,p_order_id);
  items jsonb; effective_total bigint; effective_tax bigint; effective_gross bigint;
begin
  with quoted as (
    select q.item, q.pos, p_tasks->(q.pos::int-1) as requested
    from jsonb_array_elements(snapshot->'items') with ordinality q(item,pos)
  ), enriched as (
    select q.pos,q.item||garage_pay.price_fields(retained.id,((q.item->>'net_amount')::numeric*100)::bigint,
      case when retained.id is not null then retained.vat_rate else active_price.vat_rate end) as item
    from quoted q left join lateral (
      select t.id,f.vat_rate from public.garage_order_tasks t join public.garage_orders o on o.id=t.order_id
      left join public.garage_task_financials f on f.task_id=t.id
      where t.id=nullif(q.item->>'task_id','')::uuid and o.id=p_order_id and o.vehicle_group_code=p_vehicle_group_code
        and t.work_code=q.requested->>'work_code' and t.options=coalesce(q.requested->'options','{}'::jsonb)
    ) retained on true
    left join lateral (
      select l.vat_rate from public.garage_price_lists l join public.garage_price_matrix m on m.price_list_id=l.id
      where l.status='active' and l.effective_date<=current_date and m.vehicle_group_code=p_vehicle_group_code
        and m.work_code=q.item->>'work_code'
    ) active_price on retained.id is null
  )
  select coalesce(jsonb_agg(item order by pos),'[]'::jsonb),
    case when count(*)=count(item->>'effective_kopeks') then coalesce(sum((item->>'effective_kopeks')::bigint),0) end,
    case when count(*)=count(item->>'effective_tax_kopeks') then coalesce(sum((item->>'effective_tax_kopeks')::bigint),0) end,
    case when count(*)=count(item->>'effective_gross_kopeks') then coalesce(sum((item->>'effective_gross_kopeks')::bigint),0) end
    into items,effective_total,effective_tax,effective_gross from enriched;
  return snapshot||jsonb_build_object('items',items,'effective_total_kopeks',effective_total,
    'effective_tax_kopeks',effective_tax,'effective_gross_kopeks',effective_gross);
end $$;

create function garage_pay.order_financials(p_order_id uuid) returns jsonb
language plpgsql security definer stable set search_path=pg_catalog as $$
declare snapshot jsonb:=garage_pay.catalogue_financials(p_order_id);
  items jsonb; effective_total bigint; effective_tax bigint; effective_gross bigint;
begin
  with enriched as (
    select q.pos,q.item||garage_pay.price_fields(t.id,amount.kopeks,f.vat_rate)||jsonb_build_object('work_code',t.work_code,
      'payout',garage_pay.payout(t.id,amount.kopeks)) as item
    from jsonb_array_elements(snapshot->'tasks') with ordinality q(item,pos)
    join public.garage_order_tasks t on t.id=(q.item->>'task_id')::uuid
    left join public.garage_task_financials f on f.task_id=t.id
    cross join lateral (select ((q.item->>'net_amount')::numeric*100)::bigint as kopeks) amount
  )
  select coalesce(jsonb_agg(item order by pos),'[]'::jsonb),
    case when count(*)=count(item->>'effective_kopeks') then coalesce(sum((item->>'effective_kopeks')::bigint),0) end,
    case when count(*)=count(item->>'effective_tax_kopeks') then coalesce(sum((item->>'effective_tax_kopeks')::bigint),0) end,
    case when count(*)=count(item->>'effective_gross_kopeks') then coalesce(sum((item->>'effective_gross_kopeks')::bigint),0) end
    into items,effective_total,effective_tax,effective_gross from enriched;
  return snapshot||jsonb_build_object('tasks',items,'effective_total_kopeks',effective_total,
    'effective_tax_kopeks',effective_tax,'effective_gross_kopeks',effective_gross);
end $$;

create or replace function garage_pay.worklist() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('task_id',i.task_id,'order_id',o.id,'order_number',o.order_number,
      'vehicle',o.vehicle,'work_name',c.work_name,'options',t.options,'completed_at',c.completed_at,
      'candidates',(select jsonb_agg(to_jsonb(p) order by p.former,p.name,p.mechanic_id) from garage_pay.candidates(i.task_id) p))
      || garage_pay.price_fields(i.task_id,(f.net_amount*100)::bigint,f.vat_rate)
      || garage_pay.payout(i.task_id,(f.net_amount*100)::bigint)
      order by c.completed_at desc,i.task_id),'[]'::jsonb)
    from garage_pay.items i join public.garage_task_completions c on c.task_id=i.task_id
    join public.garage_orders o on o.id=c.order_id join public.garage_order_tasks t on t.id=i.task_id
    left join public.garage_task_financials f on f.task_id=i.task_id
  );
end $$;

create or replace function garage_pay.history(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('version',r.version,'actor_name',p.name,'saved_at',r.saved_at,
    'pool_kopeks',r.pool_kopeks,'shares',r.shares,'reason',r.reason,
    'equal_split',coalesce((r.request_payload->>'equal_split')::boolean,false)) order by r.version desc),'[]'::jsonb)
    from garage_pay.revisions r join public.profiles p on p.id=r.actor_id where r.task_id=p_task_id);
end $$;

-- The existing 7-argument RPC continues to honour explicitly entered percentages.
create function garage_pay.save(p_task_id uuid,p_expected_version integer,p_pool_kopeks bigint,p_shares jsonb,
  p_reason text,p_zero_confirmed boolean,p_request_id uuid,p_equal_split boolean) returns integer
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=public.garage_lock_actor(); reason_text text:=btrim(coalesce(p_reason,''));
  payload jsonb; receipt garage_pay.revisions%rowtype; current_version integer; amounts jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  if p_equal_split is false then
    return garage_pay.save(p_task_id,p_expected_version,p_pool_kopeks,p_shares,p_reason,p_zero_confirmed,p_request_id);
  end if;
  if p_equal_split is null or p_request_id is null or p_expected_version is null or p_expected_version<0
    or p_pool_kopeks is null or p_pool_kopeks not between 0 and 999999999999 or (p_pool_kopeks=0 and p_zero_confirmed is not true)
    or jsonb_typeof(p_shares) is distinct from 'array' or length(reason_text)>2000 then
    raise exception using errcode='22023',message='Invalid equal allocation.';
  end if;
  payload:=jsonb_build_object('task',p_task_id,'version',p_expected_version,'pool',p_pool_kopeks,
    'shares',p_shares,'reason',reason_text,'zero_confirmed',p_zero_confirmed,'equal_split',true);
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,0));
  select * into receipt from garage_pay.revisions where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.request_payload<>payload then raise exception using errcode='22023',message='Request ID reused with different values.'; end if;
    return receipt.version;
  end if;
  select version into current_version from garage_pay.items where task_id=p_task_id for update;
  if not found then raise exception using errcode='22023',message='Completed work unavailable for allocation.'; end if;
  if current_version<>p_expected_version then raise exception using errcode='40001',message='Allocation changed.'; end if;
  if current_version>0 and reason_text='' then raise exception using errcode='22023',message='Explain the correction.'; end if;
  amounts:=garage_pay.equal_shares(p_task_id,p_pool_kopeks);
  if amounts='[]'::jsonb or (select jsonb_agg(x order by x->>'mechanic_id') from jsonb_array_elements(p_shares) x)
     is distinct from (select jsonb_agg(x-'name'-'former'-'kopeks' order by x->>'mechanic_id') from jsonb_array_elements(amounts) x) then
    raise exception using errcode='22023',message='Equal allocations require the displayed final roster and shares.';
  end if;
  insert into garage_pay.revisions(task_id,version,actor_id,pool_kopeks,shares,reason,request_id,request_payload)
    values(p_task_id,current_version+1,actor,p_pool_kopeks,amounts,reason_text,p_request_id,payload);
  update garage_pay.items set version=current_version+1 where task_id=p_task_id;
  return current_version+1;
end $$;

create function public.garage_save_task_pricing(p_task_id uuid,p_expected_version integer,p_override_kopeks bigint,
  p_private_comment text,p_request_id uuid) returns integer language sql security invoker set search_path=pg_catalog
  as $$ select garage_pay.save_task_pricing(p_task_id,p_expected_version,p_override_kopeks,p_private_comment,p_request_id) $$;
create function public.garage_quote_order(p_vehicle_group_code text,p_tasks jsonb,p_order_id uuid default null)
  returns jsonb language sql stable security invoker set search_path=pg_catalog
  as $$ select garage_pay.quote(p_vehicle_group_code,p_tasks,p_order_id) $$;
create function public.garage_order_financials(p_order_id uuid) returns jsonb language sql stable security invoker set search_path=pg_catalog
  as $$ select garage_pay.order_financials(p_order_id) $$;
create function public.garage_pay_save(p_task_id uuid,p_expected_version integer,p_pool_kopeks bigint,p_shares jsonb,
  p_reason text,p_zero_confirmed boolean,p_request_id uuid,p_equal_split boolean) returns integer
  language sql security invoker set search_path=pg_catalog
  as $$ select garage_pay.save(p_task_id,p_expected_version,p_pool_kopeks,p_shares,p_reason,p_zero_confirmed,p_request_id,p_equal_split) $$;

revoke all on function garage_pay.catalogue_quote(text,jsonb,uuid),garage_pay.catalogue_financials(uuid),
  garage_pay.price_fields(uuid,bigint,numeric),garage_pay.equal_shares(uuid,bigint),garage_pay.payout(uuid,bigint),
  garage_pay.quote(text,jsonb,uuid),garage_pay.order_financials(uuid),garage_pay.save_task_pricing(uuid,integer,bigint,text,uuid),
  garage_pay.save(uuid,integer,bigint,jsonb,text,boolean,uuid,boolean),public.garage_quote_order(text,jsonb,uuid),
  public.garage_order_financials(uuid),public.garage_save_task_pricing(uuid,integer,bigint,text,uuid),
  public.garage_pay_save(uuid,integer,bigint,jsonb,text,boolean,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function garage_pay.quote(text,jsonb,uuid),garage_pay.order_financials(uuid),
  garage_pay.save_task_pricing(uuid,integer,bigint,text,uuid),garage_pay.save(uuid,integer,bigint,jsonb,text,boolean,uuid,boolean),
  public.garage_quote_order(text,jsonb,uuid),public.garage_order_financials(uuid),
  public.garage_save_task_pricing(uuid,integer,bigint,text,uuid),public.garage_pay_save(uuid,integer,bigint,jsonb,text,boolean,uuid,boolean)
  to authenticated;
insert into public.garage_schema_migrations(version) values('20261118185004');
notify pgrst,'reload schema';
commit;
