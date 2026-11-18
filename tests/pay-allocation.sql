-- Run in the isolated test-team-workflow.py database after its synthetic users are created.
begin;
create function pg_temp.pay_assert(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'PAY CHECK: %', label; end if;
end $$;
create function pg_temp.pay_denied(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate=expected then return; end if;
    raise exception 'Expected %, got %: %', expected, sqlstate, sqlerrm;
  end;
  raise exception 'Statement unexpectedly succeeded';
end $$;

-- Historical work and the earlier catalogue's financial rates remain unrelated to payout.
select pg_temp.pay_assert(not exists(select 1 from garage_pay.items i
  join public.garage_order_tasks t on t.id=i.task_id join public.garage_orders o on o.id=t.order_id
  where o.vehicle='До перехода'),'historical work excluded');
insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by)
  values('42800000-0000-4000-8000-000000000001','Проверка распределения','VG02','manager','00000000-0000-4000-8000-000000000001');
insert into public.garage_order_tasks(id,order_id,work_code,work_name,status,working_mechanic_id,completed_at)
  values('42900000-0000-4000-8000-000000000001','42800000-0000-4000-8000-000000000001','W01','Тестовая работа','completed',
    '00000000-0000-4000-8000-000000000002',now()-interval '2 years');
insert into public.garage_task_participants(task_id,mechanic_id,status,started_at,confirmed_at,confirmation_origin)
  values('42900000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','confirmed',now(),now(),'mechanic');
insert into public.garage_task_participants(task_id,mechanic_id,status,started_at,departed_at)
  values('42900000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','working',now(),now());
insert into public.garage_task_completions(task_id,order_id,work_code,work_name,mechanic_id,completed_at)
  values('42900000-0000-4000-8000-000000000001','42800000-0000-4000-8000-000000000001','W01','Тестовая работа',
    '00000000-0000-4000-8000-000000000002',now()-interval '2 years');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.pay_denied('select public.garage_pay_worklist()','42501');
select pg_temp.pay_denied($q$select public.garage_pay_history('42900000-0000-4000-8000-000000000001')$q$,'42501');
select pg_temp.pay_denied('select * from garage_pay.items','42501');
select pg_temp.pay_denied($q$select public.garage_pay_save('42900000-0000-4000-8000-000000000001',0,1,'[]','',false,gen_random_uuid())$q$,'42501');
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.pay_assert((select count(*)=1 and bool_and(x->'pool_kopeks'='null'::jsonb and x->>'version'='0'
  and jsonb_array_length(x->'candidates')=3) from jsonb_array_elements(public.garage_pay_worklist()) x
  where x->>'task_id'='42900000-0000-4000-8000-000000000001'),'one pending item for an omitted completion without a price');

do $$
declare task_id uuid:='42900000-0000-4000-8000-000000000001'; r_id uuid:=gen_random_uuid();
  a uuid:='00000000-0000-4000-8000-000000000002';
  b uuid:='00000000-0000-4000-8000-000000000003';
  c uuid:='00000000-0000-4000-8000-000000000004';
  owner_id uuid:='00000000-0000-4000-8000-000000000001';
  shares jsonb:=jsonb_build_array(jsonb_build_object('mechanic_id',a,'basis_points',3333),
    jsonb_build_object('mechanic_id',b,'basis_points',3333),jsonb_build_object('mechanic_id',c,'basis_points',3334));
  two jsonb:=jsonb_build_array(jsonb_build_object('mechanic_id',a,'basis_points',10000),jsonb_build_object('mechanic_id',b,'basis_points',0));
  revision jsonb;
begin
  perform pg_temp.pay_denied(format('select garage_pay_save(%L,0,2,%L,%L,false,gen_random_uuid())',task_id,shares,''),'22023');
  perform pg_temp.pay_denied(format('select garage_pay_save(%L,0,0,%L,%L,false,gen_random_uuid())',task_id,two,''),'22023');
  perform pg_temp.pay_denied(format('select garage_pay_save(%L,0,2,%L,%L,false,gen_random_uuid())',task_id,two-1,''),'22023');
  perform pg_temp.pay_denied(format('select garage_pay_save(%L,0,2,%L,%L,false,gen_random_uuid())',task_id,
    jsonb_set(two,'{1,mechanic_id}',to_jsonb(a)),''),'22023');
  perform pg_temp.pay_denied(format('select garage_pay_save(%L,0,2,%L,%L,false,gen_random_uuid())',task_id,
    jsonb_set(shares,'{2,mechanic_id}',to_jsonb(owner_id)),'Ошибка'),'22023');
  perform pg_temp.pay_denied(format('select garage_pay_save(%L,0,2,%L,%L,false,gen_random_uuid())',task_id,
    jsonb_set(two,'{1,basis_points}','1'),''),'22023');
  perform pg_temp.pay_assert(public.garage_pay_save(task_id,0,2,shares,'Помощь до передачи',false,r_id)=1,'save');
  perform pg_temp.pay_assert(public.garage_pay_save(task_id,0,2,shares,'Помощь до передачи',false,r_id)=1,'exact retry');
  revision:=public.garage_pay_history(task_id)->0;
  perform pg_temp.pay_assert(jsonb_array_length(public.garage_pay_history(task_id))=1
    and revision->'shares'->0->>'kopeks'='1' and revision->'shares'->1->>'kopeks'='0' and revision->'shares'->2->>'kopeks'='1',
    'kopeks reconcile, with stable tie-break by UUID');
  perform pg_temp.pay_denied(format('select garage_pay_save(%L,0,3,%L,%L,false,%L)',task_id,shares,'Помощь до передачи',r_id),'22023');
  perform pg_temp.pay_denied(format('select garage_pay_save(%L,0,0,%L,%L,true,gen_random_uuid())',task_id,two,'Уточнение'),'40001');
  perform pg_temp.pay_denied(format('select garage_pay_save(%L,1,0,%L,%L,true,gen_random_uuid())',task_id,two,''),'22023');
  perform pg_temp.pay_assert(public.garage_pay_save(task_id,1,0,two,'Подтверждён нулевой фонд',true,gen_random_uuid())=2,'zero pool');
  perform pg_temp.pay_assert(public.garage_pay_history(task_id)->0->>'pool_kopeks'='0'
    and jsonb_array_length(public.garage_pay_history(task_id))=2,'audited correction');
end $$;
set local role anon;
select pg_temp.pay_denied('select public.garage_pay_worklist()','42501');
rollback;
