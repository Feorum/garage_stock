-- Synthetic accounts. Run in the isolated schema test database.
begin;
insert into auth.users(id,email) values
  ('ab100000-0000-4000-8000-000000000001','prefs-a@example.invalid'),
  ('ab100000-0000-4000-8000-000000000002','prefs-b@example.invalid'),
  ('ab100000-0000-4000-8000-000000000003','prefs-m@example.invalid');
update public.profiles set role='admin',active=true where id in
  ('ab100000-0000-4000-8000-000000000001','ab100000-0000-4000-8000-000000000002');
set local role authenticated;
set local request.jwt.claim.sub='ab100000-0000-4000-8000-000000000001';
select public.garage_save_owner_preference(auth.uid(),'orderTable','{"sort":"vin"}');
select public.garage_save_owner_preference(auth.uid(),'widgets:home','[]');
select public.garage_save_owner_preference(auth.uid(),'orderTable','{"sort":"date"}');
do $$ begin
  if public.garage_owner_preferences() <> '{"orderTable":{"sort":"date"},"widgets:home":[]}'::jsonb then
    raise exception 'Preference upsert lost another key';
  end if;
end $$;
set local request.jwt.claim.sub='ab100000-0000-4000-8000-000000000002';
do $$ begin
  if public.garage_owner_preferences() <> '{}'::jsonb then raise exception 'Cross-account read'; end if;
  begin
    perform public.garage_save_owner_preference('ab100000-0000-4000-8000-000000000001','orderTable','{}');
    raise exception 'Cross-account write';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub='ab100000-0000-4000-8000-000000000003';
do $$ begin
  begin
    perform public.garage_save_owner_preference(auth.uid(),'orderTable','{}');
    raise exception 'Mechanic write';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
