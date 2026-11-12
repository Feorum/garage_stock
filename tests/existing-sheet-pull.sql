\set ON_ERROR_STOP on
-- Synthetic PostgreSQL-only checks. Vault/net below are isolated API stubs,
-- not a replacement for Supabase Vault encryption or pg_net in production.
\i /tmp/manager-test.sql
reset role;
set request.jwt.claim.sub='';
create schema vault;
create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text not null,name text unique,description text);
create view vault.decrypted_secrets as select id,secret as decrypted_secret,name from vault.secrets;
create function vault.create_secret(new_secret text,new_name text default null,new_description text default '') returns uuid
language plpgsql as $$declare result uuid;begin
  insert into vault.secrets(secret,name,description) values(new_secret,new_name,new_description) returning id into result;return result;
end$$;
create function vault.update_secret(secret_id uuid,new_secret text default null,new_name text default null,new_description text default null) returns void
language sql as $$update vault.secrets set secret=coalesce(new_secret,secret),name=coalesce(new_name,name),description=coalesce(new_description,description) where id=secret_id$$;
revoke all on schema vault from public,anon,authenticated,service_role;
create schema net;
create table net.test_requests(id bigint generated always as identity primary key,url text,headers jsonb,body jsonb,timeout_milliseconds integer);
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint
language plpgsql as $$declare result bigint;begin
  insert into net.test_requests(url,headers,body,timeout_milliseconds)
    values(url,headers,body,timeout_milliseconds) returning id into result;return result;
end$$;
revoke all on schema net from public,anon,authenticated,service_role;
\i /tmp/garage-pull.sql

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_connect_sheet_pull('Existing Manager source','synthetic-existing-manager-sheet','123456789') as connection \gset
select test_assert(:'connection'::jsonb->>'mode'='pull','Existing-sheet connection uses automatic pull mode');
select test_assert(:'connection'::jsonb->>'reader_only'='true','A new connection requires an authenticated private reader by default');
select test_assert(:'connection'::jsonb->>'last_success_at' is null,'New feed does not claim successful synchronization');
select test_assert(not(:'connection'::jsonb ?| array['credential','secret','secret_hash','state','credential_secret_id']),'Connect response excludes private credential and state');
select :'connection'::jsonb->>'id' as pull_id \gset
select test_assert(garage_connect_sheet_pull('Existing Manager source','synthetic-existing-manager-sheet','123456789')=:'connection'::jsonb,'Connection retry returns one stable feed');
select test_assert(jsonb_array_length(garage_sheet_pull_sources())=1,'Owner sees its automatic feed');
select test_assert(garage_sheet_pull_reviews(:'pull_id'::uuid)='[]'::jsonb,'New feed has no fabricated review records');
select test_error($q$select garage_connect_sheet_pull('Changed tab','synthetic-existing-manager-sheet','987654321')$q$,'Existing feed tab cannot be silently rebound','40001');
select test_error($q$select garage_connect_sheet_pull('Wrong mode','synthetic-sheet-source-a','123456789')$q$,'A legacy worker connection cannot be silently converted','40001');
select test_error($q$select * from garage_sheet_pull_feeds$q$,'Owner browser cannot select private importer state','42501');
select test_error($q$select * from vault.decrypted_secrets$q$,'Owner browser cannot read Vault credentials','42501');
select test_error($q$select garage_acquire_sheet_pulls()$q$,'Owner browser cannot acquire worker credentials','42501');
select test_error($q$select garage_checkpoint_sheet_pull(null,null,1,'{}')$q$,'Owner browser cannot mutate worker state','42501');
select test_error($q$select garage_commit_sheet_pull(null,null,1,'{}','{}','[]')$q$,'Owner browser cannot impersonate successful synchronization','42501');
select test_error($q$select garage_configure_sheet_pull_scheduler('https://example.invalid',repeat('z',40))$q$,'Owner browser cannot configure the privileged scheduler','42501');
select test_error($q$select garage_run_sheet_pull()$q$,'Owner browser cannot invoke the privileged scheduler','42501');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select test_assert(garage_sheet_pull_sources()='[]'::jsonb,'Another Owner cannot list first Owner feeds');
select test_error(format('select garage_sheet_pull_reviews(%L)',:'pull_id'),'Another Owner cannot read private review records','42501');
select test_error($q$select garage_connect_sheet_pull('Attempted takeover','synthetic-existing-manager-sheet','123456789')$q$,'Another Owner cannot take over an existing feed','42501');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select test_error($q$select garage_sheet_pull_sources()$q$,'Mechanic cannot list feed metadata','42501');
select test_error(format('select garage_sheet_pull_reviews(%L)',:'pull_id'),'Mechanic cannot read private review records','42501');
select test_error($q$select garage_connect_sheet_pull('Bad','synthetic-other-manager-sheet','1234')$q$,'Mechanic cannot connect a source','42501');
reset role;
select test_assert((select count(*)=1 from garage_sheet_pull_feeds),'Retry/takeover attempts created no extra feed');
select test_assert((select count(*)=1 from vault.secrets),'Source credential exists only once in private Vault');
set role service_role;
select test_assert(garage_acquire_sheet_pulls()='[]'::jsonb,'Scheduled anonymous pull excludes private-reader connections');
reset role;
-- This fixture alone explicitly enables the optional direct-read mode.
update garage_sheet_pull_feeds set reader_only=false where source_id=:'pull_id';

