-- Synthetic film costs and a UTF-8 vehicle name exercise the user-facing JSON Lines download.
begin;
create function pg_temp.check_film(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Film check: %',label; end if; end $$;
insert into public.garage_orders(id,vehicle,vehicle_group_code,source,created_by)
  select ('7f500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Модель '||n,'VG02','manager',
    '00000000-0000-4000-8000-000000000001'::uuid from generate_series(1,2) n;
insert into public.garage_order_tasks(id,order_id,work_code,work_name,status,working_mechanic_id,completed_at)
  select ('7f510000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
    ('7f500000-0000-4000-8000-'||lpad(ord::text,12,'0'))::uuid,code,name,'completed',
    '00000000-0000-4000-8000-000000000002',now()
    from (values(1,1,'W01','Капот'),(2,1,'W02','Зеркала'),(3,2,'W01','Без цены'),(4,2,'W02','Подарок')) v(n,ord,code,name);
insert into public.garage_price_lists(id,name,source_sha256) values('7f520000-0000-4000-8000-000000000001','Synthetic material rate list',repeat('c',64));
insert into public.garage_task_financials(task_id,price_list_id,pricing_status,net_amount,vat_rate,vat_amount,gross_amount)
  select ('7f510000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'7f520000-0000-4000-8000-000000000001',
    'priced',price,0,0,price from (values(1,125),(2,62.50),(4,0)) v(n,price);
select pg_temp.check_film(not has_function_privilege('anon','public.garage_film_file(bigint,integer)','execute')
  and not has_table_privilege('authenticated','garage_pay.film_revisions','select'),'file is private');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
do $$
declare ord uuid:='7f500000-0000-4000-8000-000000000001';
begin
  begin perform public.garage_order_film(ord); raise 'Mechanic read film'; exception when insufficient_privilege then null; end;
  begin perform public.garage_save_order_film(ord,0,'token','order',6000,'{}',gen_random_uuid());
    raise 'Mechanic wrote film'; exception when insufficient_privilege then null; end;
  begin perform public.garage_film_file(0,100); raise 'Mechanic downloaded film'; exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare
  ord uuid:='7f500000-0000-4000-8000-000000000001';
  other uuid:='7f500000-0000-4000-8000-000000000002';
  a text:='7f510000-0000-4000-8000-000000000001'; b text:='7f510000-0000-4000-8000-000000000002';
  unknown text:='7f510000-0000-4000-8000-000000000003'; free text:='7f510000-0000-4000-8000-000000000004';
  request uuid:=gen_random_uuid(); initial jsonb; saved jsonb; retry jsonb; work jsonb; blank jsonb; zero_amount jsonb;
  token text; file jsonb; initial_size bigint; content bytea; byte_cut integer; split bytea; entries jsonb[];
begin
  initial_size:=(public.garage_film_file(0,1)->>'size')::bigint;
  initial:=public.garage_order_film(ord);
  token:=initial->>'price_token';
  perform pg_temp.check_film(initial->>'version'='0' and token<>'' and initial->'amount_kopeks'='null'
    and initial->>'order_price_kopeks'='15000' and jsonb_array_length(initial->'lines')=2,'current internal prices and empty state');
  perform pg_temp.check_film(public.garage_save_order_film(ord,0,token,'order',null,'{}',gen_random_uuid())=initial,
    'initial empty save is a no-op');
  saved:=public.garage_save_order_film(ord,0,token,'order',6000,'{}',request);
  perform pg_temp.check_film(saved->>'version'='1' and saved->>'mode'='order' and saved->>'amount_kopeks'='6000'
    and (saved->>'percent')::numeric=40 and not exists(select from jsonb_array_elements(saved->'lines') x
      where x->'amount_kopeks'<>'null'),'whole-order cost is attributed to set, never split across jobs');
  retry:=public.garage_save_order_film(ord,0,token,'order',6000,'{}',request);
  perform pg_temp.check_film(retry=saved,'receipt replay returns the original response');
  begin perform public.garage_save_order_film(ord,0,token,'order',9999,'{}',request);
    raise 'Changed request reused'; exception when serialization_failure then null; end;
  begin perform public.garage_save_order_film(ord,0,token,'order',9999,'{}',gen_random_uuid());
    raise 'Stale version accepted'; exception when serialization_failure then null; end;
  begin perform public.garage_save_order_film(ord,1,'stale','order',6000,'{}',gen_random_uuid());
    raise 'Stale prices accepted'; exception when serialization_failure then null; end;
  begin perform public.garage_save_order_film(ord,1,token,'works',null,jsonb_build_object(unknown,100),gen_random_uuid());
    raise 'Foreign work accepted'; exception when invalid_parameter_value then null; end;
  work:=public.garage_save_order_film(ord,1,token,'works',null,jsonb_build_object(a,5000,b,1000),gen_random_uuid());
  perform pg_temp.check_film(work->>'version'='2' and work->>'mode'='works' and work->'amount_kopeks'='null'
    and (select (x->>'percent')::numeric=50 and x->>'amount_kopeks'='5000' and x->>'price_kopeks'='10000'
      from jsonb_array_elements(work->'lines') x where x->>'task_id'=a)
    and (select (x->>'percent')::numeric=20 and x->>'amount_kopeks'='1000' and x->>'price_kopeks'='5000'
      from jsonb_array_elements(work->'lines') x where x->>'task_id'=b),'per-work percentages use their respective 80% bases');
  blank:=public.garage_save_order_film(ord,2,token,'works',null,'{}',gen_random_uuid());
  perform pg_temp.check_film(blank->>'version'='3' and not exists(select from jsonb_array_elements(blank->'lines') x
    where x->'amount_kopeks'<>'null'),'clearing works stores an empty correction');
  zero_amount:=public.garage_save_order_film(ord,3,token,'order',0,'{}',gen_random_uuid());
  perform pg_temp.check_film(zero_amount->>'amount_kopeks'='0' and (zero_amount->>'percent')::numeric=0
    and zero_amount->>'version'='4','zero film cost is an explicit entry');
  perform pg_temp.check_film(public.garage_save_order_film(ord,4,token,'order',0,'{}',gen_random_uuid())=zero_amount,
    'saving identical current values does not append');
  perform pg_temp.check_film(public.garage_save_order_film(ord,0,token,'order',6000,'{}',request)=saved
    and public.garage_order_film(ord)=zero_amount,'retry after correction cannot overwrite that correction');
  initial:=public.garage_order_film(other);
  work:=public.garage_save_order_film(other,0,initial->>'price_token','works',null,jsonb_build_object(unknown,100,free,0),gen_random_uuid());
  perform pg_temp.check_film(work->'order_price_kopeks'='null' and (select x->'price_kopeks'='null'
      from jsonb_array_elements(work->'lines') x where x->>'task_id'=unknown)
    and (select x->>'price_kopeks'='0' from jsonb_array_elements(work->'lines') x where x->>'task_id'=free)
    and not exists(select from jsonb_array_elements(work->'lines') x where x->'percent'<>'null'),
    'unknown and zero prices preserve amounts with no percentage');
  file:=public.garage_film_file(initial_size,262144);
  content:=decode(file->>'data','base64');
  perform pg_temp.check_film(octet_length(content)=(file->>'size')::bigint-initial_size,'file size is counted in UTF-8 bytes');
  byte_cut:=position(convert_to('Модель','UTF8') in content);
  perform pg_temp.check_film(byte_cut>0,'file includes concrete vehicle name');
  split:=decode(public.garage_film_file(initial_size,byte_cut)->>'data','base64')||
    decode(public.garage_film_file(initial_size+byte_cut,262144)->>'data','base64');
  perform pg_temp.check_film(split=content and public.garage_film_file((file->>'size')::bigint,100)->>'data'='',
    'chunk boundary inside a multibyte character and EOF');
  select array_agg(line::jsonb order by pos) into entries
    from regexp_split_to_table(convert_from(content,'UTF8'),chr(10)) with ordinality as x(line,pos) where line<>'';
  perform pg_temp.check_film(array_length(entries,1)=5 and entries[1]->>'order_id'=ord::text and entries[1]->>'version'='1'
    and entries[1]->>'vehicle'='Модель 1' and entries[1]->>'mode'='order' and (entries[1]->>'percent')::numeric=40
    and entries[1]->>'order_price_kopeks'='15000' and entries[1]->>'amount_kopeks'='6000'
    and entries[2]->>'mode'='works' and (select (x->>'percent')::numeric=20 from jsonb_array_elements(entries[2]->'lines') x where x->>'task_id'=b)
    and entries[3]->>'version'='3' and entries[4]->>'amount_kopeks'='0' and entries[5]->>'order_id'=other::text,
    'each accepted change produces one ordered, reconstructible journal record');
end $$;
reset role;
insert into public.garage_order_tasks(id,order_id,work_code,work_name,status)
  values('7f510000-0000-4000-8000-000000000005','7f500000-0000-4000-8000-000000000001','W03','Отменённая работа','cancelled');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
declare
  ord uuid:='7f500000-0000-4000-8000-000000000001';
  expected jsonb:='["7f510000-0000-4000-8000-000000000001","7f510000-0000-4000-8000-000000000002"]';
  initial_size bigint:=(public.garage_film_file(0,1)->>'size')::bigint; receipt jsonb; entry jsonb; file jsonb;
begin
  receipt:=public.garage_order_action(ord,'close',(select version from public.garage_orders where id=ord),gen_random_uuid());
  file:=public.garage_film_file(initial_size,262144);
  entry:=convert_from(decode(file->>'data','base64'),'UTF8')::jsonb;
  perform pg_temp.check_film(receipt->>'status'='closed' and entry->>'order_status'='closed' and entry->>'order_id'=ord::text
    and entry->>'mode'='order' and entry->>'version'='5' and entry->>'amount_kopeks'='0'
    and entry->'completed_work_ids' @> expected and expected @> (entry->'completed_work_ids')
    and not exists(select from jsonb_array_elements(entry->'lines') x where x->>'status'='cancelled'),
    'closing a recorded order appends its final amount and exact completed scope');
end $$;
rollback;
