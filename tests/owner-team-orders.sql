-- Synthetic acceptance fixture for tests/test-team-workflow.py.
begin;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare
  a uuid:='00000000-0000-4000-8000-000000000002'; b uuid:='00000000-0000-4000-8000-000000000003';
  id uuid; receipt uuid:=gen_random_uuid(); first jsonb; tasks jsonb; snapshot jsonb; one jsonb; two jsonb;
  draft jsonb:='{"source":"owner","vehicle":"Редактирование команды","vehicle_group_code":"VG02"}';
  actual timestamptz:=now()-interval '1 hour'; supplement jsonb; check_count int;
begin
  tasks:=jsonb_build_array(jsonb_build_object('work_code','W01','assigned_to',a,'mechanic_ids',array[a,b]),
    jsonb_build_object('work_code','W09','assigned_to',b,'mechanic_ids',array[b]));
  first:=public.garage_save_team_order('new',null,null,draft,tasks,receipt);
  id:=(first->>'order_id')::uuid;
  if public.garage_save_team_order('new',null,null,draft,tasks,receipt) is distinct from first then raise exception 'Create replay changed'; end if;
  select value into strict snapshot from jsonb_array_elements(public.garage_list_orders()) where value->>'id'=id::text;
  select value into strict one from jsonb_array_elements(snapshot->'tasks') where value->>'work_code'='W01';
  select value into strict two from jsonb_array_elements(snapshot->'tasks') where value->>'work_code'='W09';
  if jsonb_array_length(one->'participants')<>2 or jsonb_array_length(two->'participants')<>1 then raise exception 'Private teams differ per work'; end if;
  tasks:=jsonb_build_array(tasks->0||jsonb_build_object('id',one->'id'),tasks->1||jsonb_build_object('id',two->'id'));
  draft:=draft||jsonb_build_object('colour','Синий');
  perform public.garage_save_team_order('edit',id,(snapshot->>'version')::int,draft,tasks,gen_random_uuid());
  select value into strict snapshot from jsonb_array_elements(public.garage_list_orders()) where value->>'id'=id::text;
  if snapshot->>'colour'<>'Синий' then raise exception 'Edit not saved'; end if;
  begin
    perform public.garage_save_team_order('new',null,null,draft||'{"vehicle":"Rollback roster"}'::jsonb,
      jsonb_build_array(jsonb_build_object('work_code','W09','assigned_to',a,'mechanic_ids',array[a,gen_random_uuid()])),gen_random_uuid());
    raise exception using errcode='ZX001',message='Should reject invalid teammate';
  exception when sqlstate 'P0001' then null; end;
  if exists(select from public.garage_orders where vehicle='Rollback roster') then raise exception 'Partial order after invalid team'; end if;
  receipt:=gen_random_uuid();
  supplement:=public.garage_record_team_omission(id,(snapshot->>'version')::int,'W07','{}',array[a,b],actual,'Совместная работа пропущена в заказе',receipt);
  if public.garage_record_team_omission(id,(snapshot->>'version')::int,'W07','{}',array[a,b],actual,'Совместная работа пропущена в заказе',receipt) is distinct from supplement then raise exception 'Omission replay changed'; end if;
  select t.value into strict one from jsonb_array_elements(public.garage_list_orders()) o
    cross join lateral jsonb_array_elements(o.value->'tasks') t where t.value->>'id'=supplement->>'task_id';
  select count(*) into check_count from jsonb_array_elements(one->'participants') p
    where p.value->>'confirmation_origin'='owner_recorded' and (p.value->>'confirmed_at')::timestamptz=actual;
  if check_count<>2 then raise exception 'Omission provenance missing'; end if;
end $$;
rollback;
