-- Run against the isolated team-workflow fixture with four synthetic workshop users.
begin;
create function pg_temp.verify_undo(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Undo check: %',label; end if; end $$;
create function pg_temp.person(n integer) returns void language sql as $$
  select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-'||lpad(n::text,12,'0'),true)
$$;
create function pg_temp.visit(id uuid) returns jsonb language sql as $$
  select o from jsonb_array_elements(public.garage_list_orders()) o where (o->>'id')::uuid=id
$$;
create function pg_temp.expect_undo_denied(task uuid,v integer,state text) returns void language plpgsql as $$
begin
  begin perform public.garage_uncheck_work(task,v,gen_random_uuid());
  exception when others then if sqlstate=state then return; end if; raise; end;
  raise exception 'Unexpected successful undo';
end $$;

insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by) values
  ('a0000000-0000-4000-8000-000000000001','Shared undo','VG02','manager','00000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000002','Private undo','VG02','owner','00000000-0000-4000-8000-000000000001');
insert into public.garage_order_tasks(id,order_id,work_code,work_name,assigned_to) values
  ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','W01','Shared job',null),
  ('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002','W01','Assigned job','00000000-0000-4000-8000-000000000002');
insert into public.garage_sheet_sources(id,spreadsheet_id,name,owner_id,secret_hash)
  values('c0000000-0000-4000-8000-000000000001','undo-fixture-sheet','Synthetic feedback','00000000-0000-4000-8000-000000000001',repeat('a',64));
insert into public.garage_sheet_pull_feeds(source_id,sheet_gid,credential_secret_id,lease_token,lease_expires_at)
  values('c0000000-0000-4000-8000-000000000001','1',gen_random_uuid(),'d0000000-0000-4000-8000-000000000001',now()+interval '5 minutes');
insert into public.garage_manager_intake(source_id,intake_key,original_source_key,original_snapshot,original_observations,
  latest_snapshot,row_numbers,order_id) values('c0000000-0000-4000-8000-000000000001','undo','2026-11-20|TEST0000000000429',
  '{}','[]','{}','{2}','a0000000-0000-4000-8000-000000000001');
create function pg_temp.sheet_row() returns jsonb language sql security definer set search_path=pg_catalog as $$
  select public.garage_sheet_feedback('c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',1)->'rows'->0
$$;
select pg_temp.verify_undo(not has_function_privilege('anon','public.garage_uncheck_work(uuid,integer,uuid)','execute')
  and not has_table_privilege('authenticated','garage_board.check_restore','select'),'private write and recovery data');

set local role authenticated;
do $$
declare id uuid:='a0000000-0000-4000-8000-000000000001'; task uuid:='b0000000-0000-4000-8000-000000000001';
  private_job uuid:='b0000000-0000-4000-8000-000000000002'; private_id uuid:='a0000000-0000-4000-8000-000000000002';
  b uuid:='00000000-0000-4000-8000-000000000003'; receipt uuid:=gen_random_uuid(); first_reply jsonb; view jsonb;
  prior_check uuid:=gen_random_uuid(); returned jsonb; allocated jsonb;
