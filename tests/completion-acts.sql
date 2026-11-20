-- The real template, party details and issued number series are private.
begin;
create function pg_temp.act_check(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Act check: %',label; end if; end $$;
create function pg_temp.act_reject(query_text text,expected text) returns void language plpgsql as $$
begin
  begin execute query_text; exception when others then if sqlstate=expected then return; end if; raise; end;
  raise exception 'Expected %',expected;
end $$;
-- Each synthetic document starts at order version 1 with one completed service.
create function pg_temp.issue(ord uuid,num text,contract text,contract_day date,act_day date,v integer,vin text default null)
returns jsonb language sql as $$
  select public.garage_act_save(ord,num,contract,contract_day,act_day,v,1,
    jsonb_build_object(replace(ord::text,'8d000000','8d100000'),case when right(ord::text,1)='1' then 0 else 1111 end),vin);
$$;
insert into public.garage_orders(id,vehicle,vehicle_group_code,vin,source,status,closed_at,created_by)
  select ('8d000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Fixture car','VG02',
    case when n=1 then '' else 'TEST9999999999999' end,'manager',case when n=4 then 'published' else 'closed' end,
    case n when 1 then timestamptz '2026-11-25T10:00Z' when 2 then timestamptz '2026-11-30T22:00Z'
    else timestamptz '2027-01-01T09:00Z' end,'00000000-0000-4000-8000-000000000001'::uuid
  from generate_series(1,5) n;
insert into public.garage_order_tasks(id,order_id,work_code,work_name,status,working_mechanic_id,completed_at)
  select ('8d100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
    ('8d000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'W01','Fixture service','completed',
    '00000000-0000-4000-8000-000000000002'::uuid,now() from generate_series(1,5) n;
insert into garage_act.config(customer_name,contractor_name,contract_number,contract_date,template_chunks)
  values('Client Fixture','Workshop Fixture','T/9',date '2026-10-20',2);
insert into garage_act.template_parts(part_index,data_base64) values(1,'ZA==');
select pg_temp.act_check(not has_function_privilege('anon','public.garage_act_template()','execute')
  and not has_table_privilege('authenticated','garage_act.documents','select')
  and not has_table_privilege('authenticated','garage_act.template_parts','select')
  and not has_table_privilege('authenticated','garage_act.config','update'),'private table and function grants');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.act_reject('select public.garage_act_template()','42501');
select pg_temp.act_reject($q$select public.garage_act_get('8d000000-0000-4000-8000-000000000001')$q$,'42501');
select pg_temp.act_reject($q$select public.garage_act_save(null,'1/11','','2026-10-01','2026-11-01',0,1,'{}')$q$,'42501');
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.act_reject('select public.garage_act_template()','55000');
select public.garage_save_task_pricing('8d100000-0000-4000-8000-000000000001',0,0,'',gen_random_uuid());
select pg_temp.act_reject($q$select pg_temp.issue('8d000000-0000-4000-8000-000000000001','19/11','T/9',
  '2026-10-20','2026-11-25',0,'TEST-VIN')$q$,'55000');
reset role;
insert into garage_act.template_parts(part_index,data_base64) values(0,'YWJj');
set local role authenticated;
select pg_temp.act_check(public.garage_act_template()='["YWJj","ZA=="]'::jsonb,'ordered chunks');
select pg_temp.act_check(public.garage_act_get('8d000000-0000-4000-8000-000000000001')->'suggested_number'='null','first use asks owner');
select pg_temp.act_reject($q$select public.garage_act_get('8d000000-0000-4000-8000-000000000004')$q$,'22023');
select public.garage_save_task_pricing(('8d100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  0,1111,'',gen_random_uuid()) from generate_series(2,3) n;
reset role;
insert into garage_act.reserved_numbers(number) values('18/11');
update garage_act.config set last_issued_number='18/11';
set local role authenticated;
do $$
declare
  a uuid:='8d000000-0000-4000-8000-000000000001'; b uuid:='8d000000-0000-4000-8000-000000000002';
  c uuid:='8d000000-0000-4000-8000-000000000003'; unpriced uuid:='8d000000-0000-4000-8000-000000000005';
  fmt text:='select pg_temp.issue(%L,%L,%L,%L,%L,%s,%L)'; m jsonb;
begin
  m:=public.garage_act_get(a);
  perform pg_temp.act_check(m->>'suggested_number'='19/11' and m->'number'='null' and m->>'version'='0' and m->>'vin'=''
    and m->>'customer_name'='Client Fixture' and m->>'contract_number'='T/9' and m->>'act_date'='2026-11-25','defaults and new serial');
  perform pg_temp.act_check(public.garage_act_get(b)->>'suggested_number'='19/12' and public.garage_act_get(b)->>'act_date'='2026-12-01','midnight in Minsk; previews consume nothing');
  perform pg_temp.act_reject(format(fmt,a,'19/11','T/9','2026-10-20','2026-11-25',0,''),'22023');
  perform pg_temp.act_reject(format(fmt,unpriced,'19/01','T/9','2026-10-20','2027-01-05',0,'TEST-VIN'),'22023');
  perform pg_temp.act_reject(format(fmt,a,'18/11','T/9','2026-10-20','2026-11-25',0,'TEST-VIN'),'23505');
  perform pg_temp.act_reject(format(fmt,b,'18/12','T/9','2026-10-20','2026-12-01',0,'TEST-VIN'),'23505');
  perform pg_temp.act_reject(format(fmt,a,'19/12','T/9','2026-10-20','2026-11-25',0,'TEST-VIN'),'22023');
  perform pg_temp.act_reject(format(fmt,a,'019/11','T/9','2026-10-20','2026-11-25',0,'TEST-VIN'),'22023');
  perform pg_temp.act_reject(format('select public.garage_act_save(%L,%L,%L,%L,%L,0,1,%L,%L)',
    a,'19/11','T/9','2026-10-20','2026-11-25','{}','TEST-VIN'),'40001');
  m:=pg_temp.issue(a,'19/11','T/9','2026-10-20','2026-11-25',0,'TEST-VIN');
  perform pg_temp.act_check(m->>'number'='19/11' and m->>'vin'='TEST-VIN' and m->>'version'='1','issue with gift and private VIN');
  perform pg_temp.act_check(pg_temp.issue(a,'19/11','T/9','2026-10-20','2026-11-25',0)=m,'ambiguous retry');
  perform pg_temp.act_reject(format('select public.garage_act_save(%L,%L,%L,%L,%L,0,2,%L)',
    a,'19/11','T/9','2026-10-20','2026-11-25','{"8d100000-0000-4000-8000-000000000001":0}'),'40001');
  perform pg_temp.act_check(public.garage_act_get(b)->>'suggested_number'='20/12','new month shares cumulative serial');
  perform pg_temp.act_reject(format(fmt,a,'19/11','changed','2026-10-20','2026-11-25',0,'TEST-VIN'),'40001');
  perform pg_temp.act_reject(format(fmt,a,'20/11','T/9','2026-10-20','2026-11-25',1,'TEST-VIN'),'22023');
  perform pg_temp.act_reject(format(fmt,a,'19/11','T/9','2026-10-20','2026-12-01',1,'TEST-VIN'),'22023');
  m:=pg_temp.issue(a,'19/11','T/10','2026-10-25','2026-11-29',1);
  perform pg_temp.act_check(m->>'version'='2' and m->>'number'='19/11' and m->>'vin'='TEST-VIN','edit preserves number');
  perform public.garage_save_task_pricing('8d100000-0000-4000-8000-000000000001',1,2222,'',gen_random_uuid());
  perform pg_temp.act_reject(format(fmt,a,'19/11','T/10','2026-10-25','2026-11-29',2,'TEST-VIN'),'40001');
  m:=pg_temp.issue(b,'25/12','T/9','2026-10-20','2026-12-31',0);
  perform pg_temp.act_check(m->>'number'='25/12' and m->>'vin'='TEST9999999999999','manual advance and order VIN');
  perform pg_temp.act_check(public.garage_act_get(c)->>'suggested_number'='26/01','new year keeps cumulative serial');
  perform pg_temp.act_reject(format(fmt,c,'24/01','T/9','2026-10-20','2027-01-01',0,'TEST-VIN'),'23505');
  perform pg_temp.act_check(public.garage_act_get(a)->>'number'='19/11','re-export unaffected by later issuance');
end $$;
rollback;
