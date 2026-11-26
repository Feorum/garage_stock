-- Run after the current migrations in the disposable team fixture.
begin;
create function pg_temp.pay_check(ok boolean, explanation text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'Percentage payroll regression: %',explanation; end if; end $$;
insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by)
  values ('f1000000-0000-4000-8000-000000000001','Payroll example','VG02','manager','00000000-0000-4000-8000-000000000001');
insert into public.garage_order_tasks(id,order_id,work_code,work_name)
  values('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001','W01','Completed test work');

select pg_temp.pay_check(not has_table_privilege('authenticated','garage_payroll.rates','select')
  and not has_function_privilege('anon','public.garage_order_payroll(uuid)','execute'),'private finances');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select public.garage_check_work('f2000000-0000-4000-8000-000000000001',gen_random_uuid());
do $$ begin
  perform public.garage_order_payroll('f1000000-0000-4000-8000-000000000001');
  raise exception 'Mechanic saw payroll'; exception when insufficient_privilege then null; end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select public.garage_check_work('f2000000-0000-4000-8000-000000000001',gen_random_uuid());
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare a uuid:='00000000-0000-4000-8000-000000000002'; b uuid:='00000000-0000-4000-8000-000000000003';
  c uuid:='00000000-0000-4000-8000-000000000004'; ord uuid:='f1000000-0000-4000-8000-000000000001';
  job uuid:='f2000000-0000-4000-8000-000000000001'; v jsonb; before_save jsonb; request_key uuid:=gen_random_uuid();
begin
  perform public.garage_save_task_pricing(job,0,112500,'Published price fixture',gen_random_uuid());
  perform public.garage_save_commercial(ord,0,null,'agreed');
  v:=public.garage_order_payroll(ord);
  perform pg_temp.pay_check(jsonb_array_length(v->'missing_rates')=2,'unknown personal rates reported');
  perform public.garage_save_mechanic_rate(a,'1900-01-01',2500,null,request_key);
  perform public.garage_save_mechanic_rate(a,'1900-01-01',2500,null,request_key);
  perform public.garage_save_mechanic_rate(b,'1900-01-01',1500,null,gen_random_uuid());
  perform public.garage_save_mechanic_rate(b,'2026-12-01',2000,null,gen_random_uuid());
  begin perform public.garage_save_mechanic_rate(a,'1900-01-01',2000,null,gen_random_uuid()); raise exception 'Lost rate update';
  exception when serialization_failure then null; end;
end $$;
reset role;
-- Test the actual work date, independent of the wall clock of this test.
update public.garage_task_completions set completed_at='2026-11-30 20:00:00+00'
  where task_id='f2000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare a uuid:='00000000-0000-4000-8000-000000000002'; b uuid:='00000000-0000-4000-8000-000000000003';
  c uuid:='00000000-0000-4000-8000-000000000004'; ord uuid:='f1000000-0000-4000-8000-000000000001';
  job uuid:='f2000000-0000-4000-8000-000000000001'; v jsonb; token text; key uuid;
