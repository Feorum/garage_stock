-- Append Owner-confirmed omitted work without rewriting any prior completion.
begin;
create function public.garage_record_omitted_completion(
  p_order_id uuid,p_expected_version integer,p_work_code text,p_options jsonb,p_mechanic_id uuid,
  p_completed_at timestamptz,p_note text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor uuid; parent public.garage_orders%rowtype; payload jsonb; cached jsonb; chosen public.garage_works%rowtype;
  task_id uuid; response jsonb;
begin
  actor:=public.garage_require_actor();
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only the Owner can record omitted completed work.'; end if;
  perform 1 from public.garage_sheet_sources s where s.id in(
    select so.source_id from public.garage_sheet_orders so where so.order_id=p_order_id
    union select i.source_id from public.garage_manager_intake i where i.order_id=p_order_id) order by s.id for update;
  actor:=public.garage_lock_actor();
  payload:=jsonb_build_object('operation','record_omitted_completion','order_id',p_order_id,'expected',p_expected_version,
    'work_code',p_work_code,'options',p_options,'mechanic_id',p_mechanic_id,'completed_at',p_completed_at,'note',p_note);
  cached:=public.garage_begin_request(p_request_id,payload);if cached is not null then return cached;end if;
  select * into parent from public.garage_orders where id=p_order_id for update;
  if not found then raise exception 'Order unavailable.'; end if;
  if parent.status not in('published','closed') or parent.version is distinct from p_expected_version then
    raise exception using errcode='40001',message='The order changed. Refresh before recording omitted work.';
  end if;
  if parent.source='manager' and exists(select 1 from public.garage_sheet_sources s where s.id in(
    select so.source_id from public.garage_sheet_orders so where so.order_id=p_order_id
    union select i.source_id from public.garage_manager_intake i where i.order_id=p_order_id) and s.owner_id<>actor) then
    raise exception using errcode='42501',message='Only the source Owner can correct this Manager order.';
  end if;
  if p_note is null or length(btrim(p_note)) not between 1 and 2000 or public.garage_private_note(p_note) then
    raise exception 'Provide an operational reason without private financial details.';
  end if;
  if p_completed_at is null or not isfinite(p_completed_at) or p_completed_at>clock_timestamp() then
    raise exception 'Provide a recorded completion time that is not in the future.';
  end if;
  perform public.garage_lock_mechanic(p_mechanic_id);
  perform 1 from public.garage_order_tasks where order_id=p_order_id order by id for update;
  perform public.garage_validate_edit_tasks(parent.vehicle_group_code,
    jsonb_build_array(jsonb_build_object('work_code',p_work_code,'options',p_options)),null);
  if exists(select 1 from public.garage_order_tasks where order_id=p_order_id and status<>'cancelled' and work_code=p_work_code) then
    raise exception using errcode='40001',message='This catalogue work is already recorded in the order.';
  end if;
  if p_work_code in('W01','W03','W04') and exists(select 1 from public.garage_order_tasks where order_id=p_order_id
    and status<>'cancelled' and work_code in('W01','W03','W04')) then raise exception 'Only one hood coverage option can be recorded.'; end if;
  if (select count(*) from public.garage_order_tasks where order_id=p_order_id and status<>'cancelled')>=50 then
    raise exception 'An order can contain at most 50 approved works.';
  end if;
  select * into chosen from public.garage_works where code=p_work_code;
  insert into public.garage_order_tasks(order_id,work_code,work_name,options,status,assigned_to,working_mechanic_id,completed_at)
    values(parent.id,chosen.code,chosen.name,p_options,'completed',case when parent.source='owner' then p_mechanic_id else null end,
      p_mechanic_id,p_completed_at) returning id into task_id;
  perform public.garage_snapshot_task(task_id,parent.vehicle_group_code);
  insert into public.garage_task_completions(task_id,order_id,mechanic_id,work_code,work_name,completed_at)
    values(task_id,parent.id,p_mechanic_id,chosen.code,chosen.name,p_completed_at);
  insert into public.garage_task_events(order_id,task_id,actor_id,action,note)
    values(parent.id,task_id,actor,'record_omitted_completion',btrim(p_note));
  update public.garage_orders set version=version+1 where id=parent.id returning version into p_expected_version;
  update public.garage_manager_intake set owner_managed=true,version=version+1,updated_at=clock_timestamp() where order_id=parent.id;
  response:=jsonb_build_object('order_id',parent.id,'order_number',parent.order_number,'order_version',p_expected_version,'task_id',task_id);
  return public.garage_finish_request(p_request_id,payload,response);
end $$;
revoke all on function public.garage_record_omitted_completion(uuid,integer,text,jsonb,uuid,timestamptz,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.garage_record_omitted_completion(uuid,integer,text,jsonb,uuid,timestamptz,text,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values('20261116203339');
notify pgrst,'reload schema';
commit;
