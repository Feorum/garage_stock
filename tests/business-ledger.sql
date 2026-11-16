-- Synthetic isolated database only. Apply the normal schema and migrations first.
-- Never execute these fixtures in production.
create table public.ledger_test_checks(label text not null);
grant select,insert on public.ledger_test_checks to authenticated;
create function public.ledger_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'LEDGER ASSERTION FAILED: %',label; end if;
  insert into public.ledger_test_checks values(label);
  raise notice 'PASS: %',label;
end $$;
create function public.ledger_error(statement text,label text,expected_state text default null) returns void
language plpgsql as $$
declare failed boolean:=false;
begin
  begin execute statement;
  exception when others then
    failed:=true;
    if expected_state is not null and sqlstate<>expected_state then raise exception 'Unexpected SQLSTATE % for %: %',sqlstate,label,sqlerrm; end if;
  end;
  perform public.ledger_assert(failed,label);
end $$;

insert into auth.users(id,email,raw_user_meta_data) values
 ('66000000-0000-4000-8000-000000000001','ledger-owner@example.invalid','{"name":"Ledger Owner"}'),
 ('66000000-0000-4000-8000-000000000002','ledger-mechanic@example.invalid','{"name":"Ledger Mechanic"}');
update public.profiles set role='admin' where id='66000000-0000-4000-8000-000000000001';
insert into garage_ledger.imports(id,name,filename,source_sha256,imported_by,status) values
 ('66000000-0000-4000-8000-000000000010','Synthetic ledger','synthetic.xlsx',repeat('f',64),'66000000-0000-4000-8000-000000000001','ready'),
 ('66000000-0000-4000-8000-000000000011','Unfinished ledger','staging.xlsx',repeat('e',64),'66000000-0000-4000-8000-000000000001','staging');
insert into garage_ledger.sheets(id,import_id,sheet_key,name,sort,metadata) values
 ('66000000-0000-4000-8000-000000000020','66000000-0000-4000-8000-000000000010','one','Synthetic month',1,
  '{"headers":[{"column":"B","label":"Price"},{"column":"U","label":"Residual"}],"sections":[{"id":"ledger","label":"Ledger","start_row":2,"end_row":100}],"layout":{"private_source_styles":true}}'),
 ('66000000-0000-4000-8000-000000000021','66000000-0000-4000-8000-000000000011','one','Unfinished month',1,'{"sections":[{"id":"ledger"}]}');
insert into garage_ledger.rows(id,sheet_id,source_row,section,position,original_section,original_cells,cells,created_by)
select '66000000-0000-4000-8000-000000000030','66000000-0000-4000-8000-000000000020',2,'ledger',2,'ledger',v,v,'66000000-0000-4000-8000-000000000001'
from (select '{"B":{"value":20,"type":"number","formula":null,"cached":20,"format":"0.00"},"C":{"value":"Synthetic work","type":"string","formula":null,"cached":"Synthetic work","format":"General"},"U":{"value":40,"type":"number","formula":"=B2*2","cached":40,"format":"0.00"}}'::jsonb v) fixture;
insert into garage_ledger.rows(id,sheet_id,source_row,section,position,original_section,original_cells,cells,created_by)
values ('66000000-0000-4000-8000-000000000031','66000000-0000-4000-8000-000000000021',2,'ledger',2,'ledger','{}','{}','66000000-0000-4000-8000-000000000001');

select ledger_assert(not has_function_privilege('anon','public.garage_ledger_context(uuid)','execute'),'Anonymous cannot call ledger context');
select ledger_assert(not has_table_privilege('authenticated','garage_ledger.rows','UPDATE'),'Direct ledger updates are denied');
select ledger_assert(not has_table_privilege('authenticated','garage_ledger.requests','SELECT'),'Mutation receipts stay private');
select ledger_assert(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'garage_ledger_%' and p.prosecdef),'Public ledger wrappers use security invoker');