begin
  v:=public.garage_order_payroll(ord);
  perform pg_temp.pay_check((v->>'cap_kopeks')::bigint=22500 and (v->>'reserve_kopeks')::bigint=4500
    and (v->'people') @> jsonb_build_array(jsonb_build_object('mechanic_id',a,'kopeks',14100),jsonb_build_object('mechanic_id',b,'kopeks',8400)),
    '25:15 split and separate 5 percent reserve: '||v::text);
  key:=gen_random_uuid(); token:=v->>'token';
  v:=public.garage_save_order_payroll(ord,token,array[c],array[c],'[]',null,null,key);
  perform pg_temp.pay_check((v->'people') @> jsonb_build_array(jsonb_build_object('mechanic_id',a,'kopeks',11600),
    jsonb_build_object('mechanic_id',b,'kopeks',5500),jsonb_build_object('mechanic_id',c,'kopeks',5400)),'two external helper duties');
  perform pg_temp.pay_check(v=public.garage_save_order_payroll(ord,token,array[c],array[c],'[]',null,null,key),'safe request replay');
  begin perform public.garage_save_order_payroll(ord,token,'{}','{}','[]',null,null,gen_random_uuid()); raise exception 'Lost payroll update';
  exception when serialization_failure then null; end;
  begin perform public.garage_save_order_payroll(ord,v->>'token',array[gen_random_uuid()],'{}','[]',null,null,gen_random_uuid());
    raise exception 'Unknown assigned helper'; exception when invalid_parameter_value then null; end;
  v:=public.garage_save_order_payroll(ord,v->>'token',array[a],array[c],'[]',null,null,gen_random_uuid());
  perform pg_temp.pay_check((v->'people') @> jsonb_build_array(jsonb_build_object('mechanic_id',a,'kopeks',14100),
    jsonb_build_object('mechanic_id',b,'kopeks',5700),jsonb_build_object('mechanic_id',c,'kopeks',2700)),'one internal helper');
  v:=public.garage_save_order_payroll(ord,v->>'token',array[a],array[b],'[]',null,null,gen_random_uuid());
  perform pg_temp.pay_check((v->'people') @> jsonb_build_array(jsonb_build_object('mechanic_id',a,'kopeks',14600),
    jsonb_build_object('mechanic_id',b,'kopeks',7900)),'internal mixed roles');
  v:=public.garage_save_order_payroll(ord,v->>'token','{}','{}',jsonb_build_array(jsonb_build_object('mechanic_id',a,'kopeks',15100)),null,null,gen_random_uuid());
  perform pg_temp.pay_check(v->>'excess_kopeks'='1000' and v->>'total_kopeks'='23500','manual cap exception');
  v:=public.garage_save_order_payroll(ord,v->>'token','{}','{}',jsonb_build_array(jsonb_build_object('mechanic_id',a,'kopeks',11700)),null,null,gen_random_uuid());
  perform pg_temp.pay_check(v->>'total_kopeks'='20100' and v->>'additional_kopeks'='0','remainder waits for close');
end $$;
reset role;
-- Close through the real workflow to verify end-of-order settlement.
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select public.garage_submit_work('f1000000-0000-4000-8000-000000000001',(select (o->>'version')::int
  from jsonb_array_elements(public.garage_list_orders()) o where o->>'id'='f1000000-0000-4000-8000-000000000001'),gen_random_uuid(),'');
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select public.garage_vehicle_action('f1000000-0000-4000-8000-000000000001','close',(select (o->>'version')::int
  from jsonb_array_elements(public.garage_list_orders()) o where o->>'id'='f1000000-0000-4000-8000-000000000001'),gen_random_uuid(),'');
