\set ON_ERROR_STOP on
-- Isolated fixtures only. Includes the preceding workflow and identity suites.
\i /tmp/owner-guards-test.sql
reset role;
\i /tmp/garage-manager-comments.sql
\i /tmp/garage-sheet-feedback.sql
\i /tmp/garage-omitted-work.sql

select test_assert(not has_table_privilege('authenticated','garage_sheet_feedback_outputs','SELECT')
  and not has_table_privilege('service_role','garage_sheet_feedback_outputs','SELECT'),'Issued feedback ledger is private');
select test_assert(not has_function_privilege('authenticated','garage_sheet_feedback(uuid,uuid,integer)','EXECUTE')
  and not has_function_privilege('anon','garage_sync_manager_comments(uuid,uuid,integer,jsonb)','EXECUTE'),
  'Only the source server can request feedback or publish Manager comments');
select test_assert(not has_function_privilege('service_role','garage_record_omitted_completion(uuid,integer,text,jsonb,uuid,timestamptz,text,uuid)','EXECUTE'),
  'Source credentials cannot impersonate Owner completion corrections');
update garage_sheet_pull_feeds set lease_expires_at=clock_timestamp()+interval '5 minutes' where source_id=:'guard_source';
set role service_role;
select test_error(format('select garage_sheet_feedback(%L,null,1)',:'guard_source'),'Feedback rejects missing lease','40001');
select test_error(format('select garage_sheet_feedback(%L,%L,99)',:'guard_source',:'guard_lease'::jsonb->>'lease_token'),
  'Feedback rejects stale version','40001');
select garage_sheet_feedback(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1) as initial_feedback \gset
reset role;
select test_assert(:'initial_feedback'::jsonb->>'version'='1','Feedback issuance preserves importer CAS version');
select test_assert(exists(select 1 from jsonb_array_elements(:'initial_feedback'::jsonb->'rows') r
  where r->>'order_id'=:'collision_order' and not(r->>'complete')::boolean),'An unfinished order is never shown as complete');
select test_assert(exists(select 1 from jsonb_array_elements(:'initial_feedback'::jsonb->'rows') r
  where r->>'order_id'=:'new_order' and r->'source_keys' @> '["2026-12-15|TEST0000000000202","2026-12-16|TEST0000000000202"]'),
  'Feedback retains every source identity after Owner clears current VIN and date');
select test_assert(:'initial_feedback' not like '%net_amount%' and :'initial_feedback' not like '%price_list%'
  and :'initial_feedback' not like '%Original manual note%' and :'initial_feedback' not like '%PRIVATE_ORIGINAL%',
  'Feedback contains neither financial fields nor private original Manager notes');
select version as before_comment_version,instructions as before_comment_instructions from garage_orders where id=:'collision_order' \gset
set role service_role;
select garage_sync_manager_comments(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1,
  '[{"source_key":"2026-12-17|TEST0000000000203","comment":"Call before starting."}]');
reset role;
select test_assert((select manager_comment='Call before starting.' and version=:'before_comment_version'
  and instructions=:'before_comment_instructions' from garage_orders where id=:'collision_order'),
  'Manager comment updates do not revise Owner scope, instructions or optimistic edit version');
set role service_role;
select garage_sync_manager_comments(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1,
  '[{"source_key":"2026-12-17|TEST0000000000203","comment":"Cost $100"}]') as withheld_comment \gset
select garage_sync_manager_comments(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1,
  '[{"source_key":"2026-12-17|TEST0000000000203","comment":"One"},{"source_key":"2026-12-17|TEST0000000000203","comment":"Two"}]');
reset role;
select test_assert(:'withheld_comment'::jsonb->>'withheld'='1' and (select manager_comment='Call before starting.'
  from garage_orders where id=:'collision_order'),'Confidential or conflicting duplicate comments never replace safe operational comments');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select test_assert(exists(select 1 from jsonb_array_elements(garage_list_orders()) o where o->>'id'=:'collision_order'
  and o->>'manager_comment'='Call before starting.'),'Mechanic can read the independently refreshed Manager comment');
