\set ON_ERROR_STOP on
-- Isolated synthetic PostgreSQL only. Never execute these fixtures in production.
\i /tmp/pull-test.sql
reset role;
set request.jwt.claim.sub='';
\i /tmp/garage-owner-edit.sql

create function test_manager_row(p_row integer,p_date text,p_vin text,p_text text default 'PRIVATE_ORIGINAL_REQUEST; Cost $50') returns jsonb
language sql as $$ select jsonb_build_object('row_number',p_row,'source_key',case when p_date ~ '^\d{4}-\d{2}-\d{2}$' then p_date||'|'||p_vin else null end,
  'raw',jsonb_build_object('date',p_date,'manager_label','Synthetic Manager','vehicle','S50','vin',p_vin,'colour','Grey',
    'wrapping',p_text,'tint','','completion','FALSE','notes','Original manual note'),
  'suggested_order',jsonb_build_object('vehicle','S50','vehicle_group_code','VG02','vin',p_vin,'colour','Grey','manager_label','Synthetic Manager',
    'planned_date',case when p_date ~ '^\d{4}-\d{2}-\d{2}$' then p_date else null end,'priority','normal','instructions',''),
  'suggested_tasks','[]'::jsonb,'issues','["NO_APPROVED_TASKS"]'::jsonb) $$;
create function test_interpreted_order(p_date text default '2026-11-25') returns jsonb language sql as $$
  select jsonb_build_object('vehicle','Owner interpreted S50','vehicle_group_code','VG02','vin','TEST0000000000101',
    'colour','Grey','manager_label','Synthetic Manager','planned_date',p_date,'priority','normal','instructions','Public operational instructions')
$$;
insert into garage_price_lists(id,name,source_sha256,status)
  values('61000000-0000-4000-8000-000000000001','Synthetic editing rates',repeat('6',64),'active');
insert into garage_price_matrix(price_list_id,vehicle_group_code,work_code,net_amount) values
 ('61000000-0000-4000-8000-000000000001','VG02','W01',11.11),
 ('61000000-0000-4000-8000-000000000001','VG02','W07',7.77),
 ('61000000-0000-4000-8000-000000000001','VG02','W09',9.99),
 ('61000000-0000-4000-8000-000000000001','VG02','W11',4.44);
select test_assert(garage_private_note('Цена100') and garage_private_note('Price100') and garage_private_note('discount20')
  and garage_private_note('＄100') and not garage_private_note('Приставка; Выставка; Оценка покрытия'),'Owner edit guard keeps commercial values private without matching ordinary word substrings');

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_connect_sheet_pull('Owner editing source','synthetic-owner-editing-sheet','12345')->>'id' as edit_source \gset
select garage_prepare_sheet_reader(:'edit_source',repeat('u',40),1);
select test_error($q$select garage_capture_manager_rows(null,null,1,'[]')$q$,'Owner cannot impersonate source capture','42501');
reset role;
set role service_role;
set request.jwt.claim.sub='';
select garage_acquire_sheet_reader(:'edit_source',repeat('u',40),'synthetic-owner-editing-sheet','12345') as edit_lease \gset
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(171,'2026-11-20','TEST0000000000101'))) as capture \gset
select test_assert(:'capture'::jsonb->>'version'='1','Capturing source does not alter importer CAS version');
select test_error(format('select garage_capture_manager_rows(%L,%L,999,''[]'')',:'edit_source',:'edit_lease'::jsonb->>'lease_token'),'Stale capture lease/version rejected','40001');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select id as intake_id,version as intake_version from garage_manager_intake where source_id=:'edit_source' \gset
select test_assert((select original_snapshot->>'wrapping' like 'PRIVATE_ORIGINAL_REQUEST%' from garage_manager_intake where id=:'intake_id'),'Original Manager text retained privately');
select test_assert(exists(select 1 from jsonb_array_elements(garage_manager_intakes()) i where i->>'id'=:'intake_id' and i->>'status'='pending'),'Free-text-only request appears for Owner interpretation');
select test_assert((garage_quote_order('VG02','[{"work_code":"W01"}]')->>'gross_amount')::numeric=13.33,'Owner quote uses active approved rates');
select test_assert(garage_quote_order('VG02','[{"work_code":"W02"}]')->'gross_amount'='null'::jsonb,'Missing quote rate stays unknown');
select test_error(format('select garage_publish_manager_intake(%L,1,%L,''[]'',gen_random_uuid())',:'intake_id',test_interpreted_order()),'Free text cannot publish without catalogue selection');
select test_error(format('select garage_publish_manager_intake(%L,1,%L,''[{"work_code":"W01"}]'',gen_random_uuid())',:'intake_id',test_interpreted_order()||'{"instructions":"Price $100"}'),'Private commercial note cannot become mechanic instructions');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select test_assert(not exists(select 1 from jsonb_array_elements(garage_manager_intakes()) i where i->>'id'=:'intake_id'),'Another Owner cannot read private source intake');
select test_error(format('select garage_publish_manager_intake(%L,1,%L,''[{"work_code":"W01"}]'',gen_random_uuid())',:'intake_id',test_interpreted_order()),'Another Owner cannot interpret private source','42501');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select test_assert((select count(*)=0 from garage_manager_intake),'Mechanic RLS hides original Manager intake');
select test_error($q$select garage_manager_intakes()$q$,'Mechanic cannot call private intake RPC','42501');
select test_error($q$select garage_quote_order('VG02','[{"work_code":"W01"}]')$q$,'Mechanic cannot quote prices','42501');
select test_error(format('select garage_publish_manager_intake(%L,1,%L,''[{"work_code":"W01"}]'',gen_random_uuid())',:'intake_id',test_interpreted_order()),'Mechanic cannot publish interpreted work','42501');
reset role;

