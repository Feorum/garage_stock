-- Synthetic, rollback-only commercial and remuneration checks for the isolated team-workflow database.
begin;
create function pg_temp.price_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'PRICE CHECK: %',label; end if; end $$;
create function pg_temp.price_denied(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then if sqlstate=expected then return; end if; raise; end;
  raise exception 'Statement unexpectedly succeeded';
end $$;

insert into public.garage_price_lists(id,name,source_sha256,status,effective_date)
  values('62800000-0000-4000-8000-000000000001','Synthetic test rate',repeat('c',64),'active',current_date);
insert into public.garage_price_matrix(price_list_id,vehicle_group_code,work_code,net_amount)
  values('62800000-0000-4000-8000-000000000001','VG02','W01',1200.05),
        ('62800000-0000-4000-8000-000000000001','VG02','W09',0),
        ('62800000-0000-4000-8000-000000000001','VG02','W10',11.75);
insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by)
  values('62800000-0000-4000-8000-000000000002','Synthetic vehicle','VG02','manager','00000000-0000-4000-8000-000000000001');
insert into public.garage_order_tasks(id,order_id,work_code,work_name,status)
  values('62900000-0000-4000-8000-000000000001','62800000-0000-4000-8000-000000000002','W01','Synthetic service','pending'),
    ('62900000-0000-4000-8000-000000000002','62800000-0000-4000-8000-000000000002','W02','Unpriced service','pending');
select public.garage_snapshot_task(id,'VG02') from public.garage_order_tasks where order_id='62800000-0000-4000-8000-000000000002';

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare ord uuid:='62800000-0000-4000-8000-000000000002'; t uuid:='62900000-0000-4000-8000-000000000001';
  unpriced uuid:='62900000-0000-4000-8000-000000000002'; receipt uuid:=gen_random_uuid(); q jsonb; f jsonb; row jsonb;
begin
  q:=public.garage_quote_order('VG02','[{"work_code":"W01","id":""}]');
  perform pg_temp.price_assert(q->>'effective_total_kopeks'='120005' and q->'items'->0->>'catalogue_kopeks'='120005'
    and q->>'effective_tax_kopeks'='24001' and q->>'effective_gross_kopeks'='144006'
    and (q->>'gross_amount')::numeric=1440.06,'immediate net catalogue vs gross quote');
  perform pg_temp.price_assert((public.garage_quote_order('VG02','[{"work_code":"W02"}]')->'effective_total_kopeks')='null',
    'unknown draft amount stays unknown');
  perform pg_temp.price_assert(public.garage_save_task_pricing(t,0,0,'Private test memo',receipt)=1,'save before completion');
  perform pg_temp.price_assert(public.garage_save_task_pricing(t,0,0,'Private test memo',receipt)=1,'private save exact retry');
  perform pg_temp.price_denied(format('select public.garage_save_task_pricing(%L,0,50,%L,%L)',t,'private',receipt),'22023');
  perform pg_temp.price_denied(format('select public.garage_save_task_pricing(%L,0,null,%L,gen_random_uuid())',t,'private'),'40001');
  f:=public.garage_order_financials(ord);
  select x into row from jsonb_array_elements(f->'tasks') x where x->>'task_id'=t::text;
  perform pg_temp.price_assert(row->>'private_comment'='Private test memo' and row->>'effective_kopeks'='0'
    and row->>'effective_tax_kopeks'='0' and row->>'effective_gross_kopeks'='0'
    and row->>'catalogue_kopeks'='120005' and row->'payout'='null'
    and f->'effective_total_kopeks'='null','explicit zero and one missing amount');
  select x into strict row from jsonb_array_elements(public.garage_owner_review_prices(array[ord])->0->'tasks') x
    where x->>'task_id'=unpriced::text;
  perform pg_temp.price_assert(row->'effective_kopeks'='null','review preserves unknown price');
  q:=public.garage_quote_order('VG02',jsonb_build_array(jsonb_build_object('work_code','W01','id',t)),ord);
  perform pg_temp.price_assert(q->>'effective_total_kopeks'='0' and q->'items'->0->>'private_comment'='Private test memo','retained quote keeps private override');
  q:=public.garage_quote_order('VG02',jsonb_build_array(jsonb_build_object('work_code','W02','id',t)),ord);
  perform pg_temp.price_assert(q->'effective_total_kopeks'='null' and q->'items'->0->>'private_comment'='','replacement work never inherits private override');
  perform public.garage_save_task_pricing(unpriced,0,1000,'',gen_random_uuid());
  f:=public.garage_order_financials(ord);
  perform pg_temp.price_assert(f->>'effective_total_kopeks'='1000' and f->'effective_tax_kopeks'='null'
    and f->'effective_gross_kopeks'='null','effective net known, VAT unknown for unpriced manual amount');
  perform public.garage_save_task_pricing(t,1,null,'Independent memo',gen_random_uuid());
  perform pg_temp.price_assert(public.garage_order_financials(ord)->>'effective_total_kopeks'='121005','clearing override restores source rate');
  select x into strict row from jsonb_array_elements(public.garage_owner_review_prices(array[ord])->0->'tasks') x
    where x->>'task_id'=t::text;
  perform pg_temp.price_assert(row->>'effective_kopeks'='120005','review restores the recorded rate when an override is cleared');
  perform pg_temp.price_assert(public.garage_list_orders()::text not like '%Independent memo%','private comment absent from operational payload');
