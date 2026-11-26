-- Synthetic rates and contract. Roll back the workshop preference and act serial after the checks.
begin;
create function pg_temp.check_commercial(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Commercial check: %',label; end if; end $$;
insert into public.garage_orders(id,vehicle,vehicle_group_code,vin,source,status,closed_at,created_by)
  select ('7e000000-0000-4000-9000-'||lpad(n::text,12,'0'))::uuid,'Commercial fixture','VG02','SYN-VIN',
    'manager','closed','2026-11-21','00000000-0000-4000-8000-000000000001'::uuid from generate_series(1,2) n;
insert into public.garage_order_tasks(id,order_id,work_code,work_name,status,working_mechanic_id,completed_at)
  select ('7e100000-0000-4000-9000-'||lpad(n::text,12,'0'))::uuid,'7e000000-0000-4000-9000-000000000001',
    'W0'||n,'Fixture '||n,'completed','00000000-0000-4000-8000-000000000002'::uuid,now() from generate_series(1,2) n;
insert into public.garage_price_lists(id,name,source_sha256) values('7ef00000-0000-4000-9000-000000000001','Private fixture',repeat('e',64));
insert into public.garage_task_financials(task_id,price_list_id,pricing_status,net_amount,vat_rate,vat_amount,gross_amount)
  select ('7e100000-0000-4000-9000-'||lpad(n::text,12,'0'))::uuid,'7ef00000-0000-4000-9000-000000000001','priced',
    price,0,0,price from (values(1,480),(2,320)) v(n,price);
insert into garage_act.config(customer_name,contractor_name,contract_number,contract_date,template_chunks)
  values('Customer','Contractor','Testing','2026-11-01',1) on conflict do nothing;
insert into garage_act.template_parts values(0,'YWJj') on conflict do nothing;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
do $$begin
  begin perform public.garage_save_commercial('7e000000-0000-4000-9000-000000000001',0,75000,'agreed'); raise 'Mechanic changed finances';
    exception when insufficient_privilege then null; end;
  begin perform public.garage_order_financials('7e000000-0000-4000-9000-000000000001'); raise 'Mechanic read finances';
    exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare ord uuid:='7e000000-0000-4000-9000-000000000001'; a text:='7e100000-0000-4000-9000-000000000001';
  b text:='7e100000-0000-4000-9000-000000000002'; f jsonb; quote jsonb; doc jsonb; again jsonb; mode text;
begin
  perform public.garage_save_commercial(ord,0,75000,'agreed');
  perform pg_temp.check_commercial(public.garage_save_commercial(ord,0,75000,'agreed')=1,'idempotent save');
  begin perform public.garage_save_commercial(ord,0,77000,'agreed'); raise 'stale update accepted'; exception when serialization_failure then null; end;
  f:=public.garage_order_financials(ord);
  perform pg_temp.check_commercial(f->'commercial'->>'catalogue_total_kopeks'='80000' and f->>'effective_total_kopeks'='75000'
    and f->'commercial'->>'internal_total_kopeks'='60000' and f->'tasks'->0->>'effective_kopeks'='45000','weighted pricing');
  perform pg_temp.check_commercial(public.garage_order_financials('7e000000-0000-4000-9000-000000000002')->'commercial'->>'basis'='catalogue','existing order retains its preference');
  quote:=jsonb_build_object('agreed_total_kopeks',75000,'listed',jsonb_build_object(a,48000,b,32000),
    'allocated',jsonb_build_object(a,45000,b,30000));
  begin perform public.garage_act_save(ord,'10001/11','C','2026-11-01','2026-11-21',0,1,quote->'allocated','VIN');
    raise 'legacy client issued wrong layout'; exception when serialization_failure then null; end;
  foreach mode in array array['weighted','discount','names'] loop
    doc:=public.garage_act_save(ord,'10001/11','C','2026-11-01','2026-11-21',coalesce((doc->>'version')::int,0),1,
      jsonb_build_object('mode',mode,'quote',quote),'VIN');
    perform pg_temp.check_commercial(doc->>'act_format'=mode and doc->'pricing_snapshot'=quote,'issued format and snapshot');
  end loop;
  perform public.garage_save_commercial(ord,1,74999,'agreed');
  f:=public.garage_order_financials(ord);
  perform pg_temp.check_commercial((select sum((x->>'effective_kopeks')::bigint)=74999 and sum((x->>'internal_price_kopeks')::bigint)=59999
    from jsonb_array_elements(f->'tasks') x),'kopeks survive both allocations');
  again:=public.garage_act_save(ord,'10001/11','C','2026-11-01','2026-11-21',0,1,jsonb_build_object('mode','names','quote',quote),'VIN');
  perform pg_temp.check_commercial(doc=again,'re-export keeps issued prices and number');
end $$;
reset role;
insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by)
  values('7e000000-0000-4000-9000-000000000003','Next manager order','VG02','manager','00000000-0000-4000-8000-000000000001');
select pg_temp.check_commercial((select basis='agreed' and agreed_total_kopeks is null from garage_pay.commercial_terms
  where order_id='7e000000-0000-4000-9000-000000000003'),'next order copies selected basis only');
-- A manually agreed total can be printed even when individual work has no catalogue price.
insert into public.garage_order_tasks(id,order_id,work_code,work_name,status,working_mechanic_id,completed_at)
  values('7e100000-0000-4000-9000-000000000003','7e000000-0000-4000-9000-000000000002','W01',
    'Unpriced service','completed','00000000-0000-4000-8000-000000000002',now());
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare ord uuid:='7e000000-0000-4000-9000-000000000002'; unpriced jsonb:=jsonb_build_object('7e100000-0000-4000-9000-000000000003',null);
  quote jsonb:=jsonb_build_object('listed',unpriced,'allocated',unpriced,'agreed_total_kopeks',5000); doc jsonb;
begin
  perform public.garage_save_commercial(ord,0,5000,'agreed');
  begin perform public.garage_act_save(ord,'10002/11','C','2026-11-01','2026-11-21',0,1,jsonb_build_object('mode','weighted','quote',quote),'VIN');
    raise 'unpriced weighted lines accepted'; exception when invalid_parameter_value then null; end;
  doc:=public.garage_act_save(ord,'10002/11','C','2026-11-01','2026-11-21',0,1,jsonb_build_object('mode','names','quote',quote),'VIN');
  perform pg_temp.check_commercial(doc->'pricing_snapshot'->>'agreed_total_kopeks'='5000','names-only act with an unknown unit price');
end $$;
reset role;
rollback;