-- Source row positions are provenance, not request identities or versions.
set role service_role;
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(173,'2026-11-20','TEST0000000000101')));
reset role;
select test_assert((select version=1 and row_numbers=array[173] from garage_manager_intake where id=:'intake_id'),'Sorting updates row provenance without duplicating or invalidating the draft');
set role service_role;
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(173,'2026-11-20','TEST0000000000101'),test_manager_row(174,'2026-11-20','TEST0000000000101','Different duplicate text')));
reset role;
select test_assert((select jsonb_array_length(observations)=2 and cardinality(row_numbers)=2 from garage_manager_intake where id=:'intake_id'),'Duplicate identity retains both raw occurrences');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_error(format('select garage_publish_manager_intake(%L,2,%L,''[{"work_code":"W01"}]'',gen_random_uuid())',:'intake_id',test_interpreted_order()),'Ambiguous duplicates cannot publish by last-row-wins');
reset role;
set role service_role;
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(173,'2026-11-20','TEST0000000000101')));
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select version as publish_version from garage_manager_intake where id=:'intake_id' \gset
select garage_publish_manager_intake(:'intake_id',:'publish_version',test_interpreted_order(),
  '[{"work_code":"W01"},{"work_code":"W07"}]','62000000-0000-4000-8000-000000000001') as published \gset
select :'published'::jsonb->>'order_id' as edited_order \gset
select garage_publish_manager_intake(:'intake_id',:'publish_version',test_interpreted_order(),
  '[{"work_code":"W01"},{"work_code":"W07"}]','62000000-0000-4000-8000-000000000001') as replay \gset
select test_assert(:'published'::jsonb=:'replay'::jsonb,'Interpretation retry returns exactly the original order');
select test_assert((select owner_managed and original_source_key='2026-11-20|TEST0000000000101' and owner_canonical_key='2026-11-25|TEST0000000000101' from garage_manager_intake where id=:'intake_id'),'Owner correction reserves original and resolved source identities');
select test_assert((select count(*)=1 from garage_sheet_orders where source_id=:'edit_source' and order_id=:'edited_order'),'Owner publication reserves a source external-order binding');
select test_assert(garage_order_financials(:'edited_order')->>'status'='priced','Interpreted catalogue tasks receive frozen prices');
select id as retained_task from garage_order_tasks where order_id=:'edited_order' and work_code='W01' \gset
select id as removed_task from garage_order_tasks where order_id=:'edited_order' and work_code='W07' \gset
reset role;
set role service_role;
select test_assert(garage_ingest_sheet(:'edit_source',repeat('u',40),jsonb_build_object('submission_id',gen_random_uuid(),
  'external_order_id',gen_random_uuid(),'revision',1,'action','submit','order',test_interpreted_order('2026-11-20')))->'error'->>'code'='ORDER_CHANGED','Captured automatic request cannot create duplicate using original identity');