end $$;
reset role;
update public.garage_order_tasks set status='completed',working_mechanic_id='00000000-0000-4000-8000-000000000002',completed_at=now()
  where order_id='62800000-0000-4000-8000-000000000002';
insert into public.garage_task_participants(task_id,mechanic_id,status,started_at,confirmed_at,confirmation_origin)
  select '62900000-0000-4000-8000-000000000001',id,'confirmed',now(),now(),'mechanic' from public.profiles
    where id in ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004');
insert into public.garage_task_completions(task_id,order_id,work_code,work_name,mechanic_id,completed_at)
  select id,order_id,work_code,work_name,working_mechanic_id,completed_at from public.garage_order_tasks
  where order_id='62800000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare t uuid:='62900000-0000-4000-8000-000000000001'; unpriced uuid:='62900000-0000-4000-8000-000000000002';
  ord uuid:='62800000-0000-4000-8000-000000000002'; receipt uuid:=gen_random_uuid(); p jsonb; s jsonb; manual jsonb;
begin
  select x into p from jsonb_array_elements(public.garage_pay_worklist()) x where x->>'task_id'=unpriced::text;
  perform pg_temp.price_assert(p->'suggested_pool_kopeks'='null' and p->>'effective_kopeks'='1000' and p->'pool_kopeks'='null'
    and p->'suggested_shares'->0->'kopeks'='null' and p->'suggested_shares'->0->>'basis_points'='10000','manual customer price cannot invent mechanic pay');
  select x into p from jsonb_array_elements(public.garage_pay_worklist()) x where x->>'task_id'=t::text;
  perform pg_temp.price_assert(p->>'suggested_pool_kopeks'='120005' and p->'pool_kopeks'='null'
    and p->'suggested_shares'->0->>'kopeks'='40002' and p->'suggested_shares'->2->>'kopeks'='40001','fair kopeks differ by at most one');
  select jsonb_agg(x-'name'-'former'-'kopeks' order by x->>'mechanic_id') into s from jsonb_array_elements(p->'suggested_shares') x;
  manual:=jsonb_set(jsonb_set(s,'{0,basis_points}','5000'),'{1,basis_points}','1667');
  perform pg_temp.price_denied(format('select public.garage_pay_save(%L,0,120005,%L,%L,false,gen_random_uuid(),true)',t,manual,''),'22023');
  perform pg_temp.price_assert(public.garage_pay_save(t,0,120005,s,'',false,receipt,true)=1,'confirm calculated split');
  perform pg_temp.price_assert(public.garage_pay_save(t,0,120005,s,'',false,receipt,true)=1,'retry same equal split');
  perform pg_temp.price_denied(format('select public.garage_pay_save(%L,0,120005,%L,%L,false,%L)',t,s,'',receipt),'22023');
  perform public.garage_save_task_pricing(t,2,0,'Courtesy service',gen_random_uuid());
  select x->'payout' into p from jsonb_array_elements(public.garage_order_financials(ord)->'tasks') x where x->>'task_id'=t::text;
  perform pg_temp.price_assert(p->>'pool_kopeks'='120005' and p->>'suggested_pool_kopeks'='120005' and p->>'equal_split'='true'
    and p->'shares'->2->>'kopeks'='40001','customer override preserves suggested and confirmed mechanic pay');
  perform public.garage_pay_save(t,1,120005,manual,'Explicit ratio',false,gen_random_uuid(),false);
  perform pg_temp.price_assert(public.garage_pay_history(t)->0->>'equal_split'='false'
    and public.garage_pay_history(t)->1->>'equal_split'='true','saved explicit and equal revisions retained');