set role service_role;
set request.jwt.claim.sub='';
select garage_acquire_sheet_pulls() as acquired \gset
select test_assert(jsonb_array_length(:'acquired'::jsonb)=1,'Worker acquires an active source');
select :'acquired'::jsonb->0->>'lease_token' as lease_token \gset
select :'acquired'::jsonb->0->>'credential' as credential \gset
select test_assert(:'acquired'::jsonb->0->>'spreadsheet_id'='synthetic-existing-manager-sheet','Lease binds the exact existing source');
select test_assert(:'acquired'::jsonb->0->>'sheet_gid'='123456789','Lease binds the exact source tab');
select test_assert(:'acquired'::jsonb->0->'state'='{}'::jsonb,'New feed state starts empty');
select test_assert(garage_acquire_sheet_pulls()='[]'::jsonb,'An unexpired lease excludes concurrent workers');
select test_error(format('select garage_checkpoint_sheet_pull(%L,%L,1,%L)',:'pull_id',:'lease_token','[]'),'Nonobject durable state is rejected');
select test_error(format('select garage_checkpoint_sheet_pull(%L,%L,99,%L)',:'pull_id',:'lease_token','{}'),'Stale state version cannot checkpoint','40001');
select test_error(format('select garage_checkpoint_sheet_pull(%L,%L,1,%L)',:'pull_id','00000000-0000-4000-8000-999999999999','{}'),'Wrong lease cannot checkpoint','40001');
select jsonb_set(test_payload('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001'),
  '{spreadsheet_id}','"synthetic-existing-manager-sheet"') as durable_payload \gset