begin
  perform pg_temp.person(2);
  perform public.garage_check_work(task,prior_check);
  perform pg_temp.verify_undo((pg_temp.visit(id)#>>'{tasks,0,can_uncheck_work}')::boolean,'own check offered');
  perform pg_temp.person(4);
  perform pg_temp.verify_undo(not (pg_temp.visit(id)#>>'{tasks,0,can_uncheck_work}')::boolean,'peer check protected');
  perform pg_temp.expect_undo_denied(task,2,'42501');
  perform pg_temp.expect_undo_denied(private_job,1,'42501');

  perform pg_temp.person(3);
  perform public.garage_check_work(task,gen_random_uuid());
  perform pg_temp.person(2);
  perform pg_temp.expect_undo_denied(task,2,'40001');
  first_reply:=public.garage_uncheck_work(task,3,receipt);
  perform pg_temp.verify_undo(first_reply->>'status'='completed' and (first_reply->>'version')::integer=4
    and first_reply=public.garage_uncheck_work(task,3,receipt),'shared credit removed once');
  perform pg_temp.verify_undo((public.garage_check_work(task,prior_check)->>'version')::integer=2
    and not (pg_temp.visit(id)#>>'{tasks,0,can_uncheck_work}')::boolean,'delayed successful check replay does not restore credit');
  perform pg_temp.person(3);
  view:=pg_temp.visit(id);
  perform pg_temp.verify_undo(jsonb_array_length(view#>'{tasks,0,participants}')=1
    and (view#>>'{tasks,0,participants,0,mechanic_id}')::uuid=b
    and (view#>>'{tasks,0,working_mechanic_id}')::uuid=b,'remaining mechanic retains completion');
  view:=pg_temp.sheet_row();
  perform pg_temp.verify_undo((view->>'complete')::boolean and view#>>'{tasks,0,mechanic_name}'='Миша','sheet keeps only the remaining contributor');
  view:=pg_temp.visit(id);
  perform public.garage_submit_work(id,(view->>'version')::integer,gen_random_uuid(),'');
  perform pg_temp.verify_undo(not (pg_temp.visit(id)#>>'{tasks,0,can_uncheck_work}')::boolean,'submitted checklist frozen');
  perform pg_temp.expect_undo_denied(task,4,'40001');
  perform pg_temp.person(1);
  perform pg_temp.expect_undo_denied(task,4,'42501');
  perform public.garage_vehicle_action(id,'return',(pg_temp.visit(id)->>'version')::integer,gen_random_uuid(),'');
  perform public.garage_pay_save(task,0,1234,jsonb_build_array(jsonb_build_object('mechanic_id',b,'basis_points',10000)),
    '',false,gen_random_uuid());
  allocated:=public.garage_pay_history(task);
  perform public.garage_save_task_pricing(task,0,0,'Gift',gen_random_uuid());
  perform pg_temp.person(3);
  perform pg_temp.verify_undo((pg_temp.visit(id)#>>'{tasks,0,can_uncheck_work}')::boolean,'returned vehicle can be corrected');
  returned:=public.garage_uncheck_work(task,4,gen_random_uuid());
  view:=pg_temp.visit(id);
  perform pg_temp.verify_undo(returned->>'status'='pending' and view#>>'{tasks,0,completed_at}' is null
    and view#>>'{tasks,0,working_mechanic_id}' is null and (view#>>'{vehicle_workflow,completed_count}')::integer=0
    and (view#>>'{vehicle_workflow,unfinished_count}')::integer=1,'last credit reopens work and clears reporting completion');
  view:=pg_temp.sheet_row();
  perform pg_temp.verify_undo(not (view->>'complete')::boolean and view#>>'{tasks,0,mechanic_name}' is null
    and view#>>'{tasks,0,completed_at}' is null and exists(select from jsonb_array_elements(view->'known_outputs') prior
      where (prior->>'complete')::boolean),'sheet clears completion and replaces previous issued notes');
  perform pg_temp.person(1);
  perform pg_temp.verify_undo(not exists(select from jsonb_array_elements(public.garage_pay_worklist()) item
    where item->>'task_id'=task::text) and public.garage_pay_history(task)=allocated,'withdrawn completion leaves payroll list and retains history');
  perform pg_temp.person(3);
  perform public.garage_check_work(task,gen_random_uuid());
  perform pg_temp.person(1);
  perform pg_temp.verify_undo(exists(select from jsonb_array_elements(public.garage_pay_worklist()) item
    where item->>'task_id'=task::text and item->>'version'='1' and item->>'pool_kopeks'='1234')
    and public.garage_pay_history(task)=allocated,'recheck preserves saved pay once');
  perform pg_temp.person(2);
  perform public.garage_check_work(private_job,gen_random_uuid());
  perform public.garage_uncheck_work(private_job,2,gen_random_uuid());
  view:=pg_temp.visit(private_id);
  perform pg_temp.verify_undo(view#>>'{tasks,0,status}'='pending' and view#>>'{tasks,0,my_status}'='assigned'
    and (view#>>'{tasks,0,can_check_work}')::boolean,'private assignment remains visible and can be checked again');
end $$;
reset role;
select pg_temp.verify_undo(not exists(select from garage_pay.items where task_id='b0000000-0000-4000-8000-000000000002')
  and not exists(select from public.garage_task_completions where task_id='b0000000-0000-4000-8000-000000000002'),
  'unallocated withdrawn work leaves no live completion or payroll item');
select pg_temp.verify_undo((select count(*)=2 from public.garage_task_events
  where task_id='b0000000-0000-4000-8000-000000000001' and action='uncheck_work')
  and exists(select from garage_pay.task_pricing_revisions where task_id='b0000000-0000-4000-8000-000000000001'
    and override_kopeks=0),'all corrections audited and customer pricing preserved');

-- Simulate a mark recorded before membership recovery snapshots were installed.
delete from garage_board.check_restore s using public.garage_task_participants m
  where m.task_id='b0000000-0000-4000-8000-000000000001' and s.member_id=m.id;
set local role authenticated;
do $$
declare id uuid:='a0000000-0000-4000-8000-000000000002'; task uuid:='b0000000-0000-4000-8000-000000000002';
  shared uuid:='b0000000-0000-4000-8000-000000000001'; state jsonb; v integer;
begin
  perform pg_temp.person(3);
  state:=public.garage_uncheck_work(shared,6,gen_random_uuid());
  perform pg_temp.verify_undo(state->>'status'='pending','old inline check works without a snapshot');
  perform pg_temp.person(2);
  perform public.garage_vehicle_action(id,'take',(pg_temp.visit(id)->>'version')::integer,gen_random_uuid());
  v:=(pg_temp.visit(id)#>>'{tasks,0,version}')::integer;
  perform public.garage_team_action(task,'start',v,gen_random_uuid());
  perform public.garage_team_action(task,'block',v+1,gen_random_uuid(),'Need suitable film');
  perform public.garage_check_work(task,gen_random_uuid());
  perform public.garage_uncheck_work(task,v+3,gen_random_uuid());
  state:=pg_temp.visit(id)->'tasks'->0;
  perform pg_temp.verify_undo(state->>'my_status'='blocked' and state->>'status'='blocked'
    and state->>'blocker_reason'='Need suitable film','recover blocked membership and its reason');
  perform public.garage_team_action(task,'resume',v+4,gen_random_uuid());
  perform public.garage_team_action(task,'confirm',v+5,gen_random_uuid());
  perform pg_temp.verify_undo(not (pg_temp.visit(id)#>>'{tasks,0,can_uncheck_work}')::boolean,'protect separate legacy confirmation');
  perform pg_temp.expect_undo_denied(task,v+6,'42501');
end $$;
rollback;
