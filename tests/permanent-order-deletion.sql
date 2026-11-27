-- Test fixture uses synthetic Storage metadata to stand in for an authorized API removal.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
  ('de100000-0000-4000-8000-000000000001','deletion-owner@example.invalid','{"name":"Permanent deletion Owner"}'),
  ('de100000-0000-4000-8000-000000000002','deletion-mechanic@example.invalid','{"name":"Permanent deletion Mechanic"}'),
  ('de100000-0000-4000-8000-000000000003','deletion-other@example.invalid','{"name":"Permanent deletion Other Owner"}');
update public.profiles set role='admin' where id in ('de100000-0000-4000-8000-000000000001','de100000-0000-4000-8000-000000000003');

create temporary table delete_fixture on commit drop as select
  'de100000-0000-4000-8000-000000000001'::uuid as actor,
  'de100000-0000-4000-8000-000000000002'::uuid as mechanic,
  'de100000-0000-4000-8000-000000000003'::uuid as other_owner,
  'de100000-0000-4000-8000-000000000004'::uuid as visit,
  'de100000-0000-4000-8000-000000000005'::uuid as keep_visit,
  'de100000-0000-4000-8000-000000000006'::uuid as task,
  'de100000-0000-4000-8000-000000000007'::uuid as custom,
  gen_random_uuid() as source, gen_random_uuid() as external, gen_random_uuid() as submission,
  gen_random_uuid() as intake, gen_random_uuid() as lease, gen_random_uuid() as request,
  gen_random_uuid() as original_request, gen_random_uuid() as batch, gen_random_uuid() as sheet,
  gen_random_uuid() as ledger_row, null::bigint as member_id, '2026-11-20|123456789ABCDEFGH'::text as source_key;
grant select on delete_fixture to authenticated,service_role;
do $$
begin
  if has_function_privilege('anon','public.garage_permanently_delete_order(uuid,boolean,integer,uuid)','execute')
    or has_function_privilege('service_role','public.garage_permanently_delete_order(uuid,boolean,integer,uuid)','execute')
    or not has_function_privilege('authenticated','public.garage_permanently_delete_order(uuid,boolean,integer,uuid)','execute') then
    raise exception 'Permanent order deletion is not limited to authenticated calls.';
  end if;
end $$;

