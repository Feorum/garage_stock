-- Undo appends an audited version rather than erasing later history.
begin;
create function garage_ledger.restore_row(
  p_row_id uuid,p_revision_id text,p_expected_version integer,p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  actor uuid:=garage_ledger.require_owner(); selected garage_ledger.rows%rowtype;
  batch garage_ledger.imports%rowtype; target jsonb; before_state jsonb;
  payload jsonb; receipt garage_ledger.requests%rowtype; result jsonb;
  reason text:=btrim(coalesce(p_reason,''));
begin
  if p_request_id is null or p_expected_version is null or reason='' or length(reason)>2000 then
    raise exception 'Give a reason for restoring a ledger revision.';
  end if;
  payload:=jsonb_build_object('action','restore','row_id',p_row_id,'revision_id',p_revision_id,
    'expected_version',p_expected_version,'reason',p_reason);
  perform pg_advisory_xact_lock(hashtextextended(actor::text||p_request_id::text,0));
  select * into receipt from garage_ledger.requests where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.payload is distinct from payload then raise exception using errcode='22023',message='This request ID was already used for another change.'; end if;
    return receipt.response;
  end if;
  select * into selected from garage_ledger.rows where id=p_row_id;
  if not found then raise exception using errcode='42501',message='Ledger row unavailable.'; end if;
  select i.* into batch from garage_ledger.imports i join garage_ledger.sheets s on s.import_id=i.id
    where s.id=selected.sheet_id for update of i;
  if batch.status<>'ready' then raise exception using errcode='42501',message='Ledger import unavailable.'; end if;
  select * into selected from garage_ledger.rows where id=p_row_id for update;
  if selected.version<>p_expected_version then
    raise exception using errcode='40001',message='This row changed in another session. Reload its latest version before restoring.';
  end if;
  if p_revision_id='source' and selected.source_row is not null then
    target:=jsonb_build_object('cells',selected.original_cells,'section',selected.original_section,'archived',false);
  else
    select after_state into target from garage_ledger.revisions
      where id::text=p_revision_id and row_id=p_row_id;
  end if;
  if target is null then raise exception 'The selected ledger revision is unavailable.'; end if;
  before_state:=jsonb_build_object('cells',selected.cells,'section',selected.section,'archived',selected.archived);
  if before_state=target then raise exception 'This revision is already current.'; end if;
  update garage_ledger.rows set cells=target->'cells',section=target->>'section',archived=(target->>'archived')::boolean,
    version=version+1,updated_at=clock_timestamp() where id=p_row_id returning * into selected;
  insert into garage_ledger.revisions(row_id,version,actor_id,action,before_state,after_state,reason,request_id)
    values(p_row_id,selected.version,actor,'restore',before_state,target,reason,p_request_id);
  update garage_ledger.imports set revision=revision+1 where id=batch.id returning * into batch;
  result:=jsonb_build_object('row',to_jsonb(selected),'revision',batch.revision);
  insert into garage_ledger.requests(actor_id,request_id,payload,response) values(actor,p_request_id,payload,result);
  return result;
end $$;
revoke all on function garage_ledger.restore_row(uuid,text,integer,text,uuid) from public,anon,authenticated,service_role;
grant execute on function garage_ledger.restore_row(uuid,text,integer,text,uuid) to authenticated;

create function public.garage_ledger_restore(
  p_row_id uuid,p_revision_id text,p_expected_version integer,p_reason text,p_request_id uuid
) returns jsonb language sql security invoker set search_path=pg_catalog as $$
  select garage_ledger.restore_row(p_row_id,p_revision_id,p_expected_version,p_reason,p_request_id)
$$;
revoke all on function public.garage_ledger_restore(uuid,text,integer,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.garage_ledger_restore(uuid,text,integer,text,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values ('20261116215612');
commit;