set role authenticated;
set request.jwt.claim.sub='66000000-0000-4000-8000-000000000002';
select ledger_assert((select count(*)=0 from garage_ledger.rows),'Mechanic direct reads contain no ledger rows');
select ledger_error('select public.garage_ledger_imports()','Mechanic cannot list financial imports','42501');
select ledger_error($q$select public.garage_ledger_sheet('66000000-0000-4000-8000-000000000020')$q$,'Mechanic cannot load a known sheet ID','42501');
select ledger_error($q$select garage_ledger.save_row('66000000-0000-4000-8000-000000000020',null,0,'{}','ledger',false,'',gen_random_uuid())$q$,'Private mutation also checks Owner role','42501');
select ledger_error($q$select public.garage_ledger_history('66000000-0000-4000-8000-000000000030')$q$,'Mechanic cannot read row history','42501');
select ledger_error($q$select public.garage_ledger_context('66000000-0000-4000-8000-000000000010')$q$,'Mechanic cannot read calculation context','42501');
select ledger_error($q$select public.garage_ledger_restore('66000000-0000-4000-8000-000000000030','source',1,'Forbidden',gen_random_uuid())$q$,'Mechanic cannot restore source','42501');

set request.jwt.claim.sub='66000000-0000-4000-8000-000000000001';
select ledger_assert(jsonb_array_length(garage_ledger_imports())=1,'Only complete imports are listed');
select ledger_assert(not (garage_ledger_imports()->0->'sheets'->0->'metadata' ? 'layout'),'Import listing omits bulky source layout');
select ledger_assert(jsonb_array_length(garage_ledger_sheet('66000000-0000-4000-8000-000000000020')->'rows')=1,'Owner sees the source row');
select ledger_assert(garage_ledger_sheet('66000000-0000-4000-8000-000000000020')->'sheet'->'metadata' ? 'layout','Selected sheet retains its full source metadata');
select ledger_error($q$select garage_ledger_sheet('66000000-0000-4000-8000-000000000021')$q$,'Staging sheet is unavailable','42501');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000021',null,0,'{"B":{"value":1,"type":"number"}}','ledger',false,'',gen_random_uuid())$q$,'Staging imports cannot be edited','42501');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020','66000000-0000-4000-8000-000000000030',1,
 (select cells from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'ledger',false,'No change',gen_random_uuid())$q$,'Unchanged formulas do not create spurious revisions');

create temporary table ledger_test_receipts(label text primary key,value jsonb);
insert into ledger_test_receipts values ('first',garage_ledger_save_row('66000000-0000-4000-8000-000000000020',
 '66000000-0000-4000-8000-000000000030',1,
 (select jsonb_set(cells,'{B,value}','30') from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),
 'ledger',false,'Corrected synthetic price','66000000-0000-4000-8000-000000000040'));
select ledger_assert((select value->'row'->>'version'='2' and value->>'revision'='2' from ledger_test_receipts where label='first'),'Edit increments row and workbook versions');
select ledger_assert((select cells->'B'->>'value'='30' and original_cells->'B'->>'value'='20' from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'Working edits preserve original source');
select ledger_assert((select value=garage_ledger_save_row('66000000-0000-4000-8000-000000000020',
 '66000000-0000-4000-8000-000000000030',1,
 (select jsonb_set(original_cells,'{B,value}','30') from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),
 'ledger',false,'Corrected synthetic price','66000000-0000-4000-8000-000000000040') from ledger_test_receipts where label='first'),'Identical retry returns original receipt');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020','66000000-0000-4000-8000-000000000030',2,
 (select cells from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'ledger',true,'Different payload','66000000-0000-4000-8000-000000000040')$q$,'Changed retry payload is rejected','22023');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020','66000000-0000-4000-8000-000000000030',1,
 (select cells from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'ledger',true,'Stale edit',gen_random_uuid())$q$,'Stale concurrent edit cannot overwrite newer data','40001');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020','66000000-0000-4000-8000-000000000030',2,
 (select cells-'U' from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'ledger',false,'Removed formula',gen_random_uuid())$q$,'A source formula cannot be deleted');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020','66000000-0000-4000-8000-000000000030',2,
 (select jsonb_set(cells,'{U,formula}','"=B2*3"') from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'ledger',false,'Changed formula',gen_random_uuid())$q$,'A source formula cannot be rewritten');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020','66000000-0000-4000-8000-000000000030',2,
 (select jsonb_set(jsonb_set(cells,'{U,override}','true'),'{U,value}','75') from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'ledger',false,'',gen_random_uuid())$q$,'Manual derived override requires a reason');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020',null,0,'{"B":{"value":"not a number","type":"number"}}','ledger',false,'',gen_random_uuid())$q$,'Numeric fields reject text');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020',null,0,'{"B":{"value":1e1000,"type":"number"}}','ledger',false,'',gen_random_uuid())$q$,'Out-of-range numbers cannot overflow browser calculations');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020',null,0,'{"A":{"value":"2026-02-30","type":"date"}}','ledger',false,'',gen_random_uuid())$q$,'Invalid calendar dates are rejected');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020',null,0,'{"B":{"value":2,"type":"number"}}','not-a-section',false,'',gen_random_uuid())$q$,'Rows cannot move into unknown sections');

