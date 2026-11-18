-- A wholly synthetic rule and rate exercise an optional gift in the disposable database.
begin;
create function pg_temp.gift_assert(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'GIFT CHECK: %',label; end if; end $$;
create function pg_temp.gift_denied(statement text,expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then if sqlstate=expected then return; end if; raise; end;
  raise exception 'Statement unexpectedly succeeded';
end $$;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.gift_assert(public.garage_owner_gift_offer() is null,'unconfigured offer absent');
reset role;
insert into garage_pay.gift_offer(gift_work_code,qualifying_count) values('W09',2);
insert into public.garage_price_lists(id,name,source_sha256,status) values('72700000-0000-4000-8000-000000000001','Synthetic promotion test',repeat('1',64),'active');
insert into public.garage_price_matrix(price_list_id,vehicle_group_code,work_code,net_amount)
  values('72700000-0000-4000-8000-000000000001','VG02','W09',7.89);
insert into public.garage_sheet_sources(id,spreadsheet_id,name,owner_id,secret_hash)
  values('72700000-0000-4000-8000-000000000011','synthetic-gift-workbook','Synthetic source','00000000-0000-4000-8000-000000000001',repeat('d',64));
insert into public.garage_manager_intake(id,source_id,intake_key,original_snapshot,original_observations,latest_snapshot,row_numbers)
  values('72700000-0000-4000-8000-000000000012','72700000-0000-4000-8000-000000000011','synthetic-gift-key','{}','[]','{}',array[44]);

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.gift_denied('select public.garage_owner_gift_offer()','42501');
select pg_temp.gift_denied('select * from garage_pay.gift_offer','42501');
select pg_temp.gift_denied($q$select public.garage_save_order_with_gift('new',null,null,'{}','[]',0,gen_random_uuid())$q$,'42501');
set local role anon;
select pg_temp.gift_denied('select public.garage_owner_gift_offer()','42501');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare fields jsonb:='{"vehicle":"Synthetic gift visit","vehicle_group_code":"VG02","source":"manager"}';
  chosen jsonb:='[{"work_code":"W01"},{"work_code":"W07"},{"work_code":"W09"}]'; retained jsonb;
  request uuid:=gen_random_uuid(); reply jsonb; gift jsonb; ord uuid; task uuid;
  owner_id uuid:='00000000-0000-4000-8000-000000000001'; a uuid:='00000000-0000-4000-8000-000000000002';
  intake_id uuid:='72700000-0000-4000-8000-000000000012'; expected_ver int; intake_order uuid;
begin
  perform pg_temp.gift_assert(public.garage_owner_gift_offer()='{"work_code":"W09","qualifying_count":2}','Owner sees configured rule');
  perform pg_temp.gift_denied(format('select garage_save_order_with_gift(''new'',null,null,%L,%L,0,gen_random_uuid())',
    fields,chosen-1),'22023');
  perform pg_temp.gift_assert(not exists(select 1 from public.garage_orders where vehicle='Synthetic gift visit'),'ineligible creation rolled back');
  reply:=public.garage_save_order_with_gift('new',null,null,fields,chosen,0,request);
  ord:=(reply->>'order_id')::uuid;
  perform pg_temp.gift_assert(public.garage_save_order_with_gift('new',null,null,fields,chosen,0,request)=reply,'creation replay');
  select x into strict gift from jsonb_array_elements(public.garage_order_financials(ord)->'tasks') x where x->>'work_code'='W09';
  task:=(gift->>'task_id')::uuid;
  perform pg_temp.gift_assert(gift->>'catalogue_kopeks'='789' and gift->>'override_kopeks'='0' and gift->>'effective_tax_kopeks'='0'
    and gift->>'effective_gross_kopeks'='0' and gift->>'private_version'='1','gift has zero customer total and retains catalogue rate');
  perform pg_temp.gift_assert((select count(*)=3 from public.garage_order_tasks where order_id=ord),'one gift and two qualifying works');
  select jsonb_agg(jsonb_build_object('id',t.id,'work_code',t.work_code) order by t.work_code) into retained
    from public.garage_order_tasks t where order_id=ord;
  perform public.garage_save_task_pricing(task,1,10,'Keep this private comment',gen_random_uuid());
  select o.version into expected_ver from public.garage_orders o where o.id=ord;
  perform pg_temp.gift_denied(format('select garage_save_order_with_gift(''edit'',%L,%s,%L,%L,1,gen_random_uuid())',
    ord,expected_ver,fields||'{"colour":"stale"}',retained),'40001');
  perform pg_temp.gift_assert((select o.colour='' and o.version=expected_ver from public.garage_orders o where o.id=ord),'stale price aborts all operational edits');
  request:=gen_random_uuid();
  reply:=public.garage_save_order_with_gift('edit',ord,expected_ver,fields||'{"colour":"Blue"}',retained,2,request);
  perform pg_temp.gift_assert(public.garage_save_order_with_gift('edit',ord,expected_ver,fields||'{"colour":"Blue"}',retained,2,request)=reply,'edit replay');
  select x into strict gift from jsonb_array_elements(public.garage_order_financials(ord)->'tasks') x where x->>'work_code'='W09';
  perform pg_temp.gift_assert(gift->>'private_version'='3' and gift->>'private_comment'='Keep this private comment'
    and gift->>'override_kopeks'='0','reapplying gift preserves comment and creates one revision');
  perform pg_temp.gift_assert((select count(*)=3 from public.garage_order_tasks where order_id=ord),'edit retains task identities');

  fields:=fields||'{"vehicle":"Intake gift vehicle","vin":"TEST0000000000101","planned_date":"2026-11-18","manager_label":"Synthetic manager"}';
  perform pg_temp.gift_denied(format('select garage_save_order_with_gift(''intake'',%L,1,%L,%L,0,gen_random_uuid())',intake_id,fields,chosen-1),'22023');
  perform pg_temp.gift_assert((select i.order_id is null and i.version=1 from public.garage_manager_intake i where i.id=intake_id),'failed gift rolls back intake publication and links');
  request:=gen_random_uuid();
  reply:=public.garage_save_order_with_gift('intake',intake_id,1,fields,chosen,0,request);
  intake_order:=(reply->>'order_id')::uuid;
  perform pg_temp.gift_assert(public.garage_save_order_with_gift('intake',intake_id,1,fields,chosen,0,request)=reply,'intake replay');
  perform pg_temp.gift_assert((select i.order_id=intake_order and i.owner_managed from public.garage_manager_intake i where i.id=intake_id)
    and (select count(*)=3 from public.garage_order_tasks where order_id=intake_order),'successful intake publishes once');

  perform set_config('request.jwt.claim.sub',a::text,true);
  select (x->>'version')::integer into expected_ver from jsonb_array_elements(public.garage_list_orders()) x where x->>'id'=ord::text;
  perform public.garage_vehicle_action(ord,'take',expected_ver,gen_random_uuid());
  select (t->>'version')::integer into expected_ver from jsonb_array_elements(public.garage_list_orders()) x
    cross join lateral jsonb_array_elements(x->'tasks') t where t->>'id'=task::text;
  perform public.garage_team_action(task,'join',expected_ver,gen_random_uuid());
  select (t->>'version')::integer into expected_ver from jsonb_array_elements(public.garage_list_orders()) x
    cross join lateral jsonb_array_elements(x->'tasks') t where t->>'id'=task::text;
  perform public.garage_team_action(task,'confirm',expected_ver,gen_random_uuid());
  perform pg_temp.gift_assert(public.garage_list_orders()::text !~ 'Keep this private comment|override_kopeks|qualifying_count','mechanic sees only the operational service');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  select x into strict gift from jsonb_array_elements(public.garage_pay_worklist()) x where x->>'task_id'=task::text;
  perform pg_temp.gift_assert(gift->>'effective_kopeks'='0' and gift->>'suggested_pool_kopeks'='789'
    and gift->'suggested_shares'->0->>'kopeks'='789' and gift->'pool_kopeks'='null','gift completion proposes full listed mechanic pay');
end $$;
rollback;
