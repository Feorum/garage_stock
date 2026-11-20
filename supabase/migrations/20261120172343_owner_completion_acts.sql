begin;

-- The template, its legal parties and issued numbers stay outside the exposed API schema.
create schema garage_act;
revoke all on schema garage_act from public, anon, authenticated, service_role;
grant usage on schema garage_act to authenticated;

create table garage_act.config (
  singleton boolean primary key default true check (singleton),
  customer_name text not null check (length(btrim(customer_name)) > 0),
  contractor_name text not null check (length(btrim(contractor_name)) > 0),
  contract_number text not null check (length(btrim(contract_number)) between 1 and 120),
  contract_date date not null,
  template_chunks integer not null check (template_chunks > 0),
  last_issued_number text check (last_issued_number ~ '^[1-9][0-9]{0,14}/(0[1-9]|1[0-2])$')
);
create table garage_act.template_parts (
  part_index integer primary key check (part_index >= 0),
  data_base64 text not null check (length(data_base64) > 0 and length(data_base64) % 4 = 0)
);
-- One registry covers numbers issued before Garage and every number issued here.
create table garage_act.reserved_numbers (
  number text primary key check (number ~ '^[1-9][0-9]{0,14}/(0[1-9]|1[0-2])$'),
  serial_no bigint generated always as (split_part(number,'/',1)::bigint) stored unique
);
create table garage_act.documents (
  order_id uuid primary key references public.garage_orders(id),
  number text not null unique references garage_act.reserved_numbers(number),
  contract_number text not null check (length(contract_number) between 1 and 120),
  contract_date date not null,
  act_date date not null,
  vin text not null check (length(vin) between 1 and 40),
  version integer not null default 1 check (version > 0)
);
alter table garage_act.config enable row level security;
alter table garage_act.template_parts enable row level security;
alter table garage_act.reserved_numbers enable row level security;
alter table garage_act.documents enable row level security;
revoke all on all tables in schema garage_act from public, anon, authenticated, service_role;

-- Historical acts and every month share one cumulative order serial.
create function garage_act.last_serial(p_last text) returns bigint
language sql stable set search_path=pg_catalog as $$
  select greatest(split_part(p_last,'/',1)::bigint,max(serial_no)) from garage_act.reserved_numbers
$$;

create function garage_act.get_document(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  if not exists(select from public.garage_orders where id=p_order_id and status='closed') then
    raise exception using errcode='22023',message='Choose a closed order.';
  end if;
  select jsonb_build_object(
    'number',d.number,'suggested_number',case when d.order_id is null and s.last_serial<999999999999999 then
      (s.last_serial+1)::text || '/' || to_char(o.closed_at at time zone 'Europe/Minsk','MM') end,
    'version',coalesce(d.version,0),'vin',coalesce(d.vin,o.vin,''),
    'contract_number',coalesce(d.contract_number,c.contract_number),'contract_date',coalesce(d.contract_date,c.contract_date),
    'act_date',coalesce(d.act_date,(o.closed_at at time zone 'Europe/Minsk')::date),
    'customer_name',c.customer_name,'contractor_name',c.contractor_name)
    into result from public.garage_orders o cross join garage_act.config c
    cross join lateral (select garage_act.last_serial(c.last_issued_number) as last_serial) s
    left join garage_act.documents d on d.order_id=o.id where o.id=p_order_id;
  if result is null then raise exception using errcode='55000',message='The act template has not been configured.'; end if;
  return result;
end $$;

create function garage_act.template() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare parts jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  select jsonb_agg(part.data_base64 order by part.part_index) into parts
    from garage_act.template_parts part cross join garage_act.config c group by c.template_chunks
    having count(*)=c.template_chunks and min(part.part_index)=0 and max(part.part_index)=c.template_chunks-1;
  if parts is null then raise exception using errcode='55000',message='The act template is unavailable.'; end if;
  return parts;
end $$;

create function garage_act.save_document(p_order_id uuid,p_number text,p_contract_number text,p_contract_date date,
    p_act_date date,p_expected_version integer,p_expected_order_version integer,p_expected_amounts jsonb,p_vin text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
  current_doc garage_act.documents%rowtype;
  previous_number text;
  expected_chunks integer;
  order_vin text;
  order_version integer;
  amounts jsonb;
  all_priced boolean;
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
  select jsonb_object_agg(t.id,x->'effective_kopeks'),bool_and(x->>'effective_kopeks' is not null)
    into amounts,all_priced from public.garage_order_tasks t
    left join jsonb_array_elements(garage_pay.order_financials(p_order_id)->'tasks') x on (x->>'task_id')::uuid=t.id
    where t.order_id=p_order_id and t.status='completed';
  if amounts is null or all_priced is not true then
    raise exception using errcode='22023',message='Completed work and its agreed prices are required.';
  end if;
  if order_version is distinct from p_expected_order_version or amounts is distinct from p_expected_amounts then
    raise exception using errcode='40001',message='The order or its customer prices changed.';
  end if;
  -- Order lock serializes edits to one document. An identical replay after a
  -- lost response returns its current metadata without consuming another number.
  if current_doc.number=number_input and current_doc.contract_number=contract_input and current_doc.vin=vin_input
    and current_doc.contract_date=p_contract_date and current_doc.act_date=p_act_date then
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
    insert into garage_act.documents(order_id,number,contract_number,contract_date,act_date,vin)
      values(p_order_id,number_input,contract_input,p_contract_date,p_act_date,vin_input);
    update garage_act.config set last_issued_number=number_input where singleton;
  else
    if current_doc.number<>number_input then raise exception using errcode='22023',message='Issued act numbers cannot be changed.'; end if;
    update garage_act.documents set contract_number=contract_input,contract_date=p_contract_date,act_date=p_act_date,
      vin=vin_input,version=version+1 where order_id=p_order_id;
  end if;
  return garage_act.get_document(p_order_id);
end $$;

create function public.garage_act_get(p_order_id uuid) returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$
  select garage_act.get_document(p_order_id)
$$;
create function public.garage_act_template() returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$
  select garage_act.template()
$$;
create function public.garage_act_save(p_order_id uuid,p_number text,p_contract_number text,p_contract_date date,
    p_act_date date,p_expected_version integer,p_expected_order_version integer,p_expected_amounts jsonb,p_vin text default null) returns jsonb
language sql security invoker set search_path=pg_catalog as $$
  select garage_act.save_document(p_order_id,p_number,p_contract_number,p_contract_date,p_act_date,p_expected_version,
    p_expected_order_version,p_expected_amounts,p_vin)
$$;

revoke all on all functions in schema garage_act from public, anon, authenticated, service_role;
revoke all on function public.garage_act_get(uuid),public.garage_act_template(),
  public.garage_act_save(uuid,text,text,date,date,integer,integer,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function garage_act.get_document(uuid),garage_act.template(),garage_act.save_document(uuid,text,text,date,date,integer,integer,jsonb,text),
  public.garage_act_get(uuid),public.garage_act_template(),public.garage_act_save(uuid,text,text,date,date,integer,integer,jsonb,text) to authenticated;
insert into public.garage_schema_migrations(version) values('20261120172343');
notify pgrst,'reload schema';
commit;