do $$
declare f delete_fixture%rowtype; event_id bigint; ledger_cells jsonb;
begin
  select * into f from delete_fixture;
  insert into public.garage_orders(id,vehicle,vin,planned_date,vehicle_group_code,source,status,created_by) values
    (f.visit,'Deleted archived visit','123456789ABCDEFGH','2026-11-20','VG02','manager','closed',f.actor),
    (f.keep_visit,'Retained visit','','2026-11-20','VG02','owner','published',f.actor);
  insert into garage_custom.orders(id,owner_id,vehicle,services,visit_date,status,customer_kopeks,payments,allocations)
    values(f.custom,f.actor,'Deleted custom visit','Custom service','2026-11-20','closed',8000,'[{"name":"Worker","kopeks":2000}]','[]');
  insert into public.garage_order_tasks(id,order_id,work_code,work_name,status,assigned_to,working_mechanic_id,completed_at)
    values(f.task,f.visit,'W01','Deleted work','completed',f.mechanic,f.mechanic,now());
  update public.garage_task_participants set status='confirmed',started_at=now(),confirmed_at=now(),confirmation_origin='mechanic'
    where task_id=f.task;
  update delete_fixture set member_id=(select id from public.garage_task_participants where task_id=f.task);
  insert into public.garage_task_events(order_id,task_id,actor_id,action,note)
    values(f.visit,f.task,f.mechanic,'complete','Private work note') returning id into event_id;
  insert into public.garage_team_changes(task_id,version,action,event_id) values(f.task,1,'confirm',event_id);
  insert into public.garage_task_completions(task_id,order_id,mechanic_id,work_code,work_name)
    values(f.task,f.visit,f.mechanic,'W01','Deleted work');
  insert into public.garage_task_financials(task_id,pricing_status) values(f.task,'needs_pricing');
  insert into garage_pay.revisions(task_id,version,actor_id,pool_kopeks,shares,reason,request_id,request_payload)
    values(f.task,1,f.actor,2700,'[]','Fixture',gen_random_uuid(),'{}');
  insert into garage_pay.task_pricing_revisions(task_id,version,override_kopeks,private_comment,actor_id,request_id)
    values(f.task,1,7800,'Fixture',f.actor,gen_random_uuid());
  insert into garage_payroll.legacy_orders(id) values(f.visit);
  insert into garage_payroll.revisions(order_id,version,operation,prep_ids,heat_ids,amounts,result) values
    (f.visit,1,'close','{}','{}','{}','{}'),
    (f.keep_visit,1,'save','{}','{}','{}','{"total_kopeks":7653}');
  insert into public.garage_vehicle_visits(order_id,state,holder_id) values(f.visit,'active',f.mechanic);
  insert into public.garage_vehicle_events(order_id,actor_id,action) values(f.visit,f.actor,'close');
  insert into garage_act.reserved_numbers(number) values('12202/11');
  insert into garage_act.documents(order_id,number,contract_number,contract_date,act_date,vin)
    values(f.visit,'12202/11','Fixture','2026-11-20','2026-11-20','123456789ABCDEFGH');
  insert into garage_notes.order_notes(standard_id,note,version) values(f.visit,'Deleted order note',1);
  insert into garage_notes.order_notes(custom_id,note,version) values(f.custom,'Deleted custom note',1);
  insert into garage_pay.film_revisions(order_id,version,request_id,request,response,byte_start,bytes) values
    (f.keep_visit,1,gen_random_uuid(),'{}','{}',0,convert_to('kept first','UTF8')),
    (f.visit,1,gen_random_uuid(),'{}','{}',10,convert_to('deleted movie','UTF8')),
    (f.keep_visit,2,gen_random_uuid(),'{}','{}',23,convert_to('kept last','UTF8'));
  update garage_pay.film_file set size_bytes=32;

  insert into public.garage_sheet_sources(id,spreadsheet_id,name,owner_id,secret_hash)
    values(f.source,'synthetic_permanent_deletion_spreadsheet','Fixture source',f.actor,public.garage_sheet_hash('permanent-delete-source-secret'));
  insert into public.garage_sheet_orders(source_id,external_order_id,order_id,last_revision,last_order_version)
    values(f.source,f.external,f.visit,1,1);
  insert into public.garage_sheet_task_versions(source_id,external_task_id,external_order_id,revision,task_id)
    values(f.source,gen_random_uuid(),f.external,1,f.task);
  insert into public.garage_sheet_tasks(source_id,external_task_id,external_order_id,task_id)
    values(f.source,gen_random_uuid(),f.external,f.task);
  insert into public.garage_sheet_submissions(source_id,submission_id,external_order_id,revision,payload_hash,status,receipt,scope_snapshot)
    values(f.source,f.submission,f.external,1,repeat('a',64),'accepted','{}','{"vehicle":"Deleted archived visit"}');
  insert into public.garage_sheet_feedback_outputs(source_id,order_id,block_hash,block,complete)
    values(f.source,f.visit,repeat('f',64),'Deleted feedback',true);
  insert into public.garage_manager_intake(id,source_id,intake_key,original_source_key,original_snapshot,original_observations,
      latest_snapshot,row_numbers,owner_managed,order_id)
    values(f.intake,f.source,'identity:'||f.source_key,f.source_key,'{"vehicle":"Deleted archived visit"}','[]',
      '{"vehicle":"Deleted archived visit"}',array[4],true,f.visit);
  insert into public.garage_sheet_pull_feeds(source_id,sheet_gid,credential_secret_id,state,review,lease_token,lease_expires_at)
    values(f.source,'0',gen_random_uuid(),jsonb_build_object('schema_version',1,'entries',
      jsonb_build_object(f.source_key,jsonb_build_object('external_order_id',f.external,'vehicle','Deleted archived visit'))),
      jsonb_build_array(jsonb_build_object('source_key',f.source_key,'vehicle','Deleted archived visit')),
      f.lease,now()+interval '1 hour');
  insert into public.garage_requests(actor_id,request_id,payload,response)
    values(f.actor,f.original_request,'{"operation":"publish","vehicle":"Deleted archived visit"}',
      jsonb_build_object('order_id',f.visit));

  insert into garage_ledger.imports(id,name,filename,source_sha256,status) values(f.batch,'Delete fixture','delete.xlsx',repeat('d',64),'ready');
  insert into garage_ledger.sheets(id,import_id,sheet_key,name,sort) values(f.sheet,f.batch,'one','Fixture',1);
  ledger_cells:=jsonb_build_object('B','{"type":"number","value":42}'::jsonb,'C',
    jsonb_build_object('type','string','value','Independent cash entry','origin_order','standard:'||f.visit));
  insert into garage_ledger.rows(id,sheet_id,section,position,original_section,cells)
    values(f.ledger_row,f.sheet,'settlement',1,'settlement',ledger_cells);
  insert into garage_ledger.revisions(row_id,version,actor_id,action,after_state,reason,request_id)
    values(f.ledger_row,1,f.actor,'add',jsonb_build_object('cells',ledger_cells),'Cash',gen_random_uuid());
  insert into garage_ledger.requests(actor_id,request_id,payload,response)
    values(f.actor,gen_random_uuid(),jsonb_build_object('cells',ledger_cells),jsonb_build_object('row',jsonb_build_object('cells',ledger_cells)));

  insert into storage.objects(bucket_id,name) values
    ('garage-order-photos',f.visit||'/de100000-0000-4000-8000-000000000011.jpg'),
    ('garage-order-photos','custom/'||f.custom||'/de100000-0000-4000-8000-000000000011.jpg'),
    ('garage-order-photos',f.keep_visit||'/de100000-0000-4000-8000-000000000011.jpg');
