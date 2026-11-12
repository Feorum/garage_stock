\set ON_ERROR_STOP on
-- Isolated synthetic fixtures only. Never run this file against a live project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key,email text not null,raw_user_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
\i /tmp/garage-schema.sql
grant select,insert,update,delete on all tables in schema public to anon,authenticated;
grant usage,select on all sequences in schema public to anon,authenticated;
alter default privileges in schema public grant select,insert,update,delete on tables to anon,authenticated;
alter default privileges in schema public grant usage,select on sequences to anon,authenticated;
insert into auth.users(id,email,raw_user_meta_data) values
 ('00000000-0000-4000-8000-000000000001','owner@example.invalid','{"name":"Synthetic Owner"}'),
 ('00000000-0000-4000-8000-000000000002','mechanic@example.invalid','{"name":"Synthetic Mechanic"}'),
 ('00000000-0000-4000-8000-000000000003','other-owner@example.invalid','{"name":"Other Synthetic Owner"}');
update profiles set role='admin' where id in ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003');
\i /tmp/garage-orders.sql
\i /tmp/garage-manager.sql

create function test_assert(ok boolean,label text) returns void language plpgsql as $$begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %',label; end if;
  raise notice 'PASS: %',label;
end$$;
create function test_error(statement text,label text,expected_state text default null) returns void language plpgsql as $$
declare failed boolean:=false; begin
  begin execute statement; exception when others then failed:=true;
    if expected_state is not null and sqlstate<>expected_state then raise exception 'Unexpected SQLSTATE % for %: %',sqlstate,label,sqlerrm; end if;
  end;
  perform test_assert(failed,label);
end$$;
create function test_payload(p_submission uuid,p_external uuid,p_line uuid,p_revision int default 1,p_expected int default null,p_work text default 'W01') returns jsonb
language sql as $$select jsonb_build_object('schema_version',1,'spreadsheet_id','synthetic-sheet-source-a',
  'submission_id',p_submission,'external_order_id',p_external,'revision',p_revision,'expected_order_version',p_expected,'action','submit',
  'order',jsonb_build_object('vehicle','Synthetic source vehicle','vehicle_group_code','VG02','manager_label','Unverified source label',
    'planned_date','2026-11-20','instructions','Synthetic operational scope'),
  'tasks',jsonb_build_array(jsonb_build_object('external_task_id',p_line,'work_code',p_work,'options','{}'::jsonb)))$$;

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_register_sheet('Synthetic source','synthetic-sheet-source-a','10000000-0000-4000-8000-000000000001',repeat('s',40));
select test_assert(jsonb_array_length(garage_sheet_sources())=1,'Owner can list its source safely');
select test_assert(not(garage_sheet_sources()->0 ? 'secret_hash'),'Owner list excludes credential hash');
select test_assert(not(garage_sheet_sources()->0 ? 'secret'),'Owner list excludes plaintext credential');
select garage_register_sheet('Synthetic source','synthetic-sheet-source-a','10000000-0000-4000-8000-000000000001',repeat('s',40));
select test_assert(jsonb_array_length(garage_sheet_sources())=1,'Registration retry does not duplicate source');
select test_error($q$select garage_register_sheet('Changed','synthetic-sheet-source-a','10000000-0000-4000-8000-000000000001',repeat('s',40))$q$,'Registration identity cannot overwrite source','40001');
select test_error($q$select secret_hash from garage_sheet_sources$q$,'Credential hash is not directly readable','42501');
select garage_register_sheet('Second source','synthetic-sheet-source-b','10000000-0000-4000-8000-000000000002',repeat('b',40));
select garage_rotate_sheet_secret('10000000-0000-4000-8000-000000000002',repeat('c',40),1);
select garage_rotate_sheet_secret('10000000-0000-4000-8000-000000000002',repeat('c',40),1);
select test_assert((select version=2 from garage_sheet_sources where id='10000000-0000-4000-8000-000000000002'),'Rotation lost-response replay is idempotent');
select test_error($q$select garage_rotate_sheet_secret('10000000-0000-4000-8000-000000000002',repeat('d',40),1)$q$,'Stale rotation rejected','40001');
select garage_create_order('Owner-only synthetic','VG02','owner','[{"work_code":"W01","assigned_to":"00000000-0000-4000-8000-000000000002"}]','20000000-0000-4000-8000-000000000001')->>'order_id' as owner_order \gset

