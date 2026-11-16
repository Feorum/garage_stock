-- Atomic Owner edits; source cells stay immutable, and every write has a receipt.
begin;
create function garage_ledger.save_row(
  p_sheet_id uuid,p_row_id uuid,p_expected_version integer,p_cells jsonb,p_section text,
  p_archived boolean,p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  actor uuid:=garage_ledger.require_owner(); selected garage_ledger.rows%rowtype;
  sheet garage_ledger.sheets%rowtype; batch garage_ledger.imports%rowtype;
  receipt garage_ledger.requests%rowtype; payload jsonb; result jsonb; before_state jsonb;
  field record; original jsonb; previous jsonb; working jsonb:=p_cells;
  adding boolean:=p_row_id is null; action_name text; reason text:=btrim(coalesce(p_reason,''));
begin
  if p_request_id is null or p_expected_version is null or p_archived is null or length(reason)>2000 then
    raise exception 'Invalid ledger save request.';
  end if;
  payload:=jsonb_build_object('action','save','sheet_id',p_sheet_id,'row_id',p_row_id,'expected_version',p_expected_version,
    'cells',p_cells,'section',p_section,'archived',p_archived,'reason',p_reason);
  perform pg_advisory_xact_lock(hashtextextended(actor::text||p_request_id::text,0));
  select * into receipt from garage_ledger.requests where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.payload is distinct from payload then raise exception using errcode='22023',message='This request ID was already used for another change.'; end if;
    return receipt.response;
  end if;
  perform garage_ledger.validate_cells(p_cells);
  select * into sheet from garage_ledger.sheets where id=p_sheet_id;
  if not found then raise exception using errcode='42501',message='Ledger sheet unavailable.'; end if;
  select * into batch from garage_ledger.imports where id=sheet.import_id for update;
  if batch.status<>'ready' then raise exception using errcode='42501',message='Ledger import unavailable.'; end if;
  if p_section is null or not exists(select 1 from jsonb_array_elements(coalesce(sheet.metadata->'sections','[]')) s where s->>'id'=p_section) then
    raise exception 'Choose a section from this ledger sheet.';
  end if;
  if adding then
    if p_expected_version<>0 or p_archived then raise exception 'A new ledger row starts at version zero and is active.'; end if;
    if p_cells='{}'::jsonb then raise exception 'Enter at least one ledger value.'; end if;
    selected.original_cells:='{}'::jsonb; selected.cells:='{}'::jsonb;
  else
    select * into selected from garage_ledger.rows where id=p_row_id and sheet_id=p_sheet_id for update;
    if not found then raise exception using errcode='42501',message='Ledger row unavailable.'; end if;
    if selected.version<>p_expected_version then
      raise exception using errcode='40001',message='This row changed in another session. Reload its latest version before saving.';
    end if;
    before_state:=jsonb_build_object('cells',selected.cells,'section',selected.section,'archived',selected.archived);
  end if;
  -- A save can edit inputs or override results, never replace source formulas.
  for field in select * from jsonb_each(working) loop
    original:=selected.original_cells->field.key; previous:=selected.cells->field.key;
    if field.value->>'formula' is distinct from original->>'formula' then
      raise exception 'Source formulas cannot be changed or added.';
    end if;
    if field.value->>'formula' is not null then
      if coalesce(field.value->'cached','null'::jsonb) is distinct from coalesce(original->'cached','null'::jsonb) then
        raise exception 'The source cached result cannot be changed.';
      end if;
      if coalesce((field.value->>'override')::boolean,false) then
        if (coalesce((previous->>'override')::boolean,false)=false
          or previous->'value' is distinct from field.value->'value'
          or previous->>'type' is distinct from field.value->>'type') and reason='' then
          raise exception 'Explain the manual calculation override.';
        end if;
      else
        working:=jsonb_set(working,array[field.key],original);
      end if;
    elsif coalesce((field.value->>'override')::boolean,false) then
      raise exception 'Only a calculated cell can have a manual override.';
    end if;
  end loop;
  if exists(select 1 from jsonb_each(selected.original_cells) f
    where f.value->>'formula' is not null and not (working ? f.key)) then
    raise exception 'Calculated source cells must remain in the row.';
  end if;
  if adding then
    insert into garage_ledger.rows(sheet_id,source_row,section,position,original_cells,original_section,cells,created_by)
      values (p_sheet_id,null,p_section,(select coalesce(max(position),0)+1 from garage_ledger.rows where sheet_id=p_sheet_id),
        '{}',p_section,working,actor) returning * into selected;
    action_name:='add';
  else
    action_name:=case when p_archived and not selected.archived then 'archive' else 'edit' end;
    if working=selected.cells and p_section=selected.section and p_archived=selected.archived then
      raise exception 'There are no changes to save.';
    end if;
    update garage_ledger.rows set cells=working,section=p_section,archived=p_archived,
      version=version+1,updated_at=clock_timestamp() where id=selected.id returning * into selected;
  end if;
  insert into garage_ledger.revisions(row_id,version,actor_id,action,before_state,after_state,reason,request_id)
    values(selected.id,selected.version,actor,action_name,before_state,
      jsonb_build_object('cells',selected.cells,'section',selected.section,'archived',selected.archived),
      coalesce(nullif(reason,''),case when action_name='add' then 'Added a ledger row' when action_name='archive' then 'Archived a ledger row' else 'Edited ledger inputs' end),p_request_id);
  update garage_ledger.imports set revision=revision+1 where id=batch.id returning * into batch;
  result:=jsonb_build_object('row',to_jsonb(selected),'revision',batch.revision);
  insert into garage_ledger.requests(actor_id,request_id,payload,response) values(actor,p_request_id,payload,result);
  return result;
end $$;
revoke all on function garage_ledger.save_row(uuid,uuid,integer,jsonb,text,boolean,text,uuid) from public,anon,authenticated,service_role;
grant execute on function garage_ledger.save_row(uuid,uuid,integer,jsonb,text,boolean,text,uuid) to authenticated;

create function public.garage_ledger_save_row(
  p_sheet_id uuid,p_row_id uuid,p_expected_version integer,p_cells jsonb,p_section text,
  p_archived boolean,p_reason text,p_request_id uuid
) returns jsonb language sql security invoker set search_path=pg_catalog as $$
  select garage_ledger.save_row(p_sheet_id,p_row_id,p_expected_version,p_cells,p_section,p_archived,p_reason,p_request_id)
$$;
revoke all on function public.garage_ledger_save_row(uuid,uuid,integer,jsonb,text,boolean,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.garage_ledger_save_row(uuid,uuid,integer,jsonb,text,boolean,text,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values ('20261116215611');
commit;