end $$;

set local role authenticated;
do $$
declare f delete_fixture%rowtype; result jsonb; photo text; removed text;
begin
  select * into f from delete_fixture;
  perform set_config('request.jwt.claim.sub',f.mechanic::text,true);
  begin
    perform public.garage_permanently_delete_order(f.visit,false,1,f.request);
    raise exception 'A mechanic could request permanent order deletion.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',f.actor::text,true);
  delete from storage.objects returning name into removed;
  if found then raise exception 'An owner can delete a photo without preparing a matching order.'; end if;
  begin
    perform public.garage_permanently_delete_order(f.visit,false,0,f.request);
    raise exception 'An outdated order version could start deletion.';
  exception when serialization_failure then null; end;
  result:=public.garage_permanently_delete_order(f.visit,false,1,f.request);
  photo:=result->'photo_paths'->>0;
  if photo is null or photo not like f.visit||'/%' then raise exception 'Standard order photo was not staged.'; end if;
  if result is distinct from public.garage_permanently_delete_order(f.visit,false,1,f.request) then
    raise exception 'Retry should return the same unremoved photo.';
  end if;
end $$;
reset role;
do $$
declare f delete_fixture%rowtype;
begin
  select * into f from delete_fixture;
  begin
    update public.garage_orders set colour='Competing edit',version=version+1 where id=f.visit;
    raise exception 'A standard order write advanced the prepared deletion version.';
  exception when serialization_failure then
    if sqlerrm<>'The order is being deleted.' then raise; end if;
  end;
  update public.garage_orders set manager_comment='Late source comment' where id=f.visit;
  if found then raise exception 'A pending deletion accepted a source comment.'; end if;
  update public.garage_orders set colour='Independent edit',version=version+1 where id=f.keep_visit;
  if not found then raise exception 'Preparing deletion blocked an independent order update.'; end if;