set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select test_assert(garage_sheet_sources()='[]'::jsonb,'Another Owner cannot list first Owner sources');
select test_error($q$select garage_rotate_sheet_secret('10000000-0000-4000-8000-000000000001',repeat('x',40),1)$q$,'Another Owner cannot rotate source','42501');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select test_assert((select count(*)=0 from garage_sheet_sources),'Mechanic cannot read source metadata rows');
select test_error($q$select garage_sheet_sources()$q$,'Mechanic source RPC denied','42501');
select test_error($q$select garage_register_sheet('Bad','synthetic-source-z','10000000-0000-4000-8000-000000000099',repeat('z',40))$q$,'Mechanic cannot register a source','42501');
select test_error($q$select garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),'{}')$q$,'Browser role cannot call ingestion RPC even with credential','42501');
reset role;

set role service_role;
set request.jwt.claim.sub='';
select test_error($q$select garage_sheet_status('10000000-0000-4000-8000-000000000001',repeat('z',40))$q$,'Incorrect source credential denied','42501');
select test_error($q$select garage_sheet_status('10000000-0000-4000-8000-000000000002',repeat('b',40))$q$,'Rotated old credential denied','42501');
select garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001')) as first_receipt \gset
select test_assert(:'first_receipt'::jsonb->>'status'='accepted','Valid Manager order publishes automatically');
select test_assert(current_setting('request.jwt.claim.sub',true)='','Ingestion restores service caller claims');
select test_assert((select count(*)=1 from garage_sheet_orders),'Exactly one imported order link');
select test_assert((select count(*)=1 from garage_orders where source='manager'),'Source cannot create Owner assignments');
select test_assert((select bool_and(assigned_to is null) from garage_order_tasks where order_id in(select order_id from garage_sheet_orders)),'Imported tasks remain self-selected');
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001'))=:'first_receipt'::jsonb,'Identical submission returns original receipt');
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001')||'{"revision":2}')#>>'{error,code}'='SUBMISSION_ID_REUSED','Changed content cannot reuse accepted submission ID');

select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002')||'{"spreadsheet_id":"synthetic-sheet-source-b"}')#>>'{error,code}'='SPREADSHEET_MISMATCH','Credential cannot claim another spreadsheet identity');
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000003')||'{"price":99}')#>>'{error,code}'='UNSUPPORTED_FIELDS','Top-level financial fields rejected');
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  jsonb_set(test_payload('30000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000004','50000000-0000-4000-8000-000000000004'),'{tasks,0,assigned_to}','"00000000-0000-4000-8000-000000000002"'))#>>'{error,code}'='UNSUPPORTED_FIELDS','Task assignment fields rejected');
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000005',1,null,'NOT-APPROVED'))->>'status'='rejected','Unknown work rejected without partial creation');
select test_assert((select count(*)=1 from garage_sheet_orders),'Rejected submissions create no partial order links');
select test_assert((select count(*)=2 from garage_orders),'Rejected submissions preserve only Owner and accepted Manager order');

select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000006','40000000-0000-4000-8000-000000000006','50000000-0000-4000-8000-000000000001'))->>'status'='conflict','Task identity cannot move to another source order');
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000007',:'owner_order'::uuid,'50000000-0000-4000-8000-000000000007',2,1))->>'status'='conflict','Internal Owner UUID does not grant import authority');
select test_assert((select source='owner' and version=1 from garage_orders where id=:'owner_order'),'Owner order remains unchanged');

