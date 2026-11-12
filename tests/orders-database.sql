\set ON_ERROR_STOP on
-- Isolated fixture data only. This file must never run against a live project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key,email text not null,raw_user_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema public,auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
\i /tmp/garage-schema.sql
grant select,insert,update,delete on all tables in schema public to anon,authenticated;
grant usage,select on all sequences in schema public to anon,authenticated;
alter default privileges in schema public grant select,insert,update,delete on tables to anon,authenticated;
alter default privileges in schema public grant usage,select on sequences to anon,authenticated;

insert into auth.users(id,email,raw_user_meta_data) values
 ('00000000-0000-4000-8000-000000000001','owner@example.invalid','{"name":"Test Owner"}'),
 ('00000000-0000-4000-8000-000000000002','mechanic-a@example.invalid','{"name":"Mechanic A"}'),
 ('00000000-0000-4000-8000-000000000003','mechanic-b@example.invalid','{"name":"Mechanic B"}');
update profiles set role='admin' where id='00000000-0000-4000-8000-000000000001';
insert into jobs(mechanic_id,job_date,car,work_id)
select '00000000-0000-4000-8000-000000000002',current_date-2,'Legacy fixture '||n,1 from generate_series(1,6)n;
\i /tmp/garage-orders.sql

create function public.test_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %',label; end if;
  raise notice 'PASS: %',label;
end $$;
create function public.test_error(statement text,label text,expected_state text default null) returns void
language plpgsql as $$
declare failed boolean:=false;
begin
  begin execute statement;
  exception when others then
    failed:=true;
    if expected_state is not null and sqlstate<>expected_state then raise exception 'Unexpected SQLSTATE % for %: %',sqlstate,label,sqlerrm; end if;
  end;
  perform public.test_assert(failed,label);
end $$;

select test_assert((select count(*)=19 from garage_works),'19 approved work types');
select test_assert((select count(*)=17 from garage_vehicle_groups),'17 vehicle groups');
select test_assert((select count(*)=283 from garage_work_availability),'283 allowed work/model combinations');
select test_assert((select count(*)=20 from works),'legacy catalogue IDs retained');
select test_assert((select count(*)=6 from jobs),'six legacy jobs preserved');
select test_assert(not has_table_privilege('authenticated','jobs','INSERT'),'legacy direct job insertion revoked');
select test_assert(not has_table_privilege('authenticated','garage_order_tasks','UPDATE'),'direct task updates revoked despite Supabase defaults');
select test_assert(not has_function_privilege('authenticated','garage_snapshot_task(uuid,text)','EXECUTE'),'private financial helper not exposed');

-- Artificial rates for test purposes; these are unrelated to uploaded prices.
insert into garage_price_lists(id,name,source_sha256,status)
values('10000000-0000-4000-8000-000000000001','Artificial test version',repeat('a',64),'active');
insert into garage_price_matrix(price_list_id,vehicle_group_code,work_code,net_amount)
values('10000000-0000-4000-8000-000000000001','VG02','W01',11.11);

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_assert(jsonb_array_length(garage_staff())=2,'Owner receives active mechanic directory');
select test_error($q$select garage_create_order('Bad owner','VG02','owner','[{"work_code":"W01"}]','20000000-0000-4000-8000-000000000001')$q$,'Owner order requires assignment');
select test_error($q$select garage_create_order('Bad shared','VG02','manager','[{"work_code":"W01","assigned_to":"00000000-0000-4000-8000-000000000002"}]','20000000-0000-4000-8000-000000000002')$q$,'Manager tasks reject mandatory assignee');
select test_error($q$select garage_create_order('Unavailable','VG01','manager','[{"work_code":"W05"}]','20000000-0000-4000-8000-000000000003')$q$,'Unavailable matrix cell rejected');
select test_error($q$select garage_create_order('Noncatalogue','VG02','manager','[{"work_code":"NOT-A-WORK"}]','20000000-0000-4000-8000-000000000004')$q$,'Unknown work rejected');
select test_error($q$select garage_create_order('Unsupported tint','VG02','manager','[{"work_code":"W19","options":{"tint_percent":10}}]','20000000-0000-4000-8000-000000000005')$q$,'Tint10 is outside closed5/15 catalogue');
select test_error($q$select garage_create_order('Unknown financial key','VG02','manager','[{"work_code":"W01","price":1}]','20000000-0000-4000-8000-000000000006')$q$,'Client financial fields rejected');
select test_assert((select count(*)=0 from garage_orders),'invalid revisions leave no partial order');