select test_assert(garage_ingest_sheet(:'edit_source',repeat('u',40),jsonb_build_object('submission_id',gen_random_uuid(),
  'external_order_id',gen_random_uuid(),'revision',1,'action','submit','order',test_interpreted_order()))->'error'->>'code'='ORDER_CHANGED','Corrected canonical identity also rejects automatic duplicate');
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(177,'2026-11-25','TEST0000000000101','A later Manager change'))) as after_owner \gset
select test_assert(:'after_owner'::jsonb->'owner_managed_rows'='[177]'::jsonb,'Current capture suppresses Owner-managed row after identity correction and sorting');
reset role;
select test_assert((select count(*)=1 from garage_manager_intake where source_id=:'edit_source'),'Corrected source identity links to the same Owner-managed intake');
select test_assert((select original_snapshot->>'wrapping' like 'PRIVATE_ORIGINAL_REQUEST%' and latest_snapshot->>'wrapping'='A later Manager change' from garage_manager_intake where id=:'intake_id'),'Later poll preserves original text separately from latest source');
select test_assert((select instructions='Public operational instructions' from garage_orders where id=:'edited_order'),'Later source change cannot overwrite Owner instructions');
update garage_price_lists set status='retired' where id='61000000-0000-4000-8000-000000000001';
insert into garage_price_lists(id,name,source_sha256,status)
  values('61000000-0000-4000-8000-000000000002','Next synthetic rates',repeat('7',64),'active');
insert into garage_price_matrix(price_list_id,vehicle_group_code,work_code,net_amount) values
 ('61000000-0000-4000-8000-000000000002','VG02','W01',99),
 ('61000000-0000-4000-8000-000000000002','VG02','W09',22.22),
 ('61000000-0000-4000-8000-000000000002','VG02','W11',3.33);

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select jsonb_build_array(jsonb_build_object('id',:'retained_task','work_code','W01','instructions','Owner detail'),jsonb_build_object('work_code','W09')) as editing_tasks \gset
select garage_edit_order(:'edited_order',1,test_interpreted_order(),:'editing_tasks','62000000-0000-4000-8000-000000000002') as edit_result \gset
select test_assert(garage_edit_order(:'edited_order',1,test_interpreted_order(),:'editing_tasks','62000000-0000-4000-8000-000000000002')=:'edit_result'::jsonb,'Owner edit retry is idempotent');
select test_error(format('select garage_edit_order(%L,1,%L,%L,gen_random_uuid())',:'edited_order',test_interpreted_order(),:'editing_tasks'),'Stale Owner edit rejected','40001');
select test_assert((select status='cancelled' from garage_order_tasks where id=:'removed_task'),'Removed pending task is cancelled rather than deleted');
select test_assert((select count(*)=1 from garage_task_financials where task_id=:'removed_task'),'Cancelled task retains financial history');
select test_assert((select instructions='Owner detail' and status='pending' from garage_order_tasks where id=:'retained_task'),'Unchanged selected work keeps its task identity');
select test_assert((select net_amount=11.11 from garage_task_financials where task_id=:'retained_task'),'Retained task keeps original frozen rate');
select id as added_task from garage_order_tasks where order_id=:'edited_order' and work_code='W09' and status='pending' \gset
select test_assert((select pricing_status='priced' from garage_task_financials where task_id=:'added_task'),'New selected task is automatically priced');
select test_assert((select net_amount=22.22 from garage_task_financials where task_id=:'added_task'),'New task uses current rate while retained task keeps its old snapshot');
select test_error(format('select garage_edit_order(%L,2,%L,''[{"id":"%s","work_code":"W01","price":1}]'',gen_random_uuid())',:'edited_order',test_interpreted_order(),:'retained_task'),'Client cannot submit a task price');

set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select test_error(format('select garage_edit_order(%L,2,%L,%L,gen_random_uuid())',:'edited_order',test_interpreted_order(),:'editing_tasks'),'Mechanic cannot edit order definition','42501');
select test_assert(not(garage_list_orders()::text ~ 'PRIVATE_ORIGINAL_REQUEST|Cost|original_snapshot|latest_snapshot|net_amount|gross_amount'),'Mechanic order list contains no original private intake or amounts');
select test_assert(exists(select 1 from jsonb_array_elements(garage_list_orders()) o where o->>'id'=:'edited_order' and o->>'source_row_number'='177'),'Mechanic receives safe source row provenance for table order');
select garage_task_action(:'retained_task','start',2,'62000000-0000-4000-8000-000000000003');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_error(format('select garage_edit_order(%L,3,%L,''[{"work_code":"W09"}]'',gen_random_uuid())',:'edited_order',test_interpreted_order()),'Started task cannot be removed');
select test_error(format('select garage_edit_order(%L,3,%L,''[{"id":"%s","work_code":"W01","instructions":"Changed"}]'',gen_random_uuid())',:'edited_order',test_interpreted_order(),:'retained_task'),'Started task details cannot be silently rewritten');
select test_error(format('select garage_edit_order(%L,3,%L,%L,gen_random_uuid())',:'edited_order',test_interpreted_order()||'{"vehicle_group_code":"VG03"}',:'editing_tasks'),'Started work freezes vehicle-group pricing context');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select garage_task_action(:'retained_task','complete',3,'62000000-0000-4000-8000-000000000004');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select jsonb_build_array(jsonb_build_object('id',:'retained_task','work_code','W01','instructions','Owner detail'),
  jsonb_build_object('id',:'added_task','work_code','W09'),jsonb_build_object('work_code','W11')) as final_tasks \gset