select task_id as original_task from garage_sheet_tasks where external_task_id='50000000-0000-4000-8000-000000000001' \gset
select garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000008','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',2,1,'W02')) as revision_receipt \gset
select test_assert(:'revision_receipt'::jsonb->>'status'='accepted','Pending revision accepted atomically');
select test_assert((select status='cancelled' from garage_order_tasks where id=:'original_task'),'Previous task preserved as superseded');
select test_assert((select count(*)=1 from garage_task_financials where task_id=:'original_task'),'Previous private snapshot retained');
select test_assert((select count(*)=2 from garage_sheet_task_versions where external_task_id='50000000-0000-4000-8000-000000000001'),'Per-revision external task bindings retain superseded task identity');
select test_assert((select scope_snapshot#>>'{tasks,0,work_code}'='W01' from garage_sheet_submissions where submission_id='30000000-0000-4000-8000-000000000001'),'Accepted source scope remains available in private history');
select test_assert((select t.work_code='W02' and t.status='pending' from garage_sheet_tasks st join garage_order_tasks t on t.id=st.task_id where st.external_task_id='50000000-0000-4000-8000-000000000001'),'Stable external task points at replacement');
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000009','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',4,2))->>'status'='conflict','Out-of-order source revisions rejected');
select task_id as current_task from garage_sheet_tasks where external_task_id='50000000-0000-4000-8000-000000000001' \gset
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_task_action(:'current_task','start',1,'60000000-0000-4000-8000-000000000001');
reset role;
set role service_role;
set request.jwt.claim.sub='';
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000010','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',3,2))->>'status'='conflict','Mechanic progress prevents spreadsheet amendment');
select test_assert((select status='in_progress' from garage_order_tasks where id=:'current_task'),'Conflict preserves execution history');
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),
  test_payload('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001'))=:'first_receipt'::jsonb,'Lost-response replay remains original after mechanic progress');
select garage_sheet_status('10000000-0000-4000-8000-000000000001',repeat('s',40)) as status_receipt \gset
select test_assert(:'status_receipt'::jsonb#>>'{orders,0,tasks,0,status}'='in_progress','Status feedback reflects actual execution');
select test_assert(:'status_receipt' !~ 'net_amount|gross_amount|vat_|secret_hash|"task_id"[ ]*:|"order_id"[ ]*:','Status excludes financial, credentials and internal IDs');
select test_assert(current_setting('request.jwt.claim.sub',true)='','Rejected amendment restores caller claims');

-- Identical external IDs in another registered source create an independent order.
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000002',repeat('c',40),
  test_payload('30000000-0000-4000-8000-000000000011','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001')||'{"spreadsheet_id":"synthetic-sheet-source-b"}')->>'status'='accepted','Copied IDs remain scoped to a different registered source');
select test_assert((select count(distinct order_id)=2 from garage_sheet_orders where external_order_id='40000000-0000-4000-8000-000000000001'),'Source-scoped identity does not overwrite another order');
select task_id as second_source_task from garage_sheet_tasks where source_id='10000000-0000-4000-8000-000000000002' and external_task_id='50000000-0000-4000-8000-000000000001' \gset
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000002',repeat('c',40),
  jsonb_set(test_payload('30000000-0000-4000-8000-000000000013','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',2,1)||'{"spreadsheet_id":"synthetic-sheet-source-b"}',
    '{order,instructions}','"Changed operational instructions"'))->>'status'='accepted','Cosmetic pending amendments accepted');
select test_assert((select task_id=:'second_source_task'::uuid from garage_sheet_tasks where source_id='10000000-0000-4000-8000-000000000002' and external_task_id='50000000-0000-4000-8000-000000000001'),'Cosmetic edits preserve task identity and frozen rate');
select test_assert((select count(*)=1 from garage_task_financials where task_id=:'second_source_task'),'Cosmetic edits do not create another financial snapshot');
select test_assert(garage_ingest_sheet('10000000-0000-4000-8000-000000000002',repeat('c',40),
  (test_payload('30000000-0000-4000-8000-000000000012','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',3,2)||'{"spreadsheet_id":"synthetic-sheet-source-b","action":"cancel"}'))#>>'{order_status}'='cancelled','Untouched order cancellation is acknowledged');
select test_assert((garage_sheet_status('10000000-0000-4000-8000-000000000002',repeat('c',40))#>>'{orders,0,tasks,0,status}')='cancelled','Cancellation feedback retains task identity');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_set_sheet_active('10000000-0000-4000-8000-000000000002',false,2);
reset role;
set role service_role;
select test_error($q$select garage_sheet_status('10000000-0000-4000-8000-000000000002',repeat('c',40))$q$,'Paused source cannot authenticate','42501');
reset role;
set role anon;
select test_error($q$select garage_sheet_sources()$q$,'Anonymous source list denied','42501');
select test_error($q$select garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),'{}')$q$,'Anonymous ingestion RPC denied','42501');
reset role;
select 'MANAGER_SUBMISSION_CHECKS_PASSED' as result;
