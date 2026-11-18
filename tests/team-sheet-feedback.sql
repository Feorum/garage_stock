\set ON_ERROR_STOP on
\i /tmp/readable-feedback-test.sql
reset role;
\i /tmp/team-workflow.sql

insert into auth.users(id,email,raw_user_meta_data) values
 ('88000000-0000-4000-8000-000000000001','second-team-mechanic@example.invalid','{"name":"Second Mechanic"}');

set role service_role;
select garage_ingest_sheet(:'guard_source',repeat('v',40),test_payload(gen_random_uuid(),gen_random_uuid(),gen_random_uuid())||
 '{"spreadsheet_id":"synthetic-owner-guard-sheet","order":{"vehicle":"Team feedback fixture","vehicle_group_code":"VG02","vin":"TEST0000000000205","planned_date":"2026-12-21"}}');
reset role;
select id as team_order from garage_orders where vin='TEST0000000000205' \gset
select id as team_task from garage_order_tasks where order_id=:'team_order' \gset

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_team_action(:'team_task','join',1,gen_random_uuid());
set request.jwt.claim.sub='88000000-0000-4000-8000-000000000001';
select garage_team_action(:'team_task','join',2,gen_random_uuid());
select garage_team_action(:'team_task','note',3,gen_random_uuid(),'Internal team note');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_team_action(:'team_task','confirm',4,gen_random_uuid());
reset role;
set role service_role;
select r as before_final from jsonb_array_elements(garage_sheet_feedback(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1)->'rows') r
  where r->>'order_id'=:'team_order' \gset
reset role;
select test_assert(not (:'before_final'::jsonb->>'complete')::boolean
  and :'before_final'::jsonb->>'block' like '%Synthetic Mechanic%'
  and :'before_final'::jsonb->>'block' not like '%Second Mechanic%', 'Partial team confirmation reports the actual signer and keeps I unchecked');

set role authenticated;
set request.jwt.claim.sub='88000000-0000-4000-8000-000000000001';
select garage_team_action(:'team_task','confirm',5,gen_random_uuid());
reset role;
set role service_role;
select r as after_final from jsonb_array_elements(garage_sheet_feedback(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1)->'rows') r
  where r->>'order_id'=:'team_order' \gset
reset role;
select test_assert((:'after_final'::jsonb->>'complete')::boolean and jsonb_array_length(:'after_final'::jsonb->'tasks')=1
  and :'after_final'::jsonb->>'block' like '%Completed · Synthetic Mechanic, Second Mechanic%'
  and :'after_final' !~ 'Internal team note|pool_kopeks|share_bps|gross_amount',
  'Final team confirmation checks I and names both mechanics once in J without private notes or financial data');
select test_assert(exists(select 1 from jsonb_array_elements(:'after_final'::jsonb->'known_outputs') output
  where output->>'block'=(:'before_final'::jsonb->>'block') and not (output->>'complete')::boolean),
  'The old partial team block is retained for reconciliation with the working copy');