end $$;
reset role;
-- Exercise the catalogue projection independently of private overrides, three pay recipients,
-- and the price list active today.
insert into public.garage_order_tasks(id,order_id,work_code,work_name,status,working_mechanic_id,completed_at) values
  ('62900000-0000-4000-8000-000000000003','62800000-0000-4000-8000-000000000002','W09','Zero-rate service','completed',
   '00000000-0000-4000-8000-000000000002',now()),
  ('62900000-0000-4000-8000-000000000004','62800000-0000-4000-8000-000000000002','W13','Cancelled service','cancelled',null,null),
  ('62900000-0000-4000-8000-000000000005','62800000-0000-4000-8000-000000000002','W10','Legacy open service','pending',null,null);
select public.garage_snapshot_task('62900000-0000-4000-8000-000000000003','VG02');
select public.garage_snapshot_task('62900000-0000-4000-8000-000000000005','VG02');
update public.garage_orders set status='closed',closed_at='2026-11-01 00:00+03'
  where id='62800000-0000-4000-8000-000000000002';
update public.garage_price_lists set status='retired' where id='62800000-0000-4000-8000-000000000001';
insert into public.garage_price_lists(id,name,source_sha256,status) values
  ('62800000-0000-4000-8000-000000000003','Replacement catalogue',repeat('d',64),'active');
insert into public.garage_price_matrix(price_list_id,vehicle_group_code,work_code,net_amount)
  values('62800000-0000-4000-8000-000000000003','VG02','W01',8000);

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare visit jsonb; amounts jsonb;
begin
  perform pg_temp.price_assert(public.garage_owner_review_prices('{}'::uuid[])='[]'::jsonb,'only requested orders are returned');
  perform pg_temp.price_denied('select public.garage_owner_review_prices(array_fill(gen_random_uuid(),array[101]))','22023');
  select x into strict visit from jsonb_array_elements(public.garage_owner_review_prices(
    array['62800000-0000-4000-8000-000000000002','62800000-0000-4000-8000-000000000002']::uuid[])) x
    where x->>'order_id'='62800000-0000-4000-8000-000000000002';
  select jsonb_object_agg(t->>'task_id',t->'net_kopeks') into amounts from jsonb_array_elements(visit->'tasks') t;
  perform pg_temp.price_assert(amounts='{"62900000-0000-4000-8000-000000000001":120005,
    "62900000-0000-4000-8000-000000000002":null,"62900000-0000-4000-8000-000000000003":0,
    "62900000-0000-4000-8000-000000000005":1175}'::jsonb,
    'frozen catalogue alone supplies the net, including true zero and unknown');
  perform pg_temp.price_assert(jsonb_array_length(visit->'tasks')=4,'one row per service across a three-person team');
  select jsonb_object_agg(t->>'task_id',t->'effective_kopeks') into amounts from jsonb_array_elements(visit->'tasks') t;
  perform pg_temp.price_assert(amounts='{"62900000-0000-4000-8000-000000000001":0,
    "62900000-0000-4000-8000-000000000002":1000,"62900000-0000-4000-8000-000000000003":0,
    "62900000-0000-4000-8000-000000000005":1175}'::jsonb,
    'review returns the latest agreed price once per job, including gifts and manually priced work');
  perform pg_temp.price_assert((visit->>'closed_at')::timestamptz='2026-10-31 21:00Z'::timestamptz,'historical close instant');
  perform pg_temp.price_assert(visit::text !~ 'private_comment|pool_kopeks|override_kopeks|Courtesy service','minimal report projection');
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select pg_temp.price_denied($q$select public.garage_owner_review_prices(array['62800000-0000-4000-8000-000000000002']::uuid[])$q$,'42501');
select pg_temp.price_denied($q$select public.garage_save_task_pricing('62900000-0000-4000-8000-000000000001',0,100,'x',gen_random_uuid())$q$,'42501');
select pg_temp.price_denied($q$select public.garage_order_financials('62800000-0000-4000-8000-000000000002')$q$,'42501');
select pg_temp.price_denied($q$select public.garage_quote_order('VG02','[{"work_code":"W01"}]')$q$,'42501');
select pg_temp.price_denied($q$select garage_pay.price_fields('62900000-0000-4000-8000-000000000001',100)$q$,'42501');
select pg_temp.price_denied($q$select * from garage_pay.task_pricing_revisions$q$,'42501');
select pg_temp.price_assert(public.garage_list_orders()::text !~ 'private_comment|catalogue_kopeks|suggested_pool_kopeks|Courtesy service','mechanic operational output stays private');
reset role;
rollback;