insert into ledger_test_receipts values ('override',garage_ledger_save_row('66000000-0000-4000-8000-000000000020',
 '66000000-0000-4000-8000-000000000030',2,
 (select jsonb_set(jsonb_set(cells,'{U,override}','true'),'{U,value}','75') from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),
 'ledger',false,'Approved exceptional residual',gen_random_uuid()));
select ledger_assert((select cells->'U'->>'value'='75' and cells->'U'->>'formula'='=B2*2' and cells->'U'->>'cached'='40' from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'Manual override retains source formula and result');
select garage_ledger_save_row('66000000-0000-4000-8000-000000000020','66000000-0000-4000-8000-000000000030',3,
 (select cells from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'ledger',true,'Duplicate synthetic row',gen_random_uuid());
select ledger_assert((select archived and version=4 from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'Archive preserves the row and increases version');
select garage_ledger_restore('66000000-0000-4000-8000-000000000030','source',4,'Undo synthetic corrections','66000000-0000-4000-8000-000000000041');
select ledger_assert((select not archived and version=5 and cells=original_cells from garage_ledger.rows where id='66000000-0000-4000-8000-000000000030'),'Restore source creates a new active revision');
select ledger_assert(jsonb_array_length(garage_ledger_history('66000000-0000-4000-8000-000000000030'))=5,'History retains import and every successful edit');
select ledger_assert((garage_ledger_context('66000000-0000-4000-8000-000000000010')->>'revision')::integer=5,'Calculation context returns current workbook revision');
select ledger_assert(not (garage_ledger_context('66000000-0000-4000-8000-000000000010')->'sheets'->0->'rows'->0->'cells'->'B' ? 'cached'),'Calculation context omits redundant source caches');
select ledger_error($q$select garage_ledger_restore('66000000-0000-4000-8000-000000000030','source',4,'Stale restore',gen_random_uuid())$q$,'Stale restore is rejected','40001');
select ledger_error($q$select garage_ledger_restore('66000000-0000-4000-8000-000000000030','source',5,'',gen_random_uuid())$q$,'Restore requires a reason');

insert into ledger_test_receipts values ('new',garage_ledger_save_row('66000000-0000-4000-8000-000000000020',null,0,
 '{"B":{"value":12,"type":"number","formula":null,"cached":null,"format":"0.00"}}','ledger',false,'New synthetic entry',gen_random_uuid()));
select ledger_assert((select value->'row'->'source_row'='null'::jsonb and value->'row'->>'version'='1' from ledger_test_receipts where label='new'),'New rows have stable IDs without invented spreadsheet row numbers');
select ledger_assert((select jsonb_array_length(garage_ledger_history((value->'row'->>'id')::uuid))=1 from ledger_test_receipts where label='new'),'New-row history starts with its audited creation');

reset role;
update public.profiles set active=false where id='66000000-0000-4000-8000-000000000001';
set role authenticated;
set request.jwt.claim.sub='66000000-0000-4000-8000-000000000001';
select ledger_error('select garage_ledger_imports()','Deactivated Owner loses reads immediately','42501');
select ledger_error($q$select garage_ledger_save_row('66000000-0000-4000-8000-000000000020',null,0,'{}','ledger',false,'',gen_random_uuid())$q$,'Deactivated Owner loses writes immediately','42501');
reset role;
select ledger_assert((select count(*)=5 from garage_ledger.revisions),'Failed requests create no audit events');
select ledger_assert((select revision=1 from garage_ledger.imports where id='66000000-0000-4000-8000-000000000011'),'Changes never affect a different import version');
