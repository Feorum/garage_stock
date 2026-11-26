begin;
insert into auth.users(id,email) values
  ('ad000000-0000-4000-8000-000000000001','note-owner@example.invalid'),
  ('ad000000-0000-4000-8000-000000000002','note-other@example.invalid'),
  ('ad000000-0000-4000-8000-000000000003','note-mechanic@example.invalid');
update public.profiles set role='admin' where id in (
  'ad000000-0000-4000-8000-000000000001','ad000000-0000-4000-8000-000000000002');
-- Same ID in the two record types must address two independent notes.
insert into public.garage_orders(id,vehicle,vehicle_group_code,source,status,created_by)
  values('ad000000-0000-4000-8000-000000000004','Note fixture','VG01','manager','published','ad000000-0000-4000-8000-000000000001');
insert into garage_custom.orders(id,owner_id,vehicle,visit_date,status,payments,allocations)
  values('ad000000-0000-4000-8000-000000000004','ad000000-0000-4000-8000-000000000001','Private fixture',current_date,'open','[]','[]');
do $$begin
  if has_table_privilege('authenticated','garage_notes.order_notes','select') or
     has_table_privilege('authenticated','garage_notes.order_notes','insert') or
     has_function_privilege('anon','public.garage_owner_order_note(uuid,boolean)','execute') then
    raise exception 'Unexpected direct access to owner notes.';
  end if;
end$$;
set local role authenticated;
set local request.jwt.claim.sub='ad000000-0000-4000-8000-000000000001';
do $$
declare id uuid := 'ad000000-0000-4000-8000-000000000004'; request uuid := gen_random_uuid(); saved jsonb;
begin
  if public.garage_owner_order_note(id,false) <> '{"note":"","version":0}' then raise exception 'No blank state.'; end if;
  saved := public.garage_save_owner_order_note(id,false,0,E'Строка 1\nСтрока 2',request);
  if saved->>'version'<>'1' or saved is distinct from public.garage_owner_order_note(id,false)
     or saved is distinct from public.garage_save_owner_order_note(id,false,0,E'Строка 1\nСтрока 2',request)
     or public.garage_owner_order_note(id,true)<>'{"note":"","version":0}' then raise exception 'Readback or retry failed.'; end if;
  perform public.garage_save_owner_order_note(id,true,0,'Кастомный заказ',gen_random_uuid());
  begin
    perform public.garage_save_owner_order_note(id,false,0,'Другая сессия',gen_random_uuid());
    raise exception 'Stale first write accepted.';
  exception when serialization_failure then null; end;
  begin
    perform public.garage_save_owner_order_note(id,false,1,repeat('я',4001),gen_random_uuid());
    raise exception 'Invalid size accepted.';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub','ad000000-0000-4000-8000-000000000002',true);
  if public.garage_owner_order_note(id,false)<>saved then raise exception 'Wrong standard order visibility.'; end if;
  begin
    perform public.garage_owner_order_note(id,true);
    raise exception 'Another owner read a custom-order note.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.garage_save_owner_order_note(id,true,1,'Changed',gen_random_uuid());
    raise exception 'Another owner wrote a custom-order note.';
  exception when insufficient_privilege then null; end;
  if public.garage_save_owner_order_note(id,false,1,'',gen_random_uuid())<>'{"note":"","version":2}' then
    raise exception 'Clearing a saved note did not preserve concurrency version.';
  end if;
  begin
    perform public.garage_save_owner_order_note(id,false,1,'stale',gen_random_uuid());
    raise exception 'Stale update accepted.';
  exception when serialization_failure then null; end;
  perform set_config('request.jwt.claim.sub','ad000000-0000-4000-8000-000000000003',true);
  begin
    perform public.garage_owner_order_note(id,false);
    raise exception 'Mechanic could read an owner note.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.garage_save_owner_order_note(id,false,2,'mechanic',gen_random_uuid());
    raise exception 'Mechanic could edit an owner note.';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
delete from garage_custom.orders where id='ad000000-0000-4000-8000-000000000004';
do $$begin
  if exists (select from garage_notes.order_notes where custom and order_id='ad000000-0000-4000-8000-000000000004') then
    raise exception 'Deleted order retained its note.';
  end if;
end$$;
set local role authenticated;
set local request.jwt.claim.sub='ad000000-0000-4000-8000-000000000001';
do $$begin
  begin
    perform public.garage_owner_order_note('ad000000-0000-4000-8000-000000000004',true);
    raise exception 'Deleted order still readable.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.garage_save_owner_order_note('ad000000-0000-4000-8000-000000000004',true,0,'orphan',gen_random_uuid());
    raise exception 'Orphan note created.';
  exception when insufficient_privilege then null; end;
end$$;
rollback;