select garage_edit_order(:'edited_order',4,test_interpreted_order()||'{"instructions":"Updated order instruction"}',:'final_tasks','62000000-0000-4000-8000-000000000005');
select test_assert((select status='completed' from garage_order_tasks where id=:'retained_task'),'Completed status preserved during Owner edit');
select test_assert((select count(*)=1 from garage_task_completions where task_id=:'retained_task'),'Completion ledger remains exactly once');
select test_assert((select net_amount=11.11 from garage_task_financials where task_id=:'retained_task'),'Completed financial snapshot stays unchanged');
select test_assert((garage_quote_order('VG02',:'final_tasks',:'edited_order')->>'gross_amount')::numeric=(garage_order_financials(:'edited_order')->>'gross_amount')::numeric,'Owner quote agrees with saved retained/new task snapshots');
reset role;
-- Missing-identity observations use content hashes, never row positions.
set role service_role;
set request.jwt.claim.sub='';
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(177,'2026-11-25','TEST0000000000101','A later Manager change'),
    test_manager_row(188,'28.11','TEST0000000000102','Free written request needing a year')));
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select id as unresolved_id,version as unresolved_version from garage_manager_intake
  where source_id=:'edit_source' and original_source_key is null \gset
select garage_publish_manager_intake(:'unresolved_id',:'unresolved_version',test_interpreted_order('2026-11-28')||'{"vin":"TEST0000000000102"}',
  '[{"work_code":"W09"}]','62000000-0000-4000-8000-000000000006')->>'order_id' as resolved_missing_order \gset
select id as resolved_missing_task from garage_order_tasks where order_id=:'resolved_missing_order' \gset
select test_error(format('select garage_edit_order(%L,1,%L,%L,gen_random_uuid())',:'resolved_missing_order',test_interpreted_order(),
  jsonb_build_array(jsonb_build_object('id',:'resolved_missing_task','work_code','W09'))),'Owner cannot edit a second source order into an existing visit','40001');
select test_error(format('select garage_edit_order(%L,1,%L,%L,gen_random_uuid())',:'resolved_missing_order',test_interpreted_order()||'{"vin":" TEST0000000000101 "}',
  jsonb_build_array(jsonb_build_object('id',:'resolved_missing_task','work_code','W09'))),'VIN whitespace cannot bypass duplicate visit protection','40001');
reset role;
set role service_role;
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(177,'2026-11-25','TEST0000000000101','A later Manager change'),
    test_manager_row(199,'28.11','TEST0000000000102','Free written request needing a year'))) as unresolved_moved \gset
select test_assert(:'unresolved_moved'::jsonb->'owner_managed_rows' @> '[199]'::jsonb,'Original invalid-identity observation remains suppressed after row movement');
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(177,'2026-11-25','TEST0000000000101','A later Manager change'),
    test_manager_row(199,'2026-11-28','TEST0000000000102','Free written request needing a year'))) as identity_corrected \gset
select test_assert(:'identity_corrected'::jsonb->'owner_managed_rows' @> '[199]'::jsonb,'Future source identity correction links through the Owner canonical key');
reset role;
select test_assert((select count(*)=2 from garage_manager_intake where source_id=:'edit_source'),'Missing-identity correction creates no duplicate intake');
set role service_role;
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(177,'2026-11-25','TEST0000000000101','A later Manager change'),
    test_manager_row(199,'2026-11-28','TEST0000000000102','Free written request needing a year'),
    jsonb_set(jsonb_set(test_manager_row(200,'2026-11-30','TEST0000000000103','W01; Cost $100'),
      '{suggested_order,instructions}','"Price $100"'),'{suggested_tasks}',
      '[{"task_key":"W01","work_code":"W01","options":{},"instructions":"Cost $100"}]')));
reset role;
select test_assert((select latest_snapshot->>'wrapping'='W01; Cost $100' and suggested_order->>'instructions'=''
  and suggested_tasks->0->>'instructions'='' from garage_manager_intake where source_id=:'edit_source'
  and original_source_key='2026-11-30|TEST0000000000103'),'Private source text stays available to Owner but cannot prefill public instructions');
