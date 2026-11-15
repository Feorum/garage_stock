\set ON_ERROR_STOP on
-- Isolated synthetic PostgreSQL only. Never execute these fixtures in production.
\i /tmp/owner-edit-test.sql
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_connect_sheet_pull('Identity guard source','synthetic-owner-guard-sheet','12346')->>'id' as guard_source \gset
select garage_prepare_sheet_reader(:'guard_source',repeat('v',40),1);
reset role;
set role service_role;
set request.jwt.claim.sub='';
select garage_acquire_sheet_reader(:'guard_source',repeat('v',40),'synthetic-owner-guard-sheet','12346') as guard_lease \gset
select garage_capture_manager_rows(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(91,'13.12','TEST0000000000201','Historical free writing')));
reset role;
select id as historical_intake from garage_manager_intake where source_id=:'guard_source' \gset
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_publish_manager_intake(:'historical_intake',1,test_interpreted_order('2026-12-13')||'{"vin":"TEST0000000000201"}',
  '[{"work_code":"W09"}]',gen_random_uuid())->>'order_id' as historical_order \gset
select id as historical_task from garage_order_tasks where order_id=:'historical_order' \gset
select garage_edit_order(:'historical_order',1,test_interpreted_order('2026-12-14')||'{"vin":"TEST0000000000201"}',
  jsonb_build_array(jsonb_build_object('id',:'historical_task','work_code','W09')),gen_random_uuid());
select garage_edit_order(:'historical_order',2,test_interpreted_order()||'{"vin":"","planned_date":null}',
  jsonb_build_array(jsonb_build_object('id',:'historical_task','work_code','W09')),gen_random_uuid());
reset role;
select test_assert((select original_source_key is null and owner_canonical_key is null from garage_manager_intake where id=:'historical_intake'),
  'Pre-upgrade fixture reproduces an originally incomplete identity whose latest Owner identity was cleared');
\i /tmp/garage-owner-guards.sql
select test_assert((select owner_source_keys=array['2026-12-13|TEST0000000000201','2026-12-14|TEST0000000000201']
  from garage_manager_intake where id=:'historical_intake'),'Backfill recovers every successful prior Owner interpretation from immutable request receipts');
set role service_role;
select test_assert(garage_ingest_sheet(:'edit_source',repeat('u',40),:'auto_payload')=:'auto_receipt'::jsonb,
  'The alias guard preserves exact replay of accepted submissions');
select test_assert(garage_ingest_sheet(:'edit_source',repeat('u',40),:'auto_payload'::jsonb||'{"revision":2}')->'error'->>'code'='SUBMISSION_ID_REUSED',
  'Accepted submission IDs still reject changed payloads after the guard upgrade');
reset role;

-- Every missing/expired lease component must fail closed, without capturing rows.
set role service_role;
select test_error(format('select garage_capture_manager_rows(%L,null,1,''[]'')',:'guard_source'),'Null caller lease is rejected','40001');
reset role;
select test_error(format('update garage_sheet_pull_feeds set lease_expires_at=null where source_id=%L',:'guard_source'),
  'The schema rejects a half-empty lease with no expiry','23514');
select test_error(format('update garage_sheet_pull_feeds set lease_token=null where source_id=%L',:'guard_source'),
  'The schema rejects a half-empty lease with no token','23514');
update garage_sheet_pull_feeds set lease_token=null,lease_expires_at=null where source_id=:'guard_source';
set role service_role;
select test_error(format('select garage_capture_manager_rows(%L,%L,1,''[]'')',:'guard_source',:'guard_lease'::jsonb->>'lease_token'),
  'A previously valid token cannot use the now-null lease/expiry','40001');
select test_error(format('select garage_capture_manager_rows(%L,null,1,''[]'')',:'guard_source'),'An entirely unleased feed cannot capture','40001');
reset role;
update garage_sheet_pull_feeds set lease_token=(:'guard_lease'::jsonb->>'lease_token')::uuid,
  lease_expires_at=clock_timestamp()-interval '1 second' where source_id=:'guard_source';
set role service_role;
select test_error(format('select garage_capture_manager_rows(%L,%L,1,''[]'')',:'guard_source',:'guard_lease'::jsonb->>'lease_token'),
  'An expired lease cannot capture','40001');
reset role;
select test_assert((select count(*)=1 and min(version)=4 from garage_manager_intake where source_id=:'guard_source'),
  'Rejected captures leave private intake data and versions untouched');
update garage_sheet_pull_feeds set lease_expires_at=clock_timestamp()+interval '5 minutes' where source_id=:'guard_source';

-- New interpretations retain aliases through K1 -> K2 -> cleared, too.
set role service_role;
select garage_capture_manager_rows(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(92,'15.12','TEST0000000000202','New free writing')));
reset role;
select id as new_intake from garage_manager_intake where source_id=:'guard_source' and not owner_managed \gset
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_publish_manager_intake(:'new_intake',1,test_interpreted_order('2026-12-15')||'{"vin":"TEST0000000000202"}',
  '[{"work_code":"W09"}]',gen_random_uuid())->>'order_id' as new_order \gset
select id as new_task from garage_order_tasks where order_id=:'new_order' \gset
select garage_edit_order(:'new_order',1,test_interpreted_order('2026-12-16')||'{"vin":"TEST0000000000202"}',
  jsonb_build_array(jsonb_build_object('id',:'new_task','work_code','W09')),gen_random_uuid());
select garage_edit_order(:'new_order',2,test_interpreted_order()||'{"vin":"","planned_date":null}',
  jsonb_build_array(jsonb_build_object('id',:'new_task','work_code','W09')),gen_random_uuid());
