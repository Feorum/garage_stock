\set ON_ERROR_STOP on
-- Preserve old issued blocks while replacing their visible presentation.
\i /tmp/feedback-test.sql
reset role;
select completed_at as original_correction_time from garage_task_completions where task_id=(:'correction'::jsonb->>'task_id')::uuid \gset
select count(*) as previous_block_count from garage_sheet_feedback_outputs where source_id=:'guard_source' and order_id=:'collision_order' \gset
\i /tmp/garage-readable-feedback.sql
set role service_role;
select garage_sheet_feedback(:'guard_source',(:'guard_lease'::jsonb->>'lease_token')::uuid,1) as readable_feedback \gset
reset role;
select test_assert(exists(select 1 from jsonb_array_elements(:'readable_feedback'::jsonb->'rows') r where r->>'order_id'=:'collision_order'
  and (r->>'complete')::boolean and r->>'block' like '%Completed · Synthetic Mechanic%'
  and r->>'block' !~ '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:'
  and jsonb_array_length(r->'known_outputs')=(:'previous_block_count')::integer+1),
  'Readable completion labels omit display timestamps while retaining every older issued output');
select test_assert((select completed_at=:'original_correction_time' from garage_task_completions
  where task_id=(:'correction'::jsonb->>'task_id')::uuid),'Readable output never modifies the recorded completion time');
select test_assert(exists(select 1 from jsonb_array_elements(:'readable_feedback'::jsonb->'rows') r
  cross join lateral jsonb_array_elements(r->'tasks') t where r->>'order_id'=:'collision_order' and t->>'completed_at' is not null),
  'Structured task feedback retains its original completion timestamp');
select test_assert(exists(select 1 from jsonb_array_elements(:'readable_feedback'::jsonb->'rows') r where r->>'order_id'=:'partial_order'
  and r->>'block' like '%Cancelled%' and r->>'block' like '%5%%'),'Readable output retains cancellation labels and tint options');
select test_assert(not has_function_privilege('authenticated','garage_sheet_feedback(uuid,uuid,integer)','execute')
  and has_function_privilege('service_role','garage_sheet_feedback(uuid,uuid,integer)','execute'),
  'Replacing the formatter preserves the existing source-only function grants');