select test_error(format('select garage_record_omitted_completion(%L,1,''W10'',''{}'',auth.uid(),now(),''Correction'',gen_random_uuid())',:'collision_order'),
  'Mechanic cannot record Owner corrections','42501');
select garage_task_action(:'collision_task','start',1,gen_random_uuid());
select garage_task_action(:'collision_task','complete',2,gen_random_uuid());
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select version as before_close_version from garage_orders where id=:'collision_order' \gset
select garage_order_action(:'collision_order','close',:'before_close_version',gen_random_uuid());
reset role;
select version as closed_version,closed_at as original_closed_at from garage_orders where id=:'collision_order' \gset
select to_jsonb(c) as original_completion from garage_task_completions c where task_id=:'collision_task' \gset
select to_jsonb(f) as original_financial from garage_task_financials f where task_id=:'collision_task' \gset
set role service_role;
select garage_sheet_feedback(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1) as completed_feedback \gset
reset role;
select test_assert(exists(select 1 from jsonb_array_elements(:'completed_feedback'::jsonb->'rows') r
  where r->>'order_id'=:'collision_order' and (r->>'complete')::boolean
    and r->'tasks'->0->>'mechanic_name'='Synthetic Mechanic' and r->>'block' like '%Synthetic Mechanic%'),
  'Completed feedback uses the immutable actual mechanic completion record');
select count(*) as issued_count from garage_sheet_feedback_outputs where source_id=:'guard_source' \gset
set role service_role;
select garage_sheet_feedback(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1);
reset role;
select test_assert((select count(*)=:'issued_count' from garage_sheet_feedback_outputs where source_id=:'guard_source'),
  'Repeated unchanged feedback produces no extra output ledger row');

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_error(format('select garage_record_omitted_completion(%L,%s,''W10'',''{}'',%L,now()+interval ''1 day'',''Correction'',gen_random_uuid())',
  :'collision_order',:'closed_version','00000000-0000-4000-8000-000000000002'),'Future physical completion cannot be invented');
