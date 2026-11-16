// Runs only an isolated in-memory PostgreSQL. No network or production credentials.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let phase='initialization';
process.on('uncaughtException',error=>{
  console.error(JSON.stringify({status:'failed',phase,code:error.code || 'CHECK_FAILED'}));
  process.exit(1);
});
const args=process.argv.slice(2);
function argument(name) {
  const index=args.indexOf(name);
  return index<0 ? undefined : args[index+1];
}
const modulePath=argument('--pglite-module') || process.env.GARAGE_PGLITE_MODULE;
if(!modulePath) throw new Error('Set GARAGE_PGLITE_MODULE or --pglite-module to a locally installed @electric-sql/pglite module.');
const {PGlite}=await import(pathToFileURL(path.resolve(modulePath)).href);
const db=new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
 create schema auth; create table auth.users(id uuid primary key,email text not null,raw_user_meta_data jsonb not null default '{}');
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema public,auth to anon,authenticated,service_role;
 grant execute on function auth.uid() to anon,authenticated,service_role;`);
await db.exec(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
await db.exec(`grant select,insert,update,delete on all tables in schema public to anon,authenticated;
 grant usage,select on all sequences in schema public to anon,authenticated;
 alter default privileges in schema public grant select,insert,update,delete on tables to anon,authenticated;
 alter default privileges in schema public grant usage,select on sequences to anon,authenticated;`);
const migrations=['202611120001_orders.sql',...fs.readdirSync(path.join(root,'supabase/migrations')).filter(n=>n.includes('business_ledger')).sort()];
for(const file of migrations) {phase=file;await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'));}
phase='synthetic permission and mutation checks';
await db.exec(fs.readFileSync(path.join(root,'tests/business-ledger.sql'),'utf8'));
const result={status:'passed',assertions:(await db.query('select count(*)::int as n from public.ledger_test_checks')).rows[0].n};

const privateDirectory=argument('--payload-sql-dir');
if(privateDirectory) {
  const directory=path.resolve(privateDirectory);
  if(directory===root || directory.startsWith(root+path.sep)) throw new Error('Private import batches belong outside the checkout.');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.private.json'),'utf8'));
  const files=manifest.chunks.map(name=>{
    if(!/^\d{4}-[a-z]+\.sql$/.test(name)) throw new Error('Invalid private SQL batch name.');
    return path.join(directory,name);
  });
  // Load all source batches, then verify that an unfinished import stays hidden.
  for(const file of files.slice(0,-1)) {phase=path.basename(file);await db.exec(fs.readFileSync(file,'utf8'));}
  await db.exec(`update public.profiles set active=true where id='66000000-0000-4000-8000-000000000001';
    set role authenticated;set request.jwt.claim.sub='66000000-0000-4000-8000-000000000001';`);
  const before=(await db.query('select jsonb_array_length(public.garage_ledger_imports()) as n')).rows[0].n;
  if(before!==1) throw new Error('A partially imported workbook became visible.');
  await db.exec('reset role;');
  phase='private import activation';
  await db.exec(fs.readFileSync(files.at(-1),'utf8'));
  const counts=(await db.query(`select count(*)::int as rows,
    sum((select count(*) from jsonb_object_keys(r.original_cells)))::int as cells,
    bool_and(r.original_cells=r.cells) as originals_untouched
    from garage_ledger.rows r join garage_ledger.sheets s on s.id=r.sheet_id where s.import_id=$1`,[manifest.import_id])).rows[0];
  if(counts.rows!==manifest.row_count || counts.cells!==manifest.cell_count || !counts.originals_untouched)
    throw new Error('Imported source values differ from the verified source batch.');
  // Replaying the exact file neither duplicates rows nor resets edited data.
  for(const file of files) {phase=`retry ${path.basename(file)}`;await db.exec(fs.readFileSync(file,'utf8'));}
  phase='private Owner and Mechanic access checks';
  const replay=(await db.query(`select count(*)::int as n from garage_ledger.rows r
    join garage_ledger.sheets s on s.id=r.sheet_id where s.import_id=$1`,[manifest.import_id])).rows[0].n;
  if(replay!==counts.rows) throw new Error('An exact retry duplicated imported records.');
  await db.exec("set role authenticated;set request.jwt.claim.sub='66000000-0000-4000-8000-000000000001';");
  const context=(await db.query('select public.garage_ledger_context($1) as value',[manifest.import_id])).rows[0].value;
  if(context.sheets.length!==manifest.sheets.length || context.revision!==1) throw new Error('Owner calculation context is incomplete.');
  await db.exec("set request.jwt.claim.sub='66000000-0000-4000-8000-000000000002';");
  let denied=false;
  try { await db.query('select public.garage_ledger_context($1)',[manifest.import_id]); }
  catch(error) { if(error.code!=='42501') throw error;denied=true; }
  if(!denied) throw new Error('A Mechanic could access imported financial values.');
  result.private_import={sheets:manifest.sheets.length,rows:counts.rows,cells:counts.cells,exact_retry:true,owner_context:true,mechanic_denied:true};
}
console.log(JSON.stringify(result));
await db.close();