reset role;
select test_assert((select owner_canonical_key is null and owner_source_keys=array['2026-12-15|TEST0000000000202','2026-12-16|TEST0000000000202']
  from garage_manager_intake where id=:'new_intake'),'Every later canonical identity stays reserved after the current identity is cleared');

-- Returning source rows link through all old aliases, without new intake/order IDs.
set role service_role;
select garage_capture_manager_rows(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1,jsonb_build_array(
  test_manager_row(191,'2026-12-13','TEST0000000000201','Later correction of historical source'),
  test_manager_row(192,'2026-12-15','TEST0000000000202','First corrected identity'),
  test_manager_row(193,'2026-12-16','TEST0000000000202','Second corrected identity'))) as alias_capture \gset
select test_assert(:'alias_capture'::jsonb->'owner_managed_keys' @> '["2026-12-13|TEST0000000000201","2026-12-14|TEST0000000000201","2026-12-15|TEST0000000000202","2026-12-16|TEST0000000000202"]',
  'Capture returns all historical aliases so durable pending requests can be retired');
select test_assert(:'alias_capture'::jsonb->'owner_managed_rows' @> '[191,192,193]',
  'Every current source occurrence is suppressed through the retained aliases');
select test_assert(:'alias_capture'::jsonb->>'version'='1','Alias capture preserves importer CAS version');
reset role;
select test_assert((select count(*)=2 from garage_manager_intake where source_id=:'guard_source'),'Old corrected identities create no additional private intakes');
select test_assert((select row_numbers=array[192,193] and jsonb_array_length(observations)=2
  and original_snapshot->>'wrapping'='New free writing' from garage_manager_intake where id=:'new_intake'),
  'Concurrent old aliases preserve both current observations and the immutable original');
set role service_role;
select test_assert(bool_and(garage_ingest_sheet(:'guard_source',repeat('v',40),jsonb_build_object('schema_version',1,
  'spreadsheet_id','synthetic-owner-guard-sheet','submission_id',gen_random_uuid(),'external_order_id',gen_random_uuid(),
  'revision',1,'action','submit','expected_order_version',null,
  'order',test_interpreted_order(v.visit)||jsonb_build_object('vin',v.vin),
  'tasks',jsonb_build_array(jsonb_build_object('external_task_id',gen_random_uuid(),'work_code','W09','options','{}'::jsonb))))->'error'->>'code'='ORDER_CHANGED'),
  'Every historical alias blocks automatic duplicates even with fresh external IDs')
  from (values ('2026-12-13','TEST0000000000201'),('2026-12-14','TEST0000000000201'),
    ('2026-12-15','TEST0000000000202'),('2026-12-16','TEST0000000000202')) v(visit,vin);
reset role;
select test_assert((select count(*)=2 from garage_sheet_orders where source_id=:'guard_source'),'Alias submissions never create another order');

-- Both publication and editing must honor another order's historical reservation.
set role service_role;
select garage_capture_manager_rows(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(194,'17.12','TEST0000000000203','Another request')));
reset role;
select id as collision_intake from garage_manager_intake where source_id=:'guard_source' and not owner_managed \gset
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_error(format('select garage_publish_manager_intake(%L,1,%L,''[{"work_code":"W09"}]'',gen_random_uuid())',
  :'collision_intake',test_interpreted_order(v.visit)||jsonb_build_object('vin',v.vin)),
  'New Owner publication cannot reuse a historical alias','40001')
  from (values ('2026-12-13','TEST0000000000201'),('2026-12-14','TEST0000000000201'),
    ('2026-12-15','TEST0000000000202'),('2026-12-16','TEST0000000000202')) v(visit,vin);
select garage_publish_manager_intake(:'collision_intake',1,test_interpreted_order('2026-12-17')||'{"vin":"TEST0000000000203"}',
  '[{"work_code":"W09"}]',gen_random_uuid())->>'order_id' as collision_order \gset
select id as collision_task from garage_order_tasks where order_id=:'collision_order' \gset
select test_error(format('select garage_edit_order(%L,1,%L,%L,gen_random_uuid())',:'collision_order',
  test_interpreted_order(v.visit)||jsonb_build_object('vin',v.vin),jsonb_build_array(jsonb_build_object('id',:'collision_task','work_code','W09'))),
  'Existing Owner order cannot adopt another order historical alias','40001')
  from (values ('2026-12-13','TEST0000000000201'),('2026-12-14','TEST0000000000201'),
    ('2026-12-15','TEST0000000000202'),('2026-12-16','TEST0000000000202')) v(visit,vin);
select test_assert((select version=1 and vin='TEST0000000000203' from garage_orders where id=:'collision_order'),
  'Failed alias collisions roll back order fields, tasks and versions');
select test_assert(not exists(select 1 from jsonb_array_elements(garage_list_orders()) o where o ? 'owner_source_keys')
  and not exists(select 1 from jsonb_array_elements(garage_manager_intakes()) i where i ? 'owner_source_keys'),
  'Internal aliases do not expand existing RPC response contracts');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select test_assert((select count(*)=0 from garage_manager_intake),'Mechanic RLS still hides private alias/source evidence');
reset role;
select test_assert(not has_function_privilege('anon','garage_preserve_intake_keys()','execute')
  and not has_function_privilege('authenticated','garage_preserve_intake_keys()','execute')
  and not has_function_privilege('service_role','garage_preserve_intake_keys()','execute'),'Private reservation helper is not an RPC');
select test_assert(exists(select 1 from garage_schema_migrations where version='20261115022416'),'Identity guards migration recorded');