select garage_checkpoint_sheet_pull(:'pull_id',:'lease_token',1,jsonb_build_object('outbox',jsonb_build_array(:'durable_payload'::jsonb))) as checkpoint \gset
select test_assert(:'checkpoint'::jsonb->>'version'='2','Checkpoint increments durable state version before delivery');
select garage_ingest_sheet(:'pull_id',:'credential',:'durable_payload'::jsonb) as accepted \gset
select test_assert(:'accepted'::jsonb->>'status'='accepted','Pull worker uses validated existing Manager ingestion');
reset role;
select test_assert((select state#>>'{outbox,0,submission_id}'='71000000-0000-4000-8000-000000000001' from garage_sheet_pull_feeds where source_id=:'pull_id'),'Outbox identity survives delivery before final acknowledgement');
select test_assert((select last_success_at is null from garage_sheet_pull_feeds where source_id=:'pull_id'),'Order delivery alone does not fabricate a completed sheet scan');
update garage_sheet_pull_feeds set lease_expires_at=clock_timestamp()-interval '1 second' where source_id=:'pull_id';
set role service_role;
select garage_acquire_sheet_pulls() as reacquired \gset
select :'reacquired'::jsonb->0->>'lease_token' as new_lease \gset
select test_assert(:'new_lease'<>:'lease_token','Expired crashed-worker lease receives a new token');
select test_assert(:'reacquired'::jsonb->0->'state'->'outbox'->0=:'durable_payload'::jsonb,'Crash recovery loads the exact immutable pending payload');
select test_error(format('select garage_checkpoint_sheet_pull(%L,%L,2,%L)',:'pull_id',:'lease_token','{}'),'Expired worker cannot overwrite recovered state','40001');
select test_assert(garage_ingest_sheet(:'pull_id',:'credential',:'reacquired'::jsonb->0->'state'->'outbox'->0)=:'accepted'::jsonb,'Lost response retries receive the original receipt');
select test_error(format('select garage_commit_sheet_pull(%L,%L,2,%L,%L,%L,null)',:'pull_id',:'new_lease','{}','{}','[{"row_number":2,"reason_codes":["CHECK"],"price":999}]'),'Private review schema rejects arbitrary financial fields');
select garage_commit_sheet_pull(:'pull_id',:'new_lease',2,'{"outbox":[]}',
  '{"total_rows":3,"completed":1,"accepted":1,"review":1}',
  '[{"row_number":3,"reason_codes":["UNKNOWN_MODEL"],"vehicle":"Synthetic model","planned_date":"2026-11-20","source_key":null}]') as committed \gset
select test_assert(:'committed'::jsonb->>'version'='3','Commit advances state and releases lease');
select test_error(format('select garage_commit_sheet_pull(%L,%L,2,%L,%L,%L,null)',:'pull_id',:'new_lease','{}','{}','[]'),'Stale commit cannot overwrite final state','40001');
reset role;
select test_assert((select count(*)=1 from garage_sheet_orders where source_id=:'pull_id'),'Crashed-worker replay creates only one order');
select test_assert((select count(*)=1 from garage_sheet_submissions where source_id=:'pull_id'),'Crashed-worker replay creates only one receipt');
select test_assert((select lease_token is null and lease_expires_at is null and last_success_at is not null from garage_sheet_pull_feeds where source_id=:'pull_id'),'Successful scan reports health and releases its lease');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select test_assert(garage_sheet_pull_sources()->0->>'review_count'='1','Owner sees a truthful review count');
select test_assert(garage_sheet_pull_sources()->0->'summary'->>'accepted'='1','Owner sees safe scan counters');
select test_assert(garage_sheet_pull_reviews(:'pull_id')->0->>'row_number'='3','Owner can locate the source row needing review');
select test_assert(not(garage_sheet_pull_sources()->0 ?| array['credential','state','credential_secret_id','lease_token']),'Owner source list never leaks worker state or credentials');
select garage_set_sheet_active(:'pull_id',false,1);
reset role;
set role service_role;
set request.jwt.claim.sub='';
select test_assert(garage_acquire_sheet_pulls()='[]'::jsonb,'Paused feed is not acquired');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_set_sheet_active(:'pull_id',true,2);
reset role;
update profiles set active=false where id='00000000-0000-4000-8000-000000000001';
set role service_role;
set request.jwt.claim.sub='';
select test_assert(garage_acquire_sheet_pulls()='[]'::jsonb,'Deactivated Owner cannot run imports');
reset role;
update profiles set active=true where id='00000000-0000-4000-8000-000000000001';
set role service_role;
select garage_acquire_sheet_pulls() as error_lease \gset
select test_assert(:'error_lease'::jsonb->0->'summary'->>'accepted'='1'
  and :'error_lease'::jsonb->0->'review'->0->'source_key'='null'::jsonb,
  'Lease carries previous safe scan/review fields, including an unknown row identity');
select garage_commit_sheet_pull(:'pull_id',(:'error_lease'::jsonb->0->>'lease_token')::uuid,3,
  '{"outbox":[]}','{"review":1}','[]','SOURCE_UNAVAILABLE');
reset role;
select test_assert((select last_success_at is not null and last_error_code='SOURCE_UNAVAILABLE' from garage_sheet_pull_feeds where source_id=:'pull_id'),'Failed scan preserves the previous successful timestamp');

set role service_role;
select test_error($q$select garage_configure_sheet_pull_scheduler('https://example.invalid/functions/v1/pull-manager-sheets',repeat('n',40))$q$,'Scheduler cannot send its credential to another host');
select test_error($q$select garage_configure_sheet_pull_scheduler('https://cjcevfdhzaemxqhhxtrt.supabase.co/functions/v1/manager-orders',repeat('n',40))$q$,'Scheduler cannot target another function');
select garage_configure_sheet_pull_scheduler('https://cjcevfdhzaemxqhhxtrt.supabase.co/functions/v1/pull-manager-sheets',repeat('n',40));
select test_assert(garage_run_sheet_pull()=1,'Scheduler queues a server-side HTTP request');
select garage_configure_sheet_pull_scheduler('https://cjcevfdhzaemxqhhxtrt.supabase.co/functions/v1/pull-manager-sheets',repeat('m',40));
select test_assert(garage_run_sheet_pull()=2,'Scheduler credential can be rotated');
reset role;
select test_assert((select headers->>'Authorization'='Bearer '||repeat('m',40) and body='{}'::jsonb and timeout_milliseconds=120000 from net.test_requests where id=2),'Scheduler reads the current Vault credential just before the request');
select test_assert((select count(*)=1 from vault.secrets where name='garage-sheet-pull-scheduler'),'Scheduler rotation updates one Vault secret');
select test_assert((select secret=repeat('m',40) from vault.secrets where name='garage-sheet-pull-scheduler'),'Old scheduler credential is replaced');

-- A private native copy is read through the Owner-authorized worker only.
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_set_sheet_active(:'pull_id',false,3);
select garage_connect_sheet_pull('Private native copy','synthetic-private-manager-copy','234567890') as private_connection \gset
select :'private_connection'::jsonb->>'id' as private_id \gset
select garage_prepare_sheet_reader(:'private_id',repeat('r',40),1) as prepared \gset
select test_assert(:'prepared'::jsonb->>'reader_only'='true' and :'prepared'::jsonb->>'version'='2','Owner prepares a private reader without publishing the copy');
select test_assert(not(:'prepared'::jsonb ?| array['credential','secret','secret_hash','state','credential_secret_id']),'Private-reader setup returns no plaintext credential');
select test_error(format('select garage_acquire_sheet_reader(%L,%L,%L,%L)',:'private_id',repeat('r',40),'synthetic-private-manager-copy','234567890'),'Owner browser cannot use the privileged reader RPC even with a scoped secret','42501');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select test_error(format('select garage_prepare_sheet_reader(%L,%L,2)',:'private_id',repeat('s',40)),'Another Owner cannot prepare this private reader','42501');
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select test_error(format('select garage_prepare_sheet_reader(%L,%L,2)',:'private_id',repeat('s',40)),'Mechanic cannot prepare a private reader','42501');
reset role;
select test_assert((select secret_hash=garage_sheet_hash(repeat('r',40)) from garage_sheet_sources where id=:'private_id')
  and (select decrypted_secret=repeat('r',40) from vault.decrypted_secrets where id=(select credential_secret_id from garage_sheet_pull_feeds where source_id=:'private_id')),
  'Reader credential rotates source hash and Vault atomically');
set role service_role;
set request.jwt.claim.sub='';
select test_assert(garage_acquire_sheet_pulls()='[]'::jsonb,'Private copy never enters scheduled anonymous downloads');
select test_error(format('select garage_acquire_sheet_reader(%L,%L,%L,%L)',:'private_id',repeat('x',40),'synthetic-private-manager-copy','234567890'),'Private reader rejects an incorrect credential','42501');
select test_error(format('select garage_acquire_sheet_reader(%L,%L,%L,%L)',:'private_id',repeat('r',40),'synthetic-other-private-copy','234567890'),'Private reader rejects a different workbook','42501');
select test_error(format('select garage_acquire_sheet_reader(%L,%L,%L,%L)',:'private_id',repeat('r',40),'synthetic-private-manager-copy','999999999'),'Private reader rejects a different tab in the same workbook','42501');
select garage_acquire_sheet_reader(:'private_id',repeat('r',40),'synthetic-private-manager-copy','234567890') as reader_lease \gset
select test_assert(:'reader_lease'::jsonb->>'source_id'=:'private_id','Valid private reader acquires only its own feed');
select test_assert(garage_acquire_sheet_reader(:'private_id',repeat('r',40),'synthetic-private-manager-copy','234567890') is null,'Concurrent private reader returns busy without another lease');
select :'reader_lease'::jsonb->>'lease_token' as old_reader_token \gset
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_prepare_sheet_reader(:'private_id',repeat('s',40),2);
reset role;
set role service_role;
set request.jwt.claim.sub='';
select test_error(format('select garage_checkpoint_sheet_pull(%L,%L,1,%L)',:'private_id',:'old_reader_token','{}'),'Reader rotation invalidates an old worker lease','40001');
select test_error(format('select garage_acquire_sheet_reader(%L,%L,%L,%L)',:'private_id',repeat('r',40),'synthetic-private-manager-copy','234567890'),'Rotated reader credential no longer authenticates','42501');
select garage_acquire_sheet_reader(:'private_id',repeat('s',40),'synthetic-private-manager-copy','234567890') as current_reader \gset
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_prepare_sheet_reader(:'private_id',repeat('s',40),2);
reset role;
select test_assert((select lease_token=(:'current_reader'::jsonb->>'lease_token')::uuid from garage_sheet_pull_feeds where source_id=:'private_id'),'Lost setup response replay preserves the new valid worker lease');
select test_assert((select version=3 from garage_sheet_sources where id=:'private_id'),'Reader setup retry does not rotate twice');
set role service_role;
select garage_commit_sheet_pull(:'private_id',(:'current_reader'::jsonb->>'lease_token')::uuid,1,'{}','{"completed":2}','[]');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_set_sheet_active(:'private_id',false,3);
reset role;
set role service_role;
set request.jwt.claim.sub='';
select test_error(format('select garage_acquire_sheet_reader(%L,%L,%L,%L)',:'private_id',repeat('s',40),'synthetic-private-manager-copy','234567890'),'Paused private copy rejects reader uploads','42501');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select garage_set_sheet_active(:'private_id',true,4);
reset role;
update profiles set active=false where id='00000000-0000-4000-8000-000000000001';
set role service_role;
set request.jwt.claim.sub='';
select test_error(format('select garage_acquire_sheet_reader(%L,%L,%L,%L)',:'private_id',repeat('s',40),'synthetic-private-manager-copy','234567890'),'Deactivated Owner blocks private-reader uploads','42501');
reset role;
update profiles set active=true where id='00000000-0000-4000-8000-000000000001';
set role anon;
set request.jwt.claim.sub='';
select test_error($q$select garage_sheet_pull_sources()$q$,'Anonymous caller cannot inspect automatic feeds','42501');
select test_error($q$select garage_acquire_sheet_pulls()$q$,'Anonymous caller cannot acquire feed credentials','42501');
select test_error($q$select garage_run_sheet_pull()$q$,'Anonymous caller cannot run the scheduler','42501');
select test_error(format('select garage_acquire_sheet_reader(%L,%L,%L,%L)',:'private_id',repeat('s',40),'synthetic-private-manager-copy','234567890'),'Anonymous caller cannot use a private-reader RPC','42501');
reset role;
select test_assert(exists(select 1 from garage_schema_migrations where version='202611130001'),'Pull migration is recorded');