end $$;
set local role authenticated;
do $$
declare f delete_fixture%rowtype; result jsonb; photo text; removed text;
begin
  select * into f from delete_fixture;
  perform set_config('request.jwt.claim.sub',f.actor::text,true);
  photo:=public.garage_permanently_delete_order(f.visit,false,1,f.request)->'photo_paths'->>0;
  perform set_config('request.jwt.claim.sub',f.mechanic::text,true);
  delete from storage.objects where name=photo;
  if found then raise exception 'A mechanic removed an order photo.'; end if;
  perform set_config('request.jwt.claim.sub',f.actor::text,true);
  delete from storage.objects where name=photo returning name into removed;
  if removed is distinct from photo then raise exception 'An owner could not remove the staged photo.'; end if;
  if public.garage_permanently_delete_order(f.visit,false,1,f.request) is distinct from jsonb_build_object('order_id',f.visit)
    or public.garage_permanently_delete_order(f.visit,false,1,f.request) is distinct from jsonb_build_object('order_id',f.visit) then
    raise exception 'Standard order completion or exact retry failed.';
  end if;
  begin
    perform public.garage_create_order('Should not be recreated','VG02','owner','[{"work_code":"W01"}]',f.original_request);
    raise exception 'A retired order creation request can be replayed.';
  exception when serialization_failure then null; end;

  result:=public.garage_permanently_delete_order(f.custom,true,1,gen_random_uuid());
  photo:=result->'photo_paths'->>0;
  if photo is null or photo not like 'custom/'||f.custom||'/%' then raise exception 'Custom order photo was not staged.'; end if;
  begin
    perform public.garage_save_custom_order(f.custom,1,'{"vehicle":"Competing edit","services":"Custom service",
      "visit_date":"2026-11-20","status":"closed","customer_kopeks":8000,"payments":[],"allocations":[]}',gen_random_uuid());
    raise exception 'A custom order edit advanced the prepared deletion version.';
  exception when serialization_failure then
    if sqlerrm<>'The order is being deleted.' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub',f.other_owner::text,true);
  delete from storage.objects where name=photo;
  if found then raise exception 'Another owner removed a private custom-order photo.'; end if;
  begin
    perform public.garage_permanently_delete_order(f.custom,true,1,gen_random_uuid());
    raise exception 'Another owner could delete a custom order.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',f.actor::text,true);
  delete from storage.objects where name=photo returning name into removed;
  if removed is distinct from photo then raise exception 'The custom order owner could not remove its photo.'; end if;
  if public.garage_permanently_delete_order(f.custom,true,1,gen_random_uuid()) is distinct from jsonb_build_object('order_id',f.custom) then
    raise exception 'The custom order deletion did not finish.';
  end if;
end $$;
reset role;

