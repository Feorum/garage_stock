begin;

-- The workshop preference is copied when an order is inserted, including orders published by the sheet reader.
create table garage_pay.basis_preference (
  singleton boolean primary key default true check(singleton),
  basis text not null check (basis in ('catalogue','agreed'))
);
insert into garage_pay.basis_preference values(true,'catalogue');
create table garage_pay.commercial_terms (
  order_id uuid primary key references public.garage_orders(id),
  agreed_total_kopeks bigint check (agreed_total_kopeks between 0 and 999999999999),
  basis text not null check (basis in ('catalogue','agreed')),
  version integer not null default 0 check(version >= 0)
);
alter table garage_pay.basis_preference enable row level security;
alter table garage_pay.commercial_terms enable row level security;
revoke all on garage_pay.basis_preference, garage_pay.commercial_terms from public,anon,authenticated,service_role;
lock table public.garage_orders in share row exclusive mode;
insert into garage_pay.commercial_terms(order_id,basis) select id,'catalogue' from public.garage_orders;
create function garage_pay.init_commercial_terms() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  insert into garage_pay.commercial_terms(order_id,basis)
    select new.id,basis from garage_pay.basis_preference where singleton;
  return new;
end $$;
create trigger init_commercial_terms after insert on public.garage_orders
for each row execute function garage_pay.init_commercial_terms();

create function garage_pay.save_commercial(p_order_id uuid,p_expected_version integer,
  p_agreed_total_kopeks bigint,p_basis text) returns integer
language plpgsql security definer set search_path=pg_catalog as $$
declare saved garage_pay.commercial_terms%rowtype;
begin
  perform public.garage_lock_actor();
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  if p_basis is null or p_basis not in ('catalogue','agreed') or p_agreed_total_kopeks not between 0 and 999999999999
    or p_expected_version is null or p_expected_version<0 then raise exception using errcode='22023',message='Invalid commercial terms.'; end if;
  perform id from public.garage_orders where id=p_order_id and status <> 'cancelled' for update;
  if not found then raise exception using errcode='22023',message='Standard order unavailable.'; end if;
  select * into strict saved from garage_pay.commercial_terms where order_id=p_order_id;
  if saved.agreed_total_kopeks is not distinct from p_agreed_total_kopeks and saved.basis=p_basis then return saved.version; end if;
  if saved.version<>p_expected_version then raise exception using errcode='40001',message='Commercial terms changed.'; end if;
  update garage_pay.commercial_terms set agreed_total_kopeks=p_agreed_total_kopeks,basis=p_basis,version=version+1
    where order_id=p_order_id returning version into saved.version;
  update garage_pay.basis_preference set basis=p_basis where singleton;
  return saved.version;
end $$;
create function public.garage_save_commercial(p_order_id uuid,p_expected_version integer,p_agreed_total_kopeks bigint,p_basis text)
returns integer language sql security invoker set search_path=pg_catalog as $$
  select garage_pay.save_commercial(p_order_id,p_expected_version,p_agreed_total_kopeks,p_basis)
$$;

-- Both the negotiated total and its 80% internal budget use a largest-remainder allocation in kopeks.
-- Null means an allocation needs a price; a genuine zero retains its meaning, including promotional gifts.
create function garage_pay.commercial_lines(p_order_id uuid)
returns table(task_id uuid,catalogue_kopeks bigint,customer_kopeks bigint,basis_kopeks bigint,internal_price_kopeks bigint)
language sql stable set search_path=pg_catalog as $$
  with prices as (
    select t.id,t.created_at,(f.net_amount*100)::bigint as catalogue,
      coalesce(r.override_kopeks,(f.net_amount*100)::bigint) as listed,c.basis,c.agreed_total_kopeks as agreed
    from public.garage_order_tasks t join garage_pay.commercial_terms c on c.order_id=t.order_id
    left join public.garage_task_financials f on f.task_id=t.id
    left join lateral (select override_kopeks from garage_pay.task_pricing_revisions where task_id=t.id order by version desc limit 1) r on true
    where t.order_id=p_order_id and t.status<>'cancelled'
  ), weights as (
    select *,sum(listed) over() as denominator,count(*) over()=count(listed) over() as known from prices
  ), portions as (
    select *,case when agreed is null then listed when agreed=0 then 0
      when known then div(agreed::numeric*listed,nullif(denominator,0))::bigint end as whole,
      mod(agreed::numeric*listed,nullif(denominator,0)) as remainder from weights
  ), customers as (
    select *,case when agreed is null then listed else whole+
      (row_number() over(order by remainder desc nulls last,created_at,id)<=agreed-sum(whole) over())::int end as customer from portions
  ), basis_values as (
    select *,case when basis='catalogue' then catalogue else customer end as chosen from customers
  ), budgets as (
    select *,div(chosen::numeric*4,5)::bigint as whole_budget,mod(chosen::numeric*4,5) as fraction from basis_values
  )
  select id,catalogue,customer,chosen,whole_budget+
    (row_number() over(order by fraction desc nulls last,created_at,id)<=round(sum(chosen) over()*0.8)-sum(whole_budget) over())::int
  from budgets order by created_at,id
