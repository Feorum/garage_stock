-- Read wrappers use RLS and active Owner checks; no private schema is exposed.
begin;
create function public.garage_ledger_imports() returns jsonb
language plpgsql security invoker stable set search_path=pg_catalog as $$
declare result jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only an active Owner can view the business ledger.'; end if;
  select coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('sheets',(
    select coalesce(jsonb_agg(to_jsonb(s) order by s.sort),'[]'::jsonb)
    from garage_ledger.sheets s where s.import_id=i.id)) order by i.imported_at desc),'[]'::jsonb)
    into result from garage_ledger.imports i;
  return result;
end $$;

create function public.garage_ledger_sheet(p_sheet_id uuid) returns jsonb
language plpgsql security invoker stable set search_path=pg_catalog as $$
declare selected garage_ledger.sheets%rowtype; result jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only an active Owner can view the business ledger.'; end if;
  select * into selected from garage_ledger.sheets where id=p_sheet_id;
  if not found then raise exception using errcode='42501',message='Ledger sheet unavailable.'; end if;
  select jsonb_build_object('import',to_jsonb(i),'sheet',to_jsonb(selected),'rows',(
    select coalesce(jsonb_agg(to_jsonb(r) order by r.position,r.id),'[]'::jsonb)
    from garage_ledger.rows r where r.sheet_id=p_sheet_id)) into result
    from garage_ledger.imports i where i.id=selected.import_id;
  return result;
end $$;

create function public.garage_ledger_context(p_import_id uuid) returns jsonb
language plpgsql security invoker stable set search_path=pg_catalog as $$
declare result jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only an active Owner can view the business ledger.'; end if;
  select jsonb_build_object('revision',i.revision,'sheets',(
    select coalesce(jsonb_agg(jsonb_build_object('name',s.name,'rows',(
      select coalesce(jsonb_agg(jsonb_build_object('source_row',r.source_row,'cells',r.cells,
        'archived',r.archived) order by r.position,r.id),'[]'::jsonb)
      from garage_ledger.rows r where r.sheet_id=s.id)) order by s.sort),'[]'::jsonb)
    from garage_ledger.sheets s where s.import_id=i.id)) into result
    from garage_ledger.imports i where i.id=p_import_id;
  if result is null then raise exception using errcode='42501',message='Ledger import unavailable.'; end if;
  return result;
end $$;

create function public.garage_ledger_history(p_row_id uuid) returns jsonb
language plpgsql security invoker stable set search_path=pg_catalog as $$
declare selected garage_ledger.rows%rowtype; result jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only an active Owner can view the business ledger.'; end if;
  select * into selected from garage_ledger.rows where id=p_row_id;
  if not found then raise exception using errcode='42501',message='Ledger row unavailable.'; end if;
  select coalesce(jsonb_agg(to_jsonb(v)||jsonb_build_object('actor_name',p.name) order by v.version desc),'[]'::jsonb)
    into result from garage_ledger.revisions v join public.profiles p on p.id=v.actor_id where v.row_id=p_row_id;
  if selected.source_row is not null then
    result:=result||jsonb_build_array(jsonb_build_object('id','source','version',1,'action','import',
      'actor_id',selected.created_by,'actor_name',(select name from public.profiles where id=selected.created_by),
      'reason','Imported source','created_at',selected.created_at,'after_state',jsonb_build_object(
        'cells',selected.original_cells,'section',selected.original_section,'archived',false)));
  end if;
  return result;
end $$;

revoke all on function public.garage_ledger_imports(),public.garage_ledger_sheet(uuid),
  public.garage_ledger_context(uuid),public.garage_ledger_history(uuid) from public,anon,authenticated,service_role;
grant execute on function public.garage_ledger_imports(),public.garage_ledger_sheet(uuid),
  public.garage_ledger_context(uuid),public.garage_ledger_history(uuid) to authenticated;
insert into public.garage_schema_migrations(version) values ('20261116215610');
commit;
