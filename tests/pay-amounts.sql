-- The integration harness supplies four synthetic staff members and rolls this fixture back.
begin;

create function pg_temp.require_amount(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Exact payout: %',label; end if; end $$;
create function pg_temp.require_error(statement text,expected text) returns void language plpgsql as $$
begin
  begin execute statement; exception when others then if sqlstate=expected then return; end if; raise; end;
  raise exception 'Expected %',expected;
end $$;

insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by)
  values('ac000000-0000-4000-8000-000000000001','Exact payout','VG02','manager','00000000-0000-4000-8000-000000000001');
insert into public.garage_order_tasks(id,order_id,work_code,work_name)
  values('bc000000-0000-4000-8000-000000000001','ac000000-0000-4000-8000-000000000001','W01','Exact payout job');
insert into public.garage_task_participants(task_id,mechanic_id,status,started_at,departed_at)
  values('bc000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','working',now(),now());
select pg_temp.require_amount(not has_function_privilege('anon','public.garage_pay_save_amounts(uuid,integer,jsonb,text,boolean,uuid)','execute'),
  'anonymous clients cannot submit pay');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select public.garage_check_work('bc000000-0000-4000-8000-000000000001',gen_random_uuid());
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select public.garage_check_work('bc000000-0000-4000-8000-000000000001',gen_random_uuid());
select pg_temp.require_error($q$select public.garage_pay_save_amounts('bc000000-0000-4000-8000-000000000001',
  0,'[]','',false,gen_random_uuid())$q$,'42501');
select pg_temp.require_amount(public.garage_list_orders()::text !~ 'pool_kopeks|suggested_shares|basis_points','private amounts stay out of mechanic feeds');

set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare
  job uuid:='bc000000-0000-4000-8000-000000000001'; ord uuid:='ac000000-0000-4000-8000-000000000001';
  a uuid:='00000000-0000-4000-8000-000000000002'; b uuid:='00000000-0000-4000-8000-000000000003';
  former uuid:='00000000-0000-4000-8000-000000000004';
  request_key uuid:=gen_random_uuid(); x jsonb; y jsonb; entry jsonb; history jsonb; old jsonb;
  amounts jsonb; original jsonb; sql_save text;
begin
  x:=jsonb_build_object('mechanic_id',a,'kopeks',1);
  y:=jsonb_build_object('mechanic_id',b,'kopeks',99999);
  amounts:=jsonb_build_array(x,y);
  original:=jsonb_build_array(jsonb_build_object('mechanic_id',a,'basis_points',5000),jsonb_build_object('mechanic_id',b,'basis_points',5000));
  perform public.garage_pay_save(job,0,10001,original,'',false,gen_random_uuid());
  old:=public.garage_pay_history(job)->0;
  select t->'payout' into strict entry from jsonb_array_elements(public.garage_order_financials(ord)->'tasks') t where t->>'task_id'=job::text;
  perform pg_temp.require_amount(jsonb_array_length(entry->'candidates')=3 and entry->>'version'='1'
    and entry->'shares'=old->'shares','order-scoped editor receives the roster and the exact historic shares');
  sql_save:='select public.garage_pay_save_amounts(%L,1,%L,%L,false,gen_random_uuid())';
  perform pg_temp.require_error(format(sql_save,job,amounts,''),'22023');
  perform pg_temp.require_error(format(sql_save,job,jsonb_build_array(x),'change'),'40001');
  perform pg_temp.require_error(format(sql_save,job,jsonb_build_array(x,x,y),'change'),'22023');
  perform pg_temp.require_error(format(sql_save,job,amounts||jsonb_build_array(jsonb_build_object('mechanic_id',gen_random_uuid(),'kopeks',3)),'change'),'40001');
  perform pg_temp.require_error(format(sql_save,job,jsonb_build_array(x,jsonb_set(y,'{kopeks}','-1')),'change'),'22023');
  perform pg_temp.require_error(format(sql_save,job,jsonb_build_array(x,jsonb_set(y,'{kopeks}','12.34')),'change'),'22023');
  perform pg_temp.require_error(format(sql_save,job,jsonb_build_array(x,jsonb_set(y,'{kopeks}','999999999999')),'change'),'22023');
  perform pg_temp.require_error(format(sql_save,job,jsonb_build_array(x,y||'{"basis_points":10}'),'change'),'22023');
  perform pg_temp.require_amount(public.garage_pay_save_amounts(job,1,amounts,'Specific amounts',false,request_key)=2,'exact-amount correction saved');
  perform pg_temp.require_amount(public.garage_pay_save_amounts(job,1,jsonb_build_array(y,x),'Specific amounts',false,request_key)=2,
    'same receipt works after a row reorder');
  perform pg_temp.require_error(format('select public.garage_pay_save_amounts(%L,1,%L,%L,false,%L)',job,
    jsonb_build_array(x,jsonb_set(y,'{kopeks}','20000')),'Specific amounts',request_key),'22023');
  perform pg_temp.require_error(format(sql_save,job,amounts,'stale'),'40001');
  history:=public.garage_pay_history(job);
  perform pg_temp.require_amount(history->1=old and jsonb_array_length(history)=2,'legacy payout and whole history survive correction');
  perform pg_temp.require_amount(history#>>'{0,pool_kopeks}'='100000' and history#>>'{0,shares,0,kopeks}'='1'
    and history#>>'{0,shares,1,kopeks}'='99999' and history#>>'{0,shares,0,basis_points}'='0',
    'amounts smaller than one basis point survive exactly');
  amounts:=jsonb_build_array(jsonb_set(x,'{kopeks}','0'),jsonb_set(y,'{kopeks}','0'),jsonb_build_object('mechanic_id',former,'kopeks',0));
  perform pg_temp.require_error(format('select public.garage_pay_save_amounts(%L,2,%L,%L,false,gen_random_uuid())',job,amounts,'zero'),'22023');
  perform public.garage_pay_save_amounts(job,2,amounts,'Zero payout including former helper',true,gen_random_uuid());
  select t into strict entry from jsonb_array_elements(public.garage_pay_worklist()) t where t->>'task_id'=job::text;
  perform pg_temp.require_amount(entry->>'pool_kopeks'='0' and entry#>>'{shares,2,former}'='true'
    and (select sum((s->>'basis_points')::int)=10000 and sum((s->>'kopeks')::bigint)=0 from jsonb_array_elements(entry->'shares') s),
    'zero allocation retains old client fields and the saved former helper');
end $$;

set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select public.garage_uncheck_work('bc000000-0000-4000-8000-000000000001',3,gen_random_uuid());
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select public.garage_uncheck_work('bc000000-0000-4000-8000-000000000001',4,gen_random_uuid());
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.require_amount(public.garage_order_financials('ac000000-0000-4000-8000-000000000001')#>'{tasks,0,payout}'='null'
  and jsonb_array_length(public.garage_pay_history('bc000000-0000-4000-8000-000000000001'))=3,'reopened job keeps history and hides the payout editor');
select pg_temp.require_error($q$select public.garage_pay_save_amounts('bc000000-0000-4000-8000-000000000001',3,
  '[{"mechanic_id":"00000000-0000-4000-8000-000000000002","kopeks":123}]','Closed editor',false,gen_random_uuid())$q$,'40001');
rollback;