select test_error(format('select garage_record_omitted_completion(%L,%s,''W10'',''{}'',%L,now(),'''',gen_random_uuid())',
  :'collision_order',:'closed_version','00000000-0000-4000-8000-000000000002'),'Omitted work requires an audit reason');
select test_error(format('select garage_record_omitted_completion(%L,%s,''W10'',''{}'',%L,now(),''Price $10'',gen_random_uuid())',
  :'collision_order',:'closed_version','00000000-0000-4000-8000-000000000002'),'Correction reason cannot leak financial notes');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select test_error(format('select garage_record_omitted_completion(%L,%s,''W10'',''{}'',%L,now(),''Correction'',gen_random_uuid())',
  :'collision_order',:'closed_version','00000000-0000-4000-8000-000000000002'),'Another Owner cannot correct this private Manager source','42501');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select clock_timestamp()-interval '1 minute' as correction_time \gset
select garage_record_omitted_completion(:'collision_order',:'closed_version','W10','{}','00000000-0000-4000-8000-000000000002',
  :'correction_time','Owner confirmed previously performed work omitted from selection.','73000000-0000-4000-8000-000000000001') as correction \gset
select garage_record_omitted_completion(:'collision_order',:'closed_version','W10','{}','00000000-0000-4000-8000-000000000002',
  :'correction_time','Owner confirmed previously performed work omitted from selection.','73000000-0000-4000-8000-000000000001') as correction_replay \gset
select test_assert(:'correction'::jsonb=:'correction_replay'::jsonb,'Lost correction response replays the same immutable completion');
select test_error(format('select garage_record_omitted_completion(%L,%s,''W10'',''{}'',%L,now(),''Repeated'',gen_random_uuid())',
  :'collision_order',(:'correction'::jsonb->>'order_version')::integer,'00000000-0000-4000-8000-000000000002'),
  'Duplicate approved work cannot be recorded twice','40001');
reset role;
select test_assert((select count(*)=2 from garage_task_completions where order_id=:'collision_order')
  and (select to_jsonb(c)=:'original_completion'::jsonb from garage_task_completions c where task_id=:'collision_task')
  and (select to_jsonb(f)=:'original_financial'::jsonb from garage_task_financials f where task_id=:'collision_task'),
  'Correction appends one completion and preserves the original execution and financial snapshot exactly');
select test_assert((select status='closed' and closed_at=:'original_closed_at' from garage_orders where id=:'collision_order')
  and exists(select 1 from garage_task_events where task_id=(:'correction'::jsonb->>'task_id')::uuid
    and actor_id='00000000-0000-4000-8000-000000000001' and action='record_omitted_completion'),
  'Closed status and original closing time remain intact and the Owner correction has an audit actor');
select test_assert(exists(select 1 from garage_task_financials where task_id=(:'correction'::jsonb->>'task_id')::uuid
  and pricing_status='needs_pricing'),'Omitted work without an approved rate remains explicitly unpriced');
set role service_role;
select garage_sheet_feedback(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1) as corrected_feedback \gset
reset role;
select test_assert(exists(select 1 from jsonb_array_elements(:'corrected_feedback'::jsonb->'rows') r where r->>'order_id'=:'collision_order'
  and jsonb_array_length(r->'tasks')=2 and jsonb_array_length(r->'known_outputs')=3
  and (r->>'complete')::boolean),'Feedback includes omitted work and retains all earlier issued blocks for safe reconciliation');

-- Prove the origin flag only labels imported prose, never Owner instructions.
set role service_role;
select garage_ingest_sheet(:'guard_source',repeat('v',40),test_payload('74000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000003')||
  '{"spreadsheet_id":"synthetic-owner-guard-sheet","order":{"vehicle":"Synthetic automatic vehicle","vehicle_group_code":"VG02","vin":"TEST0000000000204","planned_date":"2026-12-20","instructions":"Original automatic Manager note"},"tasks":[{"external_task_id":"74000000-0000-4000-8000-000000000003","work_code":"W01","options":{}},{"external_task_id":"74000000-0000-4000-8000-000000000004","work_code":"W19","options":{"tint_percent":5}}]}');
select garage_sync_manager_comments(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1,
  '[{"source_key":"2026-12-20|TEST0000000000204","comment":"Updated Manager comment"}]');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_assert(exists(select 1 from jsonb_array_elements(garage_list_orders()) o where o->>'vin'='TEST0000000000204'
  and (o->>'instructions_from_manager')::boolean and o->>'manager_comment'='Updated Manager comment'
  and o->>'instructions'='Original automatic Manager note' and o->>'manager_comment_updated_at' is not null),
  'Automatic instructions retain evidence while their origin flag permits displaying only the latest Manager comment');
select test_assert(exists(select 1 from jsonb_array_elements(garage_list_orders()) o where o->>'id'=:'collision_order'
  and not(o->>'instructions_from_manager')::boolean),'An Owner-managed order never labels Owner instructions as stale Manager prose');
reset role;
select id as partial_order from garage_orders where vin='TEST0000000000204' \gset
select id as partial_task from garage_order_tasks where order_id=:'partial_order' and work_code='W01' \gset
select id as cancelled_task from garage_order_tasks where order_id=:'partial_order' and work_code='W19' \gset
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_task_action(:'partial_task','start',1,gen_random_uuid());
select garage_task_action(:'partial_task','complete',2,gen_random_uuid());
reset role;
set role service_role;
select garage_sheet_feedback(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1) as partial_feedback \gset
reset role;
select test_assert(exists(select 1 from jsonb_array_elements(:'partial_feedback'::jsonb->'rows') r where r->>'order_id'=:'partial_order'
  and not(r->>'complete')::boolean and r->>'block' like '%Synthetic Mechanic%'),'Partial completion reports its mechanic but keeps the checkbox unchecked');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_task_action(:'cancelled_task','cancel',1,gen_random_uuid(),'Owner explicitly removed remaining tint work.');
reset role;
set role service_role;
select garage_sheet_feedback(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1) as cancelled_feedback \gset
reset role;
select test_assert(exists(select 1 from jsonb_array_elements(:'cancelled_feedback'::jsonb->'rows') r where r->>'order_id'=:'partial_order'
  and (r->>'complete')::boolean and r->>'block' like '%cancelled%'),'Explicitly cancelled work remains labelled separately from actual completed work');