select garage_create_order('Owner vehicle','VG02','owner','[{"work_code":"W01","assigned_to":"00000000-0000-4000-8000-000000000002"}]','20000000-0000-4000-8000-000000000010')->>'order_id' as owner_order \gset
select id as owner_task from garage_order_tasks where order_id=:'owner_order'::uuid \gset
select garage_create_order('Owner vehicle','VG02','owner','[{"work_code":"W01","assigned_to":"00000000-0000-4000-8000-000000000002"}]','20000000-0000-4000-8000-000000000010')->>'order_id' as owner_replay \gset
select test_assert(:'owner_order'=:'owner_replay','Owner creation retry returns same order');
select test_error($q$select garage_create_order('Changed payload','VG02','owner','[{"work_code":"W01","assigned_to":"00000000-0000-4000-8000-000000000002"}]','20000000-0000-4000-8000-000000000010')$q$,'Request ID cannot be reused with another payload');
select test_assert((garage_order_financials(:'owner_order')->>'gross_amount')::numeric=13.33,'Owner sees per-line rounded tax snapshot');
select garage_create_order('Shared vehicle','VG02','manager','[{"work_code":"W01"},{"work_code":"W19","options":{"tint_percent":15}}]','20000000-0000-4000-8000-000000000011',p_manager_label=>'Source label',p_planned_date=>current_date+2)->>'order_id' as manager_order \gset
select id as manager_task from garage_order_tasks where order_id=:'manager_order'::uuid and work_code='W01' \gset
select id as tint_task from garage_order_tasks where order_id=:'manager_order'::uuid and work_code='W19' \gset
select test_assert(garage_order_financials(:'manager_order')->>'status'='needs_pricing','Missing rate remains needs_pricing');
select test_assert(garage_order_financials(:'manager_order')->'gross_amount'='null'::jsonb,'Incomplete financial totals stay unknown rather than zero');
select test_assert((select planned_date=current_date+2 and due_date is null from garage_orders where id=:'manager_order'),'Planned date is distinct from deadline');
select test_assert(garage_list_orders()->0->>'planned_date' is not null,'Safe list JSON includes planned date');
select test_error(format('select garage_task_action(%L,''reassign'',1,%L,''Not a forced queue'',%L)',:'manager_task',gen_random_uuid(),'00000000-0000-4000-8000-000000000002'),'Owner cannot assign pending Manager queue work');

set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select test_assert((select count(*)=0 from garage_orders where id=:'owner_order'),'Other mechanic cannot read mandatory parent order');
select test_assert((select count(*)=0 from garage_order_tasks where id=:'owner_task'),'Other mechanic cannot read mandatory task');
select test_assert((select count(*)=0 from garage_task_financials),'Mechanic direct SELECT reveals no snapshots');
select test_assert((select count(*)=0 from garage_price_matrix),'Mechanic direct SELECT reveals no rates');
select test_error(format('select garage_task_action(%L,''start'',1,%L)',:'owner_task',gen_random_uuid()),'Other mechanic cannot start mandatory task','42501');
select test_error(format('select garage_order_financials(%L)',:'manager_order'),'Mechanic financial RPC denied','42501');
select test_error($q$select garage_staff()$q$,'Mechanic cannot retrieve Owner assignment directory','42501');
select test_error($q$insert into jobs(car,work_id) values('unordered',1)$q$,'Old app cannot create unordered jobs','42501');
select test_error(format('update garage_order_tasks set assigned_to=auth.uid() where id=%L',:'manager_task'),'Direct task mutation denied','42501');
select test_error($q$select garage_create_order('Forged','VG02','manager','[{"work_code":"W01"}]',gen_random_uuid())$q$,'Mechanic cannot create unordered work','42501');
select test_assert(not (garage_list_orders()::text ~ 'net_amount|gross_amount|vat_amount|price_list|pricing_status'),'Ordinary order JSON has no financial fields');

set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select test_assert((select count(*)=1 from garage_orders where id=:'owner_order'),'Assigned mechanic sees parent context');
select garage_task_action(:'owner_task','start',1,'30000000-0000-4000-8000-000000000001');
select test_error(format('select garage_task_action(%L,''release'',2,%L,''Not allowed'')',:'owner_task',gen_random_uuid()),'Mandatory task cannot enter shared queue');
select garage_task_action(:'owner_task','block',2,'30000000-0000-4000-8000-000000000002','Waiting for required material');
select test_assert((select status='blocked' and assigned_to=auth.uid() from garage_order_tasks where id=:'owner_task'),'Blocking retains mandatory assignment');

