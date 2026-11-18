-- Disposable PostgreSQL fixture. All effects roll back.
begin;
create function pg_temp.visit(order_id uuid) returns jsonb
language sql as $$select item from jsonb_array_elements(public.garage_list_orders()) item where item->>'id'=order_id::text$$;
create function pg_temp.ride(order_id uuid, action text, note text default '') returns jsonb
language sql as $$select public.garage_vehicle_action(order_id,action,(pg_temp.visit(order_id)->>'version')::integer,gen_random_uuid(),note)$$;
create function pg_temp.deny(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when sqlstate '40001' or sqlstate '42501' or sqlstate 'P0001' then return; end;
  raise exception 'An unavailable vehicle action was allowed';
end $$;
set local role authenticated;
do $$
declare
  owner_id uuid:='00000000-0000-4000-8000-000000000001'; a uuid:='00000000-0000-4000-8000-000000000002';
  b uuid:='00000000-0000-4000-8000-000000000003'; outsider uuid:='00000000-0000-4000-8000-000000000004';
  id uuid; other uuid; orphan uuid; first_task uuid; other_task uuid; receipt uuid:=gen_random_uuid(); reply jsonb; order_data jsonb; flow jsonb;
  confirmation_key uuid:=gen_random_uuid(); confirmed jsonb; first_version int;
begin
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  id:=(public.garage_create_order('Repeated vehicle','VG02','owner',jsonb_build_array(
    jsonb_build_object('work_code','W01','assigned_to',a), jsonb_build_object('work_code','W09','assigned_to',b)),
    gen_random_uuid(),p_vin=>'TEST0000000000901')->>'order_id')::uuid;
  other:=(public.garage_create_order('Repeated vehicle','VG02','owner',jsonb_build_array(
    jsonb_build_object('work_code','W01','assigned_to',a)),gen_random_uuid(),p_vin=>'TEST0000000000901')->>'order_id')::uuid;
  select (t->>'id')::uuid into strict first_task from jsonb_array_elements(pg_temp.visit(id)->'tasks') t where t->>'work_code'='W01';
  select (t->>'id')::uuid into strict other_task from jsonb_array_elements(pg_temp.visit(id)->'tasks') t where t->>'work_code'='W09';

  perform set_config('request.jwt.claim.sub',outsider::text,true);
  if pg_temp.visit(id) is not null then raise exception 'Private vehicle visible to outsider'; end if;
  perform pg_temp.deny(format('select garage_vehicle_action(%L,''take'',1,gen_random_uuid())',id));

  perform set_config('request.jwt.claim.sub',a::text,true);
  order_data:=pg_temp.visit(id);
  if order_data#>>'{vehicle_workflow,state}'<>'available' or not(order_data#>>'{vehicle_workflow,can_take}')::boolean then raise exception 'Private participant cannot take visit'; end if;
  perform pg_temp.deny(format('select garage_task_action(%L,''start'',1,gen_random_uuid())',first_task));
  first_version:=(order_data->>'version')::int;
  reply:=public.garage_vehicle_action(id,'take',first_version,receipt);
  if reply is distinct from public.garage_vehicle_action(id,'take',first_version,receipt) then raise exception 'Take receipt replay changed'; end if;
  if pg_temp.visit(other)#>>'{vehicle_workflow,state}'<>'available' or jsonb_array_length(pg_temp.visit(id)->'tasks')<>1 then raise exception 'Taking one vehicle changed another visit or task authorization'; end if;
  perform pg_temp.deny(format('select garage_team_action(%L,''start'',1,gen_random_uuid())',other_task));
  perform public.garage_team_action(first_task,'start',1,gen_random_uuid());
  confirmed:=public.garage_task_action(first_task,'complete',2,confirmation_key);

  perform set_config('request.jwt.claim.sub',b::text,true);
  if pg_temp.visit(id)#>>'{vehicle_workflow,holder_id}'<>a::text then raise exception 'Visit holder missing from teammate view'; end if;
  perform pg_temp.deny(format('select pg_temp.ride(%L,''handoff'')',id));
  perform set_config('request.jwt.claim.sub',a::text,true);
  perform pg_temp.deny(format('select pg_temp.ride(%L,''handoff'',''Price $100'')',id));
  perform pg_temp.ride(id,'handoff','Operational handoff note');
  flow:=pg_temp.visit(id)->'vehicle_workflow';
  if flow->>'state'<>'review' or (flow->>'unfinished_count')::integer<>0 or jsonb_array_length(flow->'handoff_tasks')<>1 then
    raise exception 'Private holder learned another assignment or failed to hand off';
  end if;
  if public.garage_task_action(first_task,'complete',2,confirmation_key) is distinct from confirmed then raise exception 'Completed receipt replay failed after handoff'; end if;
  perform set_config('request.jwt.claim.sub',b::text,true);
  flow:=pg_temp.visit(id)->'vehicle_workflow';
  if flow->>'handoff_note'<>'' or jsonb_array_length(flow->'handoff_tasks')<>0 then raise exception 'Private handoff note or snapshot exposed'; end if;
  perform pg_temp.deny(format('select garage_task_action(%L,''start'',1,gen_random_uuid())',other_task));
  perform pg_temp.deny(format('select garage_team_action(%L,''start'',1,gen_random_uuid())',other_task));
  perform pg_temp.deny(format('select garage_team_action(%L,''note'',1,gen_random_uuid(),''Stale note'')',other_task));

  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  flow:=pg_temp.visit(id)->'vehicle_workflow';
  if flow->>'handoff_note'<>'Operational handoff note' or (flow->>'completed_count')::int<>1 or (flow->>'unfinished_count')::int<>1
    or jsonb_array_length(flow->'handoff_tasks')<>2 or (flow->>'can_close')::boolean then raise exception 'Owner partial report is incorrect'; end if;
  perform pg_temp.deny(format('select pg_temp.ride(%L,''close'')',id));
  perform pg_temp.ride(id,'return','Continue remaining work');
  perform set_config('request.jwt.claim.sub',b::text,true);
  perform public.garage_task_action(other_task,'start',1,gen_random_uuid());
  perform public.garage_task_action(other_task,'complete',2,gen_random_uuid());
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  order_data:=pg_temp.visit(id);
  if (order_data#>>'{vehicle_workflow,can_close}')::boolean then raise exception 'Active vehicle offered premature close'; end if;
  if not exists(select from jsonb_array_elements(order_data#>'{vehicle_workflow,handoff_tasks}') t where t->>'id'=other_task::text and t->>'status'='pending') then raise exception 'Earlier handoff snapshot was rewritten'; end if;
  perform pg_temp.deny(format('select garage_order_action(%L,''close'',%s,gen_random_uuid())',id,order_data->>'version'));
  perform pg_temp.deny(format('select pg_temp.ride(%L,''close'')',id));
  perform set_config('request.jwt.claim.sub',a::text,true);
  perform pg_temp.ride(id,'handoff');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  if not(pg_temp.visit(id)#>>'{vehicle_workflow,can_close}')::boolean then raise exception 'Finished handoff cannot close'; end if;
  perform pg_temp.ride(id,'close');
  if pg_temp.visit(id)#>>'{vehicle_workflow,state}'<>'closed' then raise exception 'Visit did not close'; end if;

  -- A mechanic may coordinate a shared visit while someone else does its work.
  -- Their own handoff record stays available after closure without exposing current private task details.
  id:=(public.garage_create_order('Handoff history vehicle','VG02','manager','[{"work_code":"W01"}]',gen_random_uuid())->>'order_id')::uuid;
  perform set_config('request.jwt.claim.sub',a::text,true);
  perform pg_temp.ride(id,'take');
  first_task:=(pg_temp.visit(id)#>>'{tasks,0,id}')::uuid;
  perform set_config('request.jwt.claim.sub',b::text,true);
  perform public.garage_team_action(first_task,'join',1,gen_random_uuid());
  perform public.garage_team_action(first_task,'confirm',2,gen_random_uuid());
  perform set_config('request.jwt.claim.sub',a::text,true);
  perform pg_temp.ride(id,'handoff');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform pg_temp.ride(id,'close');
  perform set_config('request.jwt.claim.sub',a::text,true);
  order_data:=pg_temp.visit(id);
  if order_data is null or order_data#>>'{vehicle_workflow,state}'<>'closed' or jsonb_array_length(order_data->'tasks')<>0
    or order_data#>>'{vehicle_workflow,handoff_tasks,0,status}'<>'completed' then raise exception 'Custody-only handoff history inaccessible or exposed live task details'; end if;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  orphan:=(public.garage_create_order('Recovery vehicle','VG02','manager','[{"work_code":"W01"}]',gen_random_uuid())->>'order_id')::uuid;
  perform set_config('request.jwt.claim.sub',outsider::text,true);
  perform pg_temp.ride(orphan,'take');
  perform set_config('test.orphan_visit',orphan::text,true);
end $$;

reset role;
update public.profiles set active=false where id='00000000-0000-4000-8000-000000000004';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$ declare id uuid:=current_setting('test.orphan_visit')::uuid; begin
  if not (pg_temp.visit(id)#>>'{vehicle_workflow,can_return}')::boolean then raise exception 'Owner cannot recover missing holder'; end if;
  perform pg_temp.ride(id,'return','Former mechanic no longer active');
  if pg_temp.visit(id)#>>'{vehicle_workflow,state}'<>'available' or pg_temp.visit(id)#>>'{vehicle_workflow,holder_id}' is not null then
    raise exception 'Recovered visit still has inactive custody'; end if;
end $$;
rollback;