do $$
declare f delete_fixture%rowtype;
begin
  select * into f from delete_fixture;
  if exists(select from public.garage_orders where id=f.visit)
    or exists(select from garage_custom.orders where id=f.custom)
    or exists(select from public.garage_order_tasks where id=f.task)
    or exists(select from public.garage_task_completions where task_id=f.task)
    or exists(select from public.garage_task_events where order_id=f.visit)
    or exists(select from public.garage_task_participants where task_id=f.task)
    or exists(select from garage_board.check_restore where member_id=f.member_id)
    or exists(select from garage_pay.items where task_id=f.task)
    or exists(select from garage_pay.revisions where task_id=f.task)
    or exists(select from garage_pay.task_pricing_revisions where task_id=f.task)
    or exists(select from garage_pay.commercial_terms where order_id=f.visit)
    or exists(select from garage_payroll.revisions where order_id=f.visit)
    or exists(select from garage_act.documents where order_id=f.visit)
    or exists(select from garage_notes.order_notes where order_id in (f.visit,f.custom))
    or exists(select from garage_pay.film_revisions where order_id=f.visit)
    or exists(select from public.garage_sheet_submissions where submission_id=f.submission)
    or exists(select from public.garage_sheet_orders where order_id=f.visit)
    or exists(select from public.garage_manager_intake where id=f.intake)
    or exists(select from public.garage_requests where request_id=f.original_request)
    or exists(select from garage_board.order_photo_cleanup where order_id in (f.visit,f.custom)) then
    raise exception 'Permanent deletion left order-specific records.';
  end if;
  if not exists(select from public.garage_orders where id=f.keep_visit)
    or not exists(select from garage_act.reserved_numbers where number='12202/11')
    or (select count(*) from storage.objects)<>1
    or not exists(select from storage.objects where name like f.keep_visit||'/%')
    or not exists(select from garage_pay.film_revisions where order_id=f.keep_visit and version=2 and byte_start=10)
    or not exists(select from garage_pay.film_file where size_bytes=19)
    or not exists(select from garage_ledger.rows where id=f.ledger_row and version=2 and cells#>>'{B,value}'='42'
      and cells#>>'{C,value}'='Independent cash entry' and cells#>'{C,origin_order}' is null)
    or exists(select from garage_ledger.revisions where row_id=f.ledger_row and after_state#>'{cells,C,origin_order}' is not null)
    or exists(select from garage_ledger.requests where actor_id=f.actor and payload#>'{cells,C,origin_order}' is not null) then
    raise exception 'Deletion altered unrelated records or retained an order link.';
  end if;
  if not exists(select from public.garage_sheet_pull_feeds where source_id=f.source and state_version=2
    and lease_token is null and state->'entries'='{}' and review='[]') then
    raise exception 'Deleted visit was retained in durable importer state.';
  end if;
  update public.garage_sheet_pull_feeds set lease_token=f.lease,lease_expires_at=now()+interval '1 hour' where source_id=f.source;
  begin
    update garage_ledger.rows set cells=jsonb_set(cells,'{C,origin_order}',to_jsonb('standard:'||f.visit)) where id=f.ledger_row;
    raise exception 'A stale ledger form can restore an order link.';
  exception when serialization_failure then null; end;
end $$;

set local role service_role;
do $$
declare f delete_fixture%rowtype; result jsonb;
begin
  select * into f from delete_fixture;
  result:=public.garage_capture_manager_rows(f.source,f.lease,2,jsonb_build_array(
    jsonb_build_object('row_number',4,'source_key',f.source_key,'raw','{"vehicle":"Deleted archived visit"}'::jsonb,
      'suggested_order','{}'::jsonb,'suggested_tasks','[]'::jsonb,'issues','[]'::jsonb)));
  if result->>'intakes_count'<>'0' or result->'owner_managed_rows'<>'[4]' then
    raise exception 'The original worksheet row can recreate a removed visit.';
  end if;
  result:=public.garage_ingest_sheet(f.source,'permanent-delete-source-secret',jsonb_build_object(
    'submission_id',f.submission,'external_order_id',f.external,'revision',1));
  if result#>>'{error,code}' is distinct from 'ORDER_CHANGED' then
    raise exception 'An outstanding external submission can recreate a removed visit.';
  end if;
end $$;
reset role;
set local role authenticated;
do $$
declare f delete_fixture%rowtype;
begin
  select * into f from delete_fixture;
  perform set_config('request.jwt.claim.sub',f.actor::text,true);
  if public.garage_delete_order(f.keep_visit,false,2,gen_random_uuid())
    is distinct from jsonb_build_object('order_id',f.keep_visit) then
    raise exception 'A legacy client could not archive an order.';
  end if;
end $$;
reset role;
do $$
declare f delete_fixture%rowtype;
begin
  select * into f from delete_fixture;
  if not exists(select from public.garage_orders where id=f.keep_visit and deleted_at is not null)
    or not exists(select from garage_payroll.revisions where order_id=f.keep_visit and result->>'total_kopeks'='7653')
    or not exists(select from storage.objects where name like f.keep_visit||'/%') then
    raise exception 'Legacy deletion removed historical payroll or photos.';
  end if;
end $$;
rollback;