set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_error(format('select garage_order_action(%L,''close'',%s,%L)',:'owner_order',(select version from garage_orders where id=:'owner_order'),gen_random_uuid()),'Unfinished order cannot close');
select garage_task_action(:'owner_task','reassign',3,'30000000-0000-4000-8000-000000000003','Owner transfer','00000000-0000-4000-8000-000000000003');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select test_assert((select count(*)=0 from garage_orders where id=:'owner_order'),'Reassignment removes former assignee parent access');
select test_error(format('select garage_task_action(%L,''complete'',4,%L)',:'owner_task',gen_random_uuid()),'Former assignee cannot complete stale task','42501');
select test_assert((select count(*)>0 from garage_task_events where task_id=:'owner_task' and actor_id=auth.uid()),'Former worker retains own operational event history');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select garage_task_action(:'owner_task','resume',4,'30000000-0000-4000-8000-000000000004');
select garage_task_action(:'owner_task','complete',5,'30000000-0000-4000-8000-000000000005');
select garage_task_action(:'owner_task','complete',5,'30000000-0000-4000-8000-000000000005');
select test_assert((select count(*)=1 from garage_task_completions where task_id=:'owner_task'),'Completion retry writes one ledger row');
select test_assert((select mechanic_id=auth.uid() from garage_task_completions where task_id=:'owner_task'),'Completion records actual completing mechanic');

set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select version as owner_version from garage_orders where id=:'owner_order' \gset
select garage_order_action(:'owner_order','close',:'owner_version','40000000-0000-4000-8000-000000000001');
select test_assert((select status='closed' from garage_orders where id=:'owner_order'),'Owner closes completed order');

set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_task_action(:'manager_task','start',1,'30000000-0000-4000-8000-000000000010');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select test_error(format('select garage_task_action(%L,''start'',1,%L)',:'manager_task',gen_random_uuid()),'Second claimant rejected','40001');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_task_action(:'manager_task','release',2,'30000000-0000-4000-8000-000000000011','Return shared work');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select garage_task_action(:'manager_task','start',3,'30000000-0000-4000-8000-000000000012');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_task_action(:'manager_task','reassign',4,'30000000-0000-4000-8000-000000000014','Owner transfer of active shared task','00000000-0000-4000-8000-000000000002');
select test_assert((select assigned_to is null and working_mechanic_id='00000000-0000-4000-8000-000000000002' from garage_order_tasks where id=:'manager_task'),'Active Manager transfer preserves shared routing');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select test_error(format('select garage_task_action(%L,''complete'',5,%L)',:'manager_task',gen_random_uuid()),'Former shared worker cannot complete after transfer','42501');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_task_action(:'manager_task','complete',5,'30000000-0000-4000-8000-000000000013');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select version as manager_version from garage_orders where id=:'manager_order' \gset
select garage_order_action(:'manager_order','cancel',:'manager_version','40000000-0000-4000-8000-000000000002','Cancel remaining scope');
select test_assert((select status='completed' from garage_order_tasks where id=:'manager_task'),'Cancellation preserves completed task');
select test_assert((select status='cancelled' from garage_order_tasks where id=:'tint_task'),'Cancellation stops remaining task');

reset role;
select test_error($q$update garage_price_matrix set net_amount=22.22 where price_list_id='10000000-0000-4000-8000-000000000001'$q$,'Used pricing version cannot be overwritten');
select test_assert((select net_amount=11.11 from garage_task_financials where task_id=:'owner_task'),'Frozen financial snapshot remains unchanged');
select test_assert((select count(*)=6 from jobs),'New workflow preserves legacy job row count');
select test_assert((select count(*)=2 from garage_task_completions),'New completions use distinct immutable ledger');

set role anon;
select test_error($q$select garage_list_orders()$q$,'Anonymous order RPC denied','42501');
select test_error($q$select * from garage_orders$q$,'Anonymous direct order table denied','42501');
select test_error($q$select * from garage_price_matrix$q$,'Anonymous financial table denied','42501');
reset role;

-- A separate open shared task is used by the runner's two-session race test.
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_create_order('Concurrency fixture','VG02','manager','[{"work_code":"W01"}]','20000000-0000-4000-8000-000000000020');
reset role;
select 'ORDER_DATABASE_CHECKS_PASSED' as result;
