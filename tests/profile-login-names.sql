begin;

-- Auth Admin creates the user. The existing trigger must create a mechanic
-- and claim its normalized login name in the same transaction.
insert into auth.users(id,email,raw_user_meta_data) values
  ('ac000000-0000-4000-8000-000000000001','profile-owner@example.invalid','{"name":"Владелец профиля"}'),
  ('ac000000-0000-4000-8000-000000000002','profile-active@example.invalid','{"name":"  Тестовый   Механик  "}'),
  ('ac000000-0000-4000-8000-000000000003','profile-inactive@example.invalid','{"name":"Бывший механик"}');
update public.profiles set role='admin' where id='ac000000-0000-4000-8000-000000000001';
update public.profiles set active=false where id='ac000000-0000-4000-8000-000000000003';
do $$begin
  if not exists (select from public.profiles where id='ac000000-0000-4000-8000-000000000002'
    and role='mechanic' and active and name='Тестовый Механик') then
    raise exception 'Auth creation failed to provision an active mechanic with its login name.';
  end if;
  begin
    insert into auth.users(id,email,raw_user_meta_data)
      values ('ac000000-0000-4000-8000-000000000004','profile-collision@example.invalid','{"name":"теСТОВЫЙ  механик"}');
    raise exception 'Auth creation accepted a duplicate name.';
  exception when unique_violation then null; end;
  if exists (select from auth.users where email='profile-collision@example.invalid') then
    raise exception 'Rejected profile left a partial Auth account.';
  end if;
  if has_function_privilege('anon','public.garage_resolve_login_name(text)','execute')
     or has_function_privilege('authenticated','public.garage_resolve_login_name(text)','execute')
     or has_function_privilege('anon','public.garage_mechanic_accounts()','execute')
     or has_function_privilege('anon','public.garage_update_profile_name(text)','execute')
     or has_table_privilege('authenticated','garage_identity.profile_names','select') then
    raise exception 'Private identity data or operations were exposed.';
  end if;
end$$;

set local role service_role;
do $$begin
  if public.garage_resolve_login_name(E'  тестовый\tМЕХАНИК ') is distinct from 'profile-active@example.invalid'
     or public.garage_resolve_login_name('БЫВШИЙ МЕХАНИК') is not null
     or public.garage_resolve_login_name('Несуществующий профиль') is not null then
    raise exception 'Service name resolver returned an incorrect identity.';
  end if;
end$$;

reset role;
set local role authenticated;
set local request.jwt.claim.sub='ac000000-0000-4000-8000-000000000001';
do $$
declare directory jsonb := public.garage_mechanic_accounts();
begin
  if not directory @> '[{"id":"ac000000-0000-4000-8000-000000000002","email":"profile-active@example.invalid","role":"mechanic","active":true}]'
     or not directory @> '[{"id":"ac000000-0000-4000-8000-000000000003","active":false}]'
     or exists (select from jsonb_array_elements(directory) row where row->>'role'<>'mechanic') then
    raise exception 'Owner directory omitted a mechanic or returned a privileged account.';
  end if;
  if public.garage_update_profile_name('Тестовый владелец') is distinct from 'Тестовый владелец' then
    raise exception 'Owner could not rename their own profile.';
  end if;
end$$;

set local request.jwt.claim.sub='ac000000-0000-4000-8000-000000000002';
do $$begin
  begin
    perform public.garage_mechanic_accounts();
    raise exception 'A mechanic read the owner directory.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.garage_resolve_login_name('Тестовый владелец');
    raise exception 'A mechanic resolved a private email.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.garage_update_profile_name('ТЕСТОВЫЙ   Владелец');
    raise exception 'A duplicate self-rename succeeded.';
  exception when unique_violation then null; end;
  begin
    perform public.garage_update_profile_name('fake@example.invalid');
    raise exception 'An email-shaped login name was accepted.';
  exception when invalid_parameter_value then null; end;
  if public.garage_update_profile_name('  Сменивший   имя  ') is distinct from 'Сменивший имя' then
    raise exception 'Active mechanic could not rename their own profile.';
  end if;
end$$;

set local request.jwt.claim.sub='ac000000-0000-4000-8000-000000000003';
do $$begin
  begin
    perform public.garage_update_profile_name('Скрытое изменение');
    raise exception 'Inactive mechanic could rename a profile.';
  exception when insufficient_privilege then null; end;
end$$;
reset role;
set local role service_role;
do $$begin
  if public.garage_resolve_login_name('Тестовый механик') is not null
     or public.garage_resolve_login_name('СМЕНИВШИЙ ИМЯ') is distinct from 'profile-active@example.invalid'
     or public.garage_resolve_login_name('тестовый владелец') is distinct from 'profile-owner@example.invalid' then
    raise exception 'Renaming failed to release the old name or bind the new one.';
  end if;
end$$;
rollback;
