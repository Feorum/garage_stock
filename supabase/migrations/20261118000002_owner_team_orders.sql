-- Extend the existing catalogue, source identity, rate and retry contracts to teams.
begin;

create function public.garage_save_team_order(
  p_mode text,p_id uuid,p_expected_version integer,p_order jsonb,p_tasks jsonb,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  payload jsonb; result jsonb; source_kind text; fields jsonb := p_order - 'source';
  legacy_tasks jsonb; item jsonb; original_task uuid; saved_task public.garage_order_tasks%rowtype;
  worker uuid; requested uuid[]; current_team uuid[]; new_order_id uuid;
begin
  perform public.garage_require_actor();
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  payload := jsonb_build_object('op','save_team_order','mode',p_mode,'id',p_id,'version',p_expected_version,'order',p_order,'tasks',p_tasks);
  result := public.garage_begin_request(p_request_id,payload);
  if result is not null then return result; end if;
  if p_mode is null or p_mode not in ('new','intake','edit') then raise exception 'Unsupported edit mode.'; end if;
  if p_mode = 'new' then
    if p_id is not null or p_expected_version is not null then raise exception 'Unexpected existing identity.'; end if;
    source_kind := p_order->>'source';
  elsif p_mode = 'intake' then source_kind := 'manager';
  else select source into strict source_kind from public.garage_orders where id=p_id;
  end if;
  if source_kind is null or source_kind not in ('owner','manager') or p_order->>'source' is distinct from source_kind then
    raise exception 'Invalid order source.';
  end if;
  perform public.garage_validate_edit_fields(fields);
  if jsonb_typeof(p_tasks) is distinct from 'array' then raise exception 'Choose approved works.'; end if;
  select jsonb_agg(value - 'mechanic_ids' order by ordinality) into legacy_tasks
    from jsonb_array_elements(p_tasks) with ordinality;
  perform public.garage_validate_edit_tasks(fields->>'vehicle_group_code',legacy_tasks,null);
  if public.garage_private_note(fields->>'instructions') or exists(select from jsonb_array_elements(p_tasks) t
    where public.garage_private_note(t->>'instructions')) then raise exception 'Use operational instructions only.'; end if;

  if p_mode='edit' and source_kind='owner' and exists(
    select 1 from jsonb_array_elements(legacy_tasks) x
    join public.garage_order_tasks t on t.id=nullif(x->>'id','')::uuid and t.order_id=p_id
    where t.assigned_to is distinct from nullif(x->>'assigned_to','')::uuid
  ) then raise exception 'Change the team with an attributed roster action.'; end if;

  -- The legacy routines retain their source-first locking, protected task, frozen price and CAS rules.
  -- Their receipt and all roster writes are committed atomically with the outer receipt.
  case p_mode
    when 'edit' then result := public.garage_edit_order(p_id,p_expected_version,fields,legacy_tasks,gen_random_uuid());
    when 'intake' then result := public.garage_publish_manager_intake(p_id,p_expected_version,fields,legacy_tasks,gen_random_uuid());
    else result := public.garage_create_order(fields->>'vehicle',fields->>'vehicle_group_code',source_kind,legacy_tasks,
      gen_random_uuid(),coalesce(fields->>'instructions',''),nullif(fields->>'due_date','')::date,
      coalesce(fields->>'priority','normal'),coalesce(fields->>'vin',''),coalesce(fields->>'colour',''),
      coalesce(fields->>'manager_label',''),nullif(fields->>'planned_date','')::date);
  end case;
  new_order_id := (result->>'order_id')::uuid;
  for item in select value from jsonb_array_elements(p_tasks) loop
    if item ? 'mechanic_ids' and jsonb_typeof(item->'mechanic_ids') is distinct from 'array' then
      raise exception 'Invalid participant selection.';
    end if;
    if source_kind='manager' then
      if coalesce(jsonb_array_length(item->'mechanic_ids'),0)>0 then raise exception 'Manager tasks are open for joining.'; end if;
      continue;
    end if;
    select array_agg(member::uuid order by member::uuid) into requested from jsonb_array_elements_text(item->'mechanic_ids') member;
    if cardinality(requested) is null or array_position(requested,null) is not null
      or not (nullif(item->>'assigned_to','')::uuid = any(requested))
      or cardinality(requested) <> (select count(distinct id) from unnest(requested) id) then
      raise exception 'Select each assigned participant once.';
    end if;
    select t.* into strict saved_task from public.garage_order_tasks t where t.order_id=new_order_id
      and t.work_code=item->>'work_code' and t.status<>'cancelled';
    original_task := nullif(item->>'id','')::uuid;
    if saved_task.id=original_task then
      select array_agg(m.mechanic_id order by m.mechanic_id) into current_team from public.garage_task_participants m
        where m.task_id=saved_task.id and m.departed_at is null;
      if current_team is distinct from requested then raise exception 'Change the team with an attributed roster action.'; end if;
    else
      -- Inserting a task seeds its primary mechanic through the membership trigger.
      foreach worker in array requested loop
        if worker=saved_task.assigned_to then continue; end if;
        perform public.garage_lock_mechanic(worker);
        insert into public.garage_task_participants(task_id,mechanic_id,status) values(saved_task.id,worker,'assigned');
        insert into public.garage_task_events(order_id,task_id,actor_id,action,note) values
          (new_order_id,saved_task.id,auth.uid(),'assign','Назначен при создании работы: '||worker::text);
      end loop;
    end if;
  end loop;
  return public.garage_finish_request(p_request_id,payload,result);
end $$;

create function public.garage_record_team_omission(
  p_order_id uuid,p_expected_version integer,p_work_code text,p_options jsonb,p_mechanic_ids uuid[],
  p_completed_at timestamptz,p_note text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare payload jsonb; result jsonb; worker uuid;
begin
  perform public.garage_require_actor();
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  payload := jsonb_build_object('op','record_team_omission','order',p_order_id,'version',p_expected_version,
    'work',p_work_code,'options',p_options,'people',p_mechanic_ids,'at',p_completed_at,'reason',p_note);
  result := public.garage_begin_request(p_request_id,payload);
  if result is not null then return result; end if;
  if coalesce(cardinality(p_mechanic_ids),0)=0 or array_position(p_mechanic_ids,null) is not null
    or cardinality(p_mechanic_ids)<>(select count(distinct id) from unnest(p_mechanic_ids) id) then
    raise exception 'Select each contributor once.';
  end if;
  result := public.garage_record_omitted_completion(p_order_id,p_expected_version,p_work_code,p_options,
    p_mechanic_ids[1],p_completed_at,p_note,gen_random_uuid());
  foreach worker in array p_mechanic_ids loop
    if worker=p_mechanic_ids[1] then continue; end if;
    perform public.garage_lock_mechanic(worker);
    insert into public.garage_task_participants(task_id,mechanic_id,status,started_at,confirmed_at,confirmation_origin)
      values((result->>'task_id')::uuid,worker,'confirmed',p_completed_at,p_completed_at,'owner_recorded');
  end loop;
  return public.garage_finish_request(p_request_id,payload,result);
end $$;

revoke all on function public.garage_save_team_order(text,uuid,integer,jsonb,jsonb,uuid),
  public.garage_record_team_omission(uuid,integer,text,jsonb,uuid[],timestamptz,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.garage_save_team_order(text,uuid,integer,jsonb,jsonb,uuid),
  public.garage_record_team_omission(uuid,integer,text,jsonb,uuid[],timestamptz,text,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values ('20261118000002');
notify pgrst,'reload schema';
commit;
