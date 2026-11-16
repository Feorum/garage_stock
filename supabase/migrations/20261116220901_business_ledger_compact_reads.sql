-- Keep full source detail on the selected sheet and transfer only calculation inputs.
begin;
create or replace function public.garage_ledger_imports() returns jsonb
language plpgsql security invoker stable set search_path=pg_catalog as $$
declare result jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only an active Owner can view the business ledger.'; end if;
  select coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('sheets',(
    select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('metadata',s.metadata-'layout') order by s.sort),'[]'::jsonb)
    from garage_ledger.sheets s where s.import_id=i.id)) order by i.imported_at desc),'[]'::jsonb)
    into result from garage_ledger.imports i;
  return result;
end $$;

create or replace function public.garage_ledger_context(p_import_id uuid) returns jsonb
language plpgsql security invoker stable set search_path=pg_catalog as $$
declare result jsonb;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Only an active Owner can view the business ledger.'; end if;
  select jsonb_build_object('revision',i.revision,'sheets',(
    select coalesce(jsonb_agg(jsonb_build_object('name',s.name,'rows',(
      select coalesce(jsonb_agg(jsonb_build_object('source_row',r.source_row,'cells',(
        select coalesce(jsonb_object_agg(c.key,c.value-'cached'-'format'),'{}'::jsonb) from jsonb_each(r.cells) c),
        'archived',r.archived) order by r.position,r.id),'[]'::jsonb)
      from garage_ledger.rows r where r.sheet_id=s.id)) order by s.sort),'[]'::jsonb)
    from garage_ledger.sheets s where s.import_id=i.id)) into result
    from garage_ledger.imports i where i.id=p_import_id;
  if result is null then raise exception using errcode='42501',message='Ledger import unavailable.'; end if;
  return result;
end $$;
revoke all on function public.garage_ledger_imports(),public.garage_ledger_context(uuid) from public,anon,authenticated,service_role;
grant execute on function public.garage_ledger_imports(),public.garage_ledger_context(uuid) to authenticated;
insert into public.garage_schema_migrations(version) values ('20261116220901');
commit;
