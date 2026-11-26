begin;

-- Existing workshop and spreadsheet orders all follow the standard workflow.
-- Keep private, free-form owner records out of the mechanic and act APIs.
alter table public.garage_orders add column order_type text not null default 'standard'
  check (order_type = 'standard');

create schema garage_custom;
revoke all on schema garage_custom from public, anon, authenticated, service_role;
grant usage on schema garage_custom to authenticated;

create table garage_custom.orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  version integer not null default 1,
  vehicle text not null check (length(btrim(vehicle)) between 1 and 240),
  services text not null default '' check (length(services) <= 12000),
  visit_date date not null,
  status text not null check (status in ('open','closed')),
  customer_kopeks bigint check (customer_kopeks between 0 and 999999999999),
  payments jsonb not null,
  allocations jsonb not null,
  updated_at timestamptz not null default now()
);
create index custom_owner_date on garage_custom.orders (owner_id, visit_date desc, updated_at desc);
alter table garage_custom.orders enable row level security;
revoke all on garage_custom.orders from public, anon, authenticated, service_role;

-- Both lists use a free-text label and an exact, nonnegative BYN amount.
create function garage_custom.valid_amounts(items jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare item jsonb;
begin
  if jsonb_typeof(items) is distinct from 'array' then return false; end if;
  if jsonb_array_length(items)>200 then return false; end if;
  for item in select value from jsonb_array_elements(items) loop
    if jsonb_typeof(item->'name') is distinct from 'string'
      or length(btrim(item->>'name')) not between 1 and 240
      or jsonb_typeof(item->'kopeks') is distinct from 'number'
      or (item->>'kopeks') !~ '^(0|[1-9][0-9]{0,11})$'
      or (item - 'name' - 'kopeks') <> '{}'::jsonb then return false; end if;
  end loop;
  return true;
end $$;
alter table garage_custom.orders
  add check (garage_custom.valid_amounts(payments)),
  add check (garage_custom.valid_amounts(allocations));

create function garage_custom.read_orders(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  if p_order_id is null then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'vehicle',vehicle,'visit_date',visit_date,'status',status)
      order by visit_date desc, updated_at desc, id),'[]'::jsonb)
      into result from garage_custom.orders where owner_id=auth.uid();
  else
    select (to_jsonb(o)-'owner_id') || '{"order_type":"custom","source":"owner"}'::jsonb into result
      from garage_custom.orders o where o.id=p_order_id and o.owner_id=auth.uid();
    if result is null then raise exception using errcode='42501',message='Order unavailable.'; end if;
  end if;
  return result;
end $$;

create function garage_custom.save_order(p_order_id uuid,p_expected_version integer,p_order jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid := public.garage_lock_actor(); payload jsonb; receipt jsonb; saved_id uuid;
  vehicle_input text := btrim(p_order->>'vehicle');
  visit_input date;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  payload := jsonb_build_object('action','custom_order','order_id',p_order_id,'version',p_expected_version,'order',p_order);
  receipt := public.garage_begin_request(p_request_id,payload);
  if receipt is not null then return receipt; end if;

  if jsonb_typeof(p_order) is distinct from 'object'
    or not (p_order ?& array['vehicle','services','visit_date','status','customer_kopeks','payments','allocations'])
    or (p_order - array['vehicle','services','visit_date','status','customer_kopeks','payments','allocations']) <> '{}'::jsonb
    or jsonb_typeof(p_order->'vehicle') is distinct from 'string' or length(vehicle_input) not between 1 and 240
    or jsonb_typeof(p_order->'services') is distinct from 'string' or length(p_order->>'services')>12000
    or jsonb_typeof(p_order->'visit_date') is distinct from 'string' or (p_order->>'visit_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(p_order->'status') is distinct from 'string' or p_order->>'status' not in ('open','closed')
    or (p_order->'customer_kopeks' <> 'null'::jsonb and (jsonb_typeof(p_order->'customer_kopeks') <> 'number'
      or p_order->>'customer_kopeks' !~ '^(0|[1-9][0-9]{0,11})$'))
    or not garage_custom.valid_amounts(p_order->'payments') or not garage_custom.valid_amounts(p_order->'allocations') then
    raise exception using errcode='22023',message='Invalid custom order.';
  end if;
  visit_input := (p_order->>'visit_date')::date;
  if p_order_id is null then
    if p_expected_version is distinct from 0 then raise exception using errcode='40001',message='Order version changed.'; end if;
    insert into garage_custom.orders(owner_id,vehicle,services,visit_date,status,customer_kopeks,payments,allocations)
      values(actor,vehicle_input,p_order->>'services',visit_input,p_order->>'status',(p_order->>'customer_kopeks')::bigint,
             p_order->'payments',p_order->'allocations') returning id into saved_id;
  else
    update garage_custom.orders set vehicle=vehicle_input, services=p_order->>'services', visit_date=visit_input,
      status=p_order->>'status', customer_kopeks=(p_order->>'customer_kopeks')::bigint, payments=p_order->'payments',
      allocations=p_order->'allocations', version=version+1, updated_at=now()
      where id=p_order_id and owner_id=actor and version=p_expected_version returning id into saved_id;
    if saved_id is null then
      if exists(select 1 from garage_custom.orders where id=p_order_id and owner_id=actor) then
        raise exception using errcode='40001',message='Order version changed.';
      end if;
      raise exception using errcode='42501',message='Order unavailable.';
    end if;
  end if;
  return public.garage_finish_request(p_request_id,payload,garage_custom.read_orders(saved_id));
end $$;

create function public.garage_custom_orders(p_order_id uuid default null) returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$ select garage_custom.read_orders(p_order_id) $$;
create function public.garage_save_custom_order(p_order_id uuid,p_expected_version integer,p_order jsonb,p_request_id uuid) returns jsonb
language sql security invoker set search_path=pg_catalog as $$ select garage_custom.save_order(p_order_id,p_expected_version,p_order,p_request_id) $$;
revoke all on all functions in schema garage_custom from public, anon, authenticated, service_role;
revoke all on function public.garage_custom_orders(uuid), public.garage_save_custom_order(uuid,integer,jsonb,uuid)
  from public, anon, authenticated, service_role;
grant execute on function garage_custom.read_orders(uuid), garage_custom.save_order(uuid,integer,jsonb,uuid),
  public.garage_custom_orders(uuid), public.garage_save_custom_order(uuid,integer,jsonb,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values('20261126145933');
notify pgrst, 'reload schema';
commit;