$$;

-- Whole-order accounting can still have a known budget when individual weights are missing.
-- This private helper is also safe to call from close triggers without an authenticated session.
create function garage_pay.internal_total_kopeks(p_order_id uuid) returns bigint
language sql stable set search_path=pg_catalog as $$
  select case when c.basis='agreed' and c.agreed_total_kopeks is not null then round(c.agreed_total_kopeks*0.8)::bigint
    else (select case when count(*)=count(l.internal_price_kopeks) then coalesce(sum(l.internal_price_kopeks),0)::bigint end
      from garage_pay.commercial_lines(c.order_id) l) end
  from garage_pay.commercial_terms c where c.order_id=p_order_id
$$;

create function garage_pay.commercial_financials(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare original jsonb:=garage_pay.order_financials(p_order_id); terms garage_pay.commercial_terms%rowtype;
  rows jsonb; total bigint; tax bigint; gross bigint; catalogue_total bigint; basis_total bigint;
begin
  select * into strict terms from garage_pay.commercial_terms where order_id=p_order_id;
  with items as (
    select x.item,x.pos,l.*,f.vat_rate,case when l.customer_kopeks=0 then 0 else round(l.customer_kopeks*f.vat_rate)::bigint end as tax
    from jsonb_array_elements(original->'tasks') with ordinality x(item,pos)
    join garage_pay.commercial_lines(p_order_id) l on l.task_id=(x.item->>'task_id')::uuid
    left join public.garage_task_financials f on f.task_id=l.task_id
  )
  select coalesce(jsonb_agg(item||jsonb_build_object('listed_kopeks',item->'effective_kopeks','effective_kopeks',customer_kopeks,
    'effective_tax_kopeks',items.tax,'effective_gross_kopeks',customer_kopeks+items.tax,'internal_price_kopeks',internal_price_kopeks) order by pos),'[]'::jsonb),
    case when count(*)=count(customer_kopeks) then coalesce(sum(customer_kopeks),0) end,
    case when count(*)=count(items.tax) then coalesce(sum(items.tax),0) end,
    case when count(*)=count(customer_kopeks+items.tax) then coalesce(sum(customer_kopeks+items.tax),0) end,
    case when count(*)=count(catalogue_kopeks) then coalesce(sum(catalogue_kopeks),0) end,
    case when count(*)=count(basis_kopeks) then coalesce(sum(basis_kopeks),0) end
    into rows,total,tax,gross,catalogue_total,basis_total from items;
  if terms.agreed_total_kopeks is not null and terms.basis='agreed' then
    basis_total:=terms.agreed_total_kopeks;
  end if;
  return original||jsonb_build_object('tasks',rows,'effective_total_kopeks',coalesce(terms.agreed_total_kopeks,total),
    'effective_tax_kopeks',tax,'effective_gross_kopeks',gross,'commercial',jsonb_build_object(
      'agreed_total_kopeks',terms.agreed_total_kopeks,'basis',terms.basis,'version',terms.version,
      'catalogue_total_kopeks',catalogue_total,'basis_total_kopeks',basis_total,'internal_total_kopeks',garage_pay.internal_total_kopeks(p_order_id)));
end $$;
create or replace function public.garage_order_financials(p_order_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
  select garage_pay.commercial_financials(p_order_id)
$$;

-- The order editor previews prospective work lines, retaining a negotiated order total when one exists.
create function garage_pay.commercial_quote(p_vehicle_group_code text,p_tasks jsonb,p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare original jsonb:=garage_pay.quote(p_vehicle_group_code,p_tasks,p_order_id); agreed bigint;
begin
  select agreed_total_kopeks into agreed from garage_pay.commercial_terms where order_id=p_order_id;
  if agreed is null then return original; end if;
  return original||jsonb_build_object('agreed_total_kopeks',agreed);
end $$;
create or replace function public.garage_quote_order(p_vehicle_group_code text,p_tasks jsonb,p_order_id uuid default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
  select garage_pay.commercial_quote(p_vehicle_group_code,p_tasks,p_order_id)
$$;

create or replace function garage_pay.owner_review_prices(p_order_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if not public.garage_is_owner() then
    raise exception using errcode='42501', message='Owner access required.';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) > 100 then
    raise exception using errcode='22023', message='Specify up to 100 orders.';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc, r.order_id), '[]'::jsonb)
    from (
      select o.id as order_id, o.created_at, o.closed_at,
             coalesce(jsonb_agg(jsonb_build_object(
               'task_id', t.id, 'net_kopeks', (f.net_amount * 100)::bigint,
               'effective_kopeks', line.customer_kopeks
             ) order by t.created_at, t.id) filter (where t.id is not null), '[]'::jsonb) as tasks
      from public.garage_orders o
      left join lateral garage_pay.commercial_lines(o.id) line on true
      left join public.garage_order_tasks t on t.id=line.task_id
      left join public.garage_task_financials f on f.task_id = t.id
      where o.id = any(p_order_ids)
      group by o.id
    ) r
  );
end $$;

-- Existing documents retain their numbers and default layout. New downloads record the exact prices used.
alter table garage_act.documents add column pricing_snapshot jsonb,
  add column act_format text not null default 'weighted' check(act_format in ('weighted','discount','names'));
alter function garage_act.get_document(uuid) rename to document_fields;
create function garage_act.get_document(p_order_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
  select garage_act.document_fields(p_order_id)||jsonb_build_object('act_format',coalesce(d.act_format,'weighted'),
    'pricing_snapshot',d.pricing_snapshot)
  from (values(1)) seed(n) left join garage_act.documents d on d.order_id=p_order_id
$$;
create or replace function public.garage_act_get(p_order_id uuid) returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$ select garage_act.get_document(p_order_id) $$;

create function garage_act.price_quote(p_order_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('listed',jsonb_object_agg(t.id,x.item->'listed_kopeks'),
    'allocated',jsonb_object_agg(t.id,x.item->'effective_kopeks'),'agreed_total_kopeks',f.value->'commercial'->'agreed_total_kopeks')
  from (select garage_pay.commercial_financials(p_order_id) as value) f
  cross join lateral jsonb_array_elements(f.value->'tasks') x(item)
  join public.garage_order_tasks t on t.id=(x.item->>'task_id')::uuid and t.status='completed'
  group by f.value->'commercial'->'agreed_total_kopeks'
$$;
create or replace function garage_act.save_document(p_order_id uuid,p_number text,p_contract_number text,p_contract_date date,
    p_act_date date,p_expected_version integer,p_expected_order_version integer,p_expected_amounts jsonb,p_vin text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
  current_doc garage_act.documents%rowtype;
  previous_number text;
  expected_chunks integer;
  order_vin text;
  order_version integer;
  amounts jsonb;
  quote jsonb;
  requested_format text:='weighted';
  use_snapshot boolean:=p_expected_amounts ? 'quote';
  agreed bigint;
  listed_sum bigint;
  number_input text:=btrim(p_number);
  contract_input text:=btrim(p_contract_number);
  vin_input text;
begin
  perform public.garage_lock_actor();
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  select o.vin,o.version into order_vin,order_version from public.garage_orders o where o.id=p_order_id and o.status='closed' for update;
  if not found then raise exception using errcode='22023',message='Choose a closed order.'; end if;
  select * into current_doc from garage_act.documents where order_id=p_order_id;
  vin_input:=btrim(coalesce(p_vin,current_doc.vin,order_vin));
  if p_expected_version is null or p_expected_version<0 or number_input is null
    or number_input !~ '^[1-9][0-9]{0,14}/(0[1-9]|1[0-2])$' or split_part(number_input,'/',2)<>to_char(p_act_date,'MM')
    or coalesce(length(contract_input),0) not between 1 and 120
    or contract_input ~ '[[:cntrl:]]' or coalesce(length(vin_input),0) not between 1 and 40 or vin_input ~ '[[:cntrl:]]'
    or p_contract_date is null or p_act_date is null or p_act_date not between date '0001-01-01' and date '9999-12-31'
    or p_contract_date not between date '0001-01-01' and date '9999-12-31' then
    raise exception using errcode='22023',message='Check the act number, VIN and contract fields.';
  end if;
  -- A price writer locks its task. Keep the order and its completed tasks stable
  -- while comparing the customer amounts used to generate this exact download.
  perform t.id from public.garage_order_tasks t where t.order_id=p_order_id and t.status='completed' order by t.id for share;
  if use_snapshot then
    requested_format:=p_expected_amounts->>'mode';
    quote:=coalesce(current_doc.pricing_snapshot,garage_act.price_quote(p_order_id));
    if quote is null then raise exception using errcode='22023',message='Completed work required.'; end if;
    if p_expected_amounts->'quote' is distinct from quote then raise exception using errcode='40001',message='Act prices changed.'; end if;
    agreed:=(quote->>'agreed_total_kopeks')::bigint;
    if requested_format is null or requested_format not in ('weighted','discount','names')
      or (agreed is null and requested_format<>'weighted') then
      raise exception using errcode='22023',message='Choose an available act format.'; end if;
    if requested_format='weighted' then
      select case when count(*)=count(value) then sum(value::bigint) end into listed_sum from jsonb_each_text(quote->'allocated');
      if listed_sum is null or (agreed is not null and agreed<>listed_sum) then
        raise exception using errcode='22023',message='Weighted work must add up to the agreed total.'; end if;
    end if;
    if requested_format='discount' then
      select case when count(*)=count(value) then sum(value::bigint) end into listed_sum from jsonb_each_text(quote->'listed');
      if listed_sum is null or listed_sum<agreed then
        raise exception using errcode='22023',message='A discount requires a complete listed total at least as large as the agreed price.'; end if;
    end if;
  else
    -- Cached applications know only an itemised act. Never let them issue a different agreed amount.
    quote:=garage_act.price_quote(p_order_id);
    if current_doc.pricing_snapshot is not null or quote->>'agreed_total_kopeks' is not null then
      raise exception using errcode='40001',message='Reload the application to issue this act.'; end if;
    amounts:=quote->'allocated';
    if amounts is null or exists(select from jsonb_each(amounts) e where e.value='null'::jsonb) then
      raise exception using errcode='22023',message='Completed work and its prices are required.'; end if;
    if p_expected_amounts is distinct from amounts then
      raise exception using errcode='40001',message='The order prices changed.'; end if;
  end if;
  if order_version is distinct from p_expected_order_version then
    raise exception using errcode='40001',message='The order changed.'; end if;
  -- Order lock serializes edits to one document. An identical replay after a
  -- lost response returns its current metadata without consuming another number.
  if current_doc.number=number_input and current_doc.contract_number=contract_input and current_doc.vin=vin_input
    and current_doc.contract_date=p_contract_date and current_doc.act_date=p_act_date
    and current_doc.act_format=requested_format and (not use_snapshot or current_doc.pricing_snapshot=quote) then
    return garage_act.get_document(p_order_id);
  end if;
  if coalesce(current_doc.version,0)<>p_expected_version then
    raise exception using errcode='40001',message='The act changed. Reload its current details.';
  end if;
  if current_doc.order_id is null then
    select last_issued_number,template_chunks into previous_number,expected_chunks from garage_act.config where singleton for update;
    if not found then raise exception using errcode='55000',message='The act template has not been configured.'; end if;
    if not exists(select 1 from garage_act.template_parts having count(*)=expected_chunks
        and min(part_index)=0 and max(part_index)=expected_chunks-1) then
      raise exception using errcode='55000',message='The act template is unavailable.';
    end if;
    if split_part(number_input,'/',1)::bigint<=garage_act.last_serial(previous_number) then
      raise exception using errcode='23505',message='Choose a serial above the last issued act.';
    end if;
    insert into garage_act.reserved_numbers(number) values(number_input) on conflict do nothing;
    if not found then raise exception using errcode='23505',message='This act number has already been issued.'; end if;
    insert into garage_act.documents(order_id,number,contract_number,contract_date,act_date,vin,act_format,pricing_snapshot)
      values(p_order_id,number_input,contract_input,p_contract_date,p_act_date,vin_input,requested_format,case when use_snapshot then quote end);
    update garage_act.config set last_issued_number=number_input where singleton;
  else
    if current_doc.number<>number_input then raise exception using errcode='22023',message='Issued act numbers cannot be changed.'; end if;
    update garage_act.documents set contract_number=contract_input,contract_date=p_contract_date,act_date=p_act_date,
      vin=vin_input,act_format=requested_format,pricing_snapshot=case when use_snapshot then quote end,version=version+1 where order_id=p_order_id;
  end if;
  return garage_act.get_document(p_order_id);
end $$;

revoke all on function garage_pay.internal_total_kopeks(uuid),garage_pay.commercial_quote(text,jsonb,uuid),garage_pay.init_commercial_terms(),garage_pay.commercial_lines(uuid),
  garage_pay.commercial_financials(uuid),garage_pay.save_commercial(uuid,integer,bigint,text),
  public.garage_save_commercial(uuid,integer,bigint,text),garage_act.price_quote(uuid),garage_act.document_fields(uuid),
  garage_act.get_document(uuid) from public,anon,authenticated,service_role;
grant execute on function garage_pay.commercial_quote(text,jsonb,uuid),garage_pay.commercial_financials(uuid),garage_pay.save_commercial(uuid,integer,bigint,text),
  public.garage_save_commercial(uuid,integer,bigint,text),garage_act.get_document(uuid) to authenticated;
insert into public.garage_schema_migrations(version) values('20261126145941');
notify pgrst,'reload schema';
commit;
