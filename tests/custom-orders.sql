begin;
insert into auth.users(id,email) values
  ('cc000000-0000-4000-8000-000000000001','custom-owner@example.invalid'),
  ('cc000000-0000-4000-8000-000000000002','custom-other-owner@example.invalid'),
  ('cc000000-0000-4000-8000-000000000003','custom-mechanic@example.invalid');
update public.profiles set role='admin' where id in (
  'cc000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002');
insert into public.garage_orders(vehicle,vehicle_group_code,source,status,created_by)
  values('Standard fixture vehicle','VG01','manager','published','cc000000-0000-4000-8000-000000000001');
do $$begin
  if not exists(select from public.garage_orders where vehicle='Standard fixture vehicle' and order_type='standard')
    or has_table_privilege('authenticated','garage_custom.orders','select')
    or has_function_privilege('anon','public.garage_custom_orders(uuid)','execute') then
    raise exception 'Standard default or private privileges regression.';
  end if;
end$$;
set local role authenticated;
set local request.jwt.claim.sub='cc000000-0000-4000-8000-000000000001';
do $$
declare d jsonb := '{"vehicle":"Custom fixture vehicle","visit_date":"2026-11-25","services":"Custom service","status":"open","customer_kopeks":15000,"payments":[{"name":"Outside worker","kopeks":5000}],"allocations":[{"name":"Film","kopeks":1234}]}';
  first_order jsonb; updated jsonb; id uuid; req uuid := gen_random_uuid();
begin
  first_order := public.garage_save_custom_order(null,0,d,req);
  id := (first_order->>'id')::uuid;
  if id is null or first_order->>'version'<>'1' or first_order->>'order_type'<>'custom' or first_order->>'source'<>'owner'
    or first_order <> public.garage_save_custom_order(null,0,d,req)
    or not public.garage_custom_orders() @> jsonb_build_array(jsonb_build_object('id',id))
    or jsonb_array_length(public.garage_custom_orders())<>1
    or public.garage_list_orders()::text like '%Custom fixture%' then raise exception 'Creation or retry regression.'; end if;
  updated := public.garage_save_custom_order(id,1,d || '{"status":"closed","customer_kopeks":14999}',gen_random_uuid());
  if updated->>'version'<>'2' or updated->>'status'<>'closed' or updated<>public.garage_custom_orders(id)
    or updated->'payments'<>d->'payments' or updated->'allocations'<>d->'allocations' then raise exception 'Update/re-open regression.'; end if;
  begin
    perform public.garage_save_custom_order(id,1,d,gen_random_uuid());
    raise exception 'A stale write succeeded.';
  exception when serialization_failure then null; end;
  begin
    perform public.garage_save_custom_order(id,2,d || '{"payments":[{"name":"Outside worker","kopeks":-1}]}',gen_random_uuid());
    raise exception 'Invalid payment was accepted.';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.garage_save_custom_order(id,2,d || '{"source":"manager"}',gen_random_uuid());
    raise exception 'Custom records accepted manager intake.';
  exception when invalid_parameter_value then null; end;
  if to_regprocedure('public.garage_act_get(uuid)') is not null then
    begin
      perform public.garage_act_get(id);
      raise exception 'Custom act available.';
    exception when invalid_parameter_value then null; end;
  end if;
  perform set_config('request.jwt.claim.sub','cc000000-0000-4000-8000-000000000002',true);
  if public.garage_custom_orders()<>'[]'::jsonb then raise exception 'A second owner saw a private order.'; end if;
  begin
    perform public.garage_custom_orders(id);
    raise exception 'A second owner opened a private order.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.garage_save_custom_order(id,2,d,gen_random_uuid());
    raise exception 'A second owner modified a private order.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','cc000000-0000-4000-8000-000000000003',true);
  if public.garage_list_orders()::text like '%Custom fixture%' then raise exception 'Custom orders leaked into a mechanic queue.'; end if;
  begin
    perform public.garage_custom_orders();
    raise exception 'A mechanic saw the owner-only index.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.garage_save_custom_order(null,0,d,gen_random_uuid());
    raise exception 'A mechanic could create a custom order.';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