do $$ declare ord uuid:='f1000000-0000-4000-8000-000000000001'; a uuid:='00000000-0000-4000-8000-000000000002'; v jsonb;
begin
  v:=public.garage_order_payroll(ord);
  perform pg_temp.pay_check(v->>'reserve_kopeks'='4500' and v->>'additional_kopeks'='2400' and v#>>'{history,0,operation}'='close','separate reserve postings at closure');
  perform public.garage_save_mechanic_rate(a,'1900-01-01',1400,2500,gen_random_uuid());
  perform pg_temp.pay_check(public.garage_order_payroll(ord)=v,'closed snapshot remains fixed across later rate revisions');
  perform public.garage_save_commercial(ord,(public.garage_order_financials(ord)#>>'{commercial,version}')::integer,100000,'agreed');
  perform pg_temp.pay_check(public.garage_order_payroll(ord)=v,'closed order basis and reserve retain the actual closing quote');
end $$;

-- A single order crosses midnight in Minsk. The recorded actual completion,
-- rather than the close date, selects each independent mechanic rate.
reset role;
insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by)
  values('f1000000-0000-4000-8000-000000000002','Rates boundary','VG02','manager','00000000-0000-4000-8000-000000000001');
insert into public.garage_order_tasks(id,order_id,work_code,work_name) values
  ('f2000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000002','W01','Before midnight'),
  ('f2000000-0000-4000-8000-000000000003','f1000000-0000-4000-8000-000000000002','W02','After midnight');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select public.garage_check_work('f2000000-0000-4000-8000-000000000002',gen_random_uuid());
select public.garage_check_work('f2000000-0000-4000-8000-000000000003',gen_random_uuid());
reset role;
update public.garage_task_completions set completed_at=case when work_code='W01' then '2026-11-30 20:59:00+00'::timestamptz
  else '2026-11-30 21:01:00+00'::timestamptz end where order_id='f1000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$ declare ord uuid:='f1000000-0000-4000-8000-000000000002'; b uuid:='00000000-0000-4000-8000-000000000003'; v jsonb;
begin
  perform public.garage_save_task_pricing('f2000000-0000-4000-8000-000000000002',0,50000,'',gen_random_uuid());
  perform public.garage_save_task_pricing('f2000000-0000-4000-8000-000000000003',0,50000,'',gen_random_uuid());
  perform public.garage_save_commercial(ord,0,null,'agreed');
  v:=public.garage_order_payroll(ord);
  perform pg_temp.pay_check(v->>'total_kopeks'='14000' and v#>>'{lines,0,people,0,rate_bp}'='1500' and
    v#>>'{lines,1,people,0,rate_bp}'='2000','rate by actual Minsk date, solo 60 + 80 BYN');
  perform public.garage_pay_save_amounts('f2000000-0000-4000-8000-000000000002',0,
     jsonb_build_array(jsonb_build_object('mechanic_id',b,'kopeks',3167)),'',false,gen_random_uuid());
  v:=public.garage_order_payroll(ord);
  perform pg_temp.pay_check(v->>'total_kopeks'='11167','prior exact per-task amount remains authoritative including kopeks');
  perform pg_temp.pay_check((select bool_and((j->>'order_payroll')::boolean) from jsonb_array_elements(public.garage_pay_worklist()) j
    where j->>'order_id'=ord::text) and (public.garage_order_financials(ord)#>>'{tasks,0,payout,order_payroll}')::boolean,'both payroll entry points route to the order ledger');
end $$;


-- The entire order sets the ceiling and the reserve, even before the second
-- work is checked. Two mechanics checking the first task create a single basis.
reset role;
insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by)
  values('f1000000-0000-4000-8000-000000000003','Partial shared service','VG02','manager','00000000-0000-4000-8000-000000000001');
insert into public.garage_order_tasks(id,order_id,work_code,work_name) values
  ('f2000000-0000-4000-8000-000000000004','f1000000-0000-4000-8000-000000000003','W01','Shared and done'),
  ('f2000000-0000-4000-8000-000000000005','f1000000-0000-4000-8000-000000000003','W02','Waiting');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_save_task_pricing('f2000000-0000-4000-8000-000000000004',0,50000,'',gen_random_uuid());
select garage_save_task_pricing('f2000000-0000-4000-8000-000000000005',0,62500,'',gen_random_uuid());
select garage_save_commercial('f1000000-0000-4000-8000-000000000003',0,null,'agreed');
do $$ declare v jsonb:=garage_order_payroll('f1000000-0000-4000-8000-000000000003'); begin
  perform pg_temp.pay_check(v->>'cap_kopeks'='22500' and v->>'reserve_kopeks'='4500'
    and v->>'total_kopeks'='0','entire budget even when no work is complete');
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_check_work('f2000000-0000-4000-8000-000000000004',gen_random_uuid());
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select garage_check_work('f2000000-0000-4000-8000-000000000004',gen_random_uuid());
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$ declare ord uuid:='f1000000-0000-4000-8000-000000000003'; v jsonb:=garage_order_payroll(ord);
  helper uuid:='00000000-0000-4000-8000-000000000004';
begin
  perform pg_temp.pay_check(v->>'basis_kopeks'='90000' and v->>'cap_kopeks'='22500' and v->>'reserve_kopeks'='4500'
    and v->>'total_kopeks'='10000' and jsonb_array_length(v->'lines')=1 and jsonb_array_length(v#>'{lines,0,people}')=2,
    'shared completed work counted once; uncompleted service only increases budget');
  v:=garage_save_order_payroll(ord,v->>'token',array[helper],'{}','[]',null,null,gen_random_uuid());
  perform pg_temp.pay_check((v->'people') @> jsonb_build_array(jsonb_build_object('mechanic_id',helper,'kopeks',1200))
    and v->>'total_kopeks'='10000' and v->>'cap_kopeks'='22500','helper gets 3 percent of completed 400, not unearned work');
end $$;

-- Reconcile both positive and negative rounding differences. A fractional
-- ceiling can never create a full ruble over that ceiling.
reset role;
do $$ declare a uuid:='00000000-0000-4000-8000-000000000002'; b uuid:='00000000-0000-4000-8000-000000000003'; lines jsonb; v jsonb;
begin
  lines:=jsonb_build_array(jsonb_build_object('task_id',gen_random_uuid(),'basis_kopeks',12960,
    'people',jsonb_build_array(jsonb_build_object('mechanic_id',a,'rate_bp',2500),jsonb_build_object('mechanic_id',b,'rate_bp',1250))));
  -- 32.40 splits as 21.60 and 10.80, both round up; remove one
  -- from the lower rate to retain 32. A missing ruble is tested next.
  v:=garage_payroll.calculate(lines,'{}','{}','[]',null,null,false,
    (select sum((j->>'basis_kopeks')::bigint)::bigint from jsonb_array_elements(lines) j));
  perform pg_temp.pay_check(v->>'total_kopeks'='3200' and (v->'people') @> jsonb_build_array(jsonb_build_object('mechanic_id',a,'kopeks',2200)), 'rounded excess removed');
  lines:=jsonb_set(lines,'{0,basis_kopeks}','12560');
  -- 31.40 splits as 20.93 and 10.47, giving 21 and 10.
  v:=garage_payroll.calculate(lines,'{}','{}','[]',null,null,false,
    (select sum((j->>'basis_kopeks')::bigint)::bigint from jsonb_array_elements(lines) j));
  perform pg_temp.pay_check((v->'people') @> jsonb_build_array(jsonb_build_object('mechanic_id',b,'kopeks',1000)),'whole ruble ceiling');
  lines:=jsonb_build_array(
    jsonb_build_object('task_id',gen_random_uuid(),'basis_kopeks',5075,'people',jsonb_build_array(jsonb_build_object('mechanic_id',a,'rate_bp',2000))),
    jsonb_build_object('task_id',gen_random_uuid(),'basis_kopeks',6950,'people',jsonb_build_array(jsonb_build_object('mechanic_id',b,'rate_bp',1500))));
  -- 10.15 + 10.425 rounds to 21 rubles overall and only 20 separately.
  v:=garage_payroll.calculate(lines,'{}','{}','[]',null,null,false,
    (select sum((j->>'basis_kopeks')::bigint)::bigint from jsonb_array_elements(lines) j));
  perform pg_temp.pay_check((v->'people') @> jsonb_build_array(jsonb_build_object('mechanic_id',a,'kopeks',1100),
    jsonb_build_object('mechanic_id',b,'kopeks',1000)),'positive rounding residual credited to higher rate');
  lines:=jsonb_build_array(jsonb_set(lines->0,'{basis_kopeks}','72'));
  v:=garage_payroll.calculate(lines,'{}','{}','[]',null,null,false,
    (select sum((j->>'basis_kopeks')::bigint)::bigint from jsonb_array_elements(lines) j));
  perform pg_temp.pay_check(v->>'total_kopeks'='0' and v->>'excess_kopeks'='0','fractional limit cannot create an extra ruble');
end $$;

-- Internal preparation and heating accrue only on completed wrapping. Tint
-- remains a customer service with its own ordinary percentage earnings.
insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by) values
  ('f1000000-0000-4000-8000-000000000004','Wrapping + tint','VG02','manager','00000000-0000-4000-8000-000000000001'),
  ('f1000000-0000-4000-8000-000000000005','Tint only','VG02','manager','00000000-0000-4000-8000-000000000001');
insert into public.garage_order_tasks(id,order_id,work_code,work_name,options) values
  ('f2000000-0000-4000-8000-000000000006','f1000000-0000-4000-8000-000000000004','W01','Wrapping','{}'),
  ('f2000000-0000-4000-8000-000000000007','f1000000-0000-4000-8000-000000000004','W19','Tint','{"tint_percent":15}'),
  ('f2000000-0000-4000-8000-000000000008','f1000000-0000-4000-8000-000000000005','W19','Tint only','{"tint_percent":15}');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare mixed uuid:='f1000000-0000-4000-8000-000000000004'; tint uuid:='f1000000-0000-4000-8000-000000000005';
  helper uuid:='00000000-0000-4000-8000-000000000004'; v jsonb;
begin
  v:=garage_order_payroll(mixed);
  perform pg_temp.pay_check(v->>'wrapping_steps'='true' and v->>'total_kopeks'='0',
    'both internal stages available before completing wrapping');
  v:=garage_save_order_payroll(mixed,v->>'token',array[helper],array[helper],'[]',null,null,gen_random_uuid());
  perform pg_temp.pay_check(v->'prep_ids'=to_jsonb(array[helper]) and v->'people'='[]','early assignment does not pay incomplete work');
  v:=garage_order_payroll(tint);
  perform pg_temp.pay_check(v->>'wrapping_steps'='false','no preparation or heating for tint-only order');
  begin
    perform garage_save_order_payroll(tint,v->>'token',array[helper],'{}','[]',null,null,gen_random_uuid());
    raise exception 'Tint-only order received a wrapping assignment';
  exception when invalid_parameter_value then null; end;
end $$;
select garage_save_task_pricing('f2000000-0000-4000-8000-000000000006',0,50000,'',gen_random_uuid());
select garage_save_task_pricing('f2000000-0000-4000-8000-000000000007',0,50000,'',gen_random_uuid());
select garage_save_commercial('f1000000-0000-4000-8000-000000000004',0,null,'agreed');
select garage_save_mechanic_rate('00000000-0000-4000-8000-000000000002',
  (now() at time zone 'Europe/Minsk')::date,2500,
  (select (r->>'rate_bp')::integer from jsonb_array_elements(garage_mechanic_rates()) r
    where r->>'mechanic_id'='00000000-0000-4000-8000-000000000002'
      and (r->>'effective_date')::date=(now() at time zone 'Europe/Minsk')::date),gen_random_uuid());
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_check_work('f2000000-0000-4000-8000-000000000006',gen_random_uuid());
select garage_check_work('f2000000-0000-4000-8000-000000000007',gen_random_uuid());
select garage_submit_work('f1000000-0000-4000-8000-000000000004',(select (o->>'version')::int
  from jsonb_array_elements(garage_list_orders()) o where o->>'id'='f1000000-0000-4000-8000-000000000004'),gen_random_uuid(),'');
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_vehicle_action('f1000000-0000-4000-8000-000000000004','close',(select (o->>'version')::int
  from jsonb_array_elements(garage_list_orders()) o where o->>'id'='f1000000-0000-4000-8000-000000000004'),gen_random_uuid(),'');
do $$
declare v jsonb:=garage_order_payroll('f1000000-0000-4000-8000-000000000004');
begin
  perform pg_temp.pay_check(v->>'wrapping_steps'='true' and v->>'closed'='true' and v->>'total_kopeks'='20000'
    and (v->'people') @> '[{"mechanic_id":"00000000-0000-4000-8000-000000000004","kopeks":2400}]'
    and (v->'lines') @> '[{"task_id":"f2000000-0000-4000-8000-000000000007","wrapping":false}]',
    'closure pays each 3% stage once on 400 BYN wrapping only and freezes scope: '||v::text);
end $$;
reset role;

-- Closed snapshots from before the scope change used both roles for every pay line.
update garage_payroll.revisions r set frozen_lines=(select jsonb_agg(l-'wrapping') from jsonb_array_elements(r.frozen_lines) l)
  where r.order_id='f1000000-0000-4000-8000-000000000004' and operation='close';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare v jsonb:=garage_order_payroll('f1000000-0000-4000-8000-000000000004');
begin
  perform pg_temp.pay_check((v->'people') @> '[{"mechanic_id":"00000000-0000-4000-8000-000000000004","kopeks":4800}]',
    'historic frozen lines keep their previous payout scope');
end $$;
reset role;
rollback;