-- Newly automatic orders are linked immediately, without a second capture poll.
set role service_role;
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(204,'2026-12-01','TEST0000000000104','W09')));
select jsonb_build_object('schema_version',1,'spreadsheet_id','synthetic-owner-editing-sheet',
  'submission_id','62000000-0000-4000-8000-000000000099','external_order_id','62000000-0000-4000-8000-000000000098',
  'revision',1,'expected_order_version',null,'action','submit',
  'order',test_interpreted_order('2026-12-01')||'{"vin":"TEST0000000000104"}',
  'tasks','[{"external_task_id":"62000000-0000-4000-8000-000000000097","work_code":"W09","options":{}}]'::jsonb) as auto_payload \gset
select garage_ingest_sheet(:'edit_source',repeat('u',40),:'auto_payload') as auto_receipt \gset
select test_assert(:'auto_receipt'::jsonb->>'status'='accepted','Catalogue request still publishes automatically');
reset role;
select order_id as auto_order from garage_sheet_orders where source_id=:'edit_source' and external_order_id='62000000-0000-4000-8000-000000000098' \gset
select test_assert((select order_id=:'auto_order' from garage_manager_intake where source_id=:'edit_source' and original_source_key='2026-12-01|TEST0000000000104'),'New automatic acceptance links private intake immediately');
select id as auto_task from garage_order_tasks where order_id=:'auto_order' \gset
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_assert(exists(select 1 from jsonb_array_elements(garage_list_orders()) o where o->>'id'=:'auto_order' and o->>'source_row_number'='204'),'Automatic order exposes its exact source row immediately');
select garage_edit_order(:'auto_order',1,test_interpreted_order('2026-12-01')||'{"vin":"TEST0000000000104"}',
  jsonb_build_array(jsonb_build_object('id',:'auto_task','work_code','W09','instructions','Owner detail')),'62000000-0000-4000-8000-000000000096');
reset role;
set role service_role;
set request.jwt.claim.sub='';
select test_assert(garage_ingest_sheet(:'edit_source',repeat('u',40),:'auto_payload')=:'auto_receipt'::jsonb,'Recorded automatic receipt remains replayable after Owner edit');
select test_assert(garage_ingest_sheet(:'edit_source',repeat('u',40),:'auto_payload'::jsonb||'{"revision":2}')->'error'->>'code'='SUBMISSION_ID_REUSED','Previously recorded submission still rejects changed payload after Owner edit');
select test_assert(garage_ingest_sheet(:'edit_source',repeat('u',40),:'auto_payload'::jsonb||jsonb_build_object('submission_id',gen_random_uuid(),
  'external_order_id',gen_random_uuid()))->'error'->>'code'='ORDER_CHANGED','Owner edit rejects a new automatic request even with a new external identity');
-- All original duplicate text is immutable; later changes to a second occurrence
-- invalidate the draft version even when the first occurrence/count stay equal.
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(205,'2026-12-02','TEST0000000000105','First original phrase'),
    test_manager_row(206,'2026-12-02','TEST0000000000105','Second original phrase')));
reset role;
select id as duplicate_intake from garage_manager_intake where source_id=:'edit_source' and original_source_key='2026-12-02|TEST0000000000105' \gset
select test_assert((select jsonb_array_length(original_observations)=2 and original_observations->1->'raw'->>'wrapping'='Second original phrase'
  from garage_manager_intake where id=:'duplicate_intake'),'Both original duplicate occurrences are retained');
set role service_role;
select garage_capture_manager_rows(:'edit_source',(:'edit_lease'::jsonb->>'lease_token')::uuid,1,
  jsonb_build_array(test_manager_row(205,'2026-12-02','TEST0000000000105','First original phrase'),
    test_manager_row(206,'2026-12-02','TEST0000000000105','Changed second phrase')));
reset role;
select test_assert((select version=2 and original_observations->1->'raw'->>'wrapping'='Second original phrase'
  and observations->1->'raw'->>'wrapping'='Changed second phrase' from garage_manager_intake where id=:'duplicate_intake'),
  'Changing only a later duplicate preserves its original and advances the version');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_assert(exists(select 1 from jsonb_array_elements(garage_manager_intakes()) i where i->>'id'=:'duplicate_intake' and (i->>'source_changed')::boolean),
  'Later duplicate changes are visible to the Owner');
reset role;
select test_assert(exists(select 1 from garage_schema_migrations where version='20261115015355'),'Owner editing migration recorded');
