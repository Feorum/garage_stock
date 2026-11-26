begin;

-- GoTrue can write Admin Create User's app_metadata after inserting auth.users.
-- Catch that update inside the same transaction, before the new user can sign in.
create function garage_identity.mark_registration_pending() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  update public.profiles set active=false,registration_pending=true
    where id=new.id and role='mechanic' and active and removed_at is null;
  return new;
end $$;
revoke all on function garage_identity.mark_registration_pending() from public,anon,authenticated,service_role;
create trigger garage_auth_mark_registration_pending after update of raw_app_meta_data on auth.users
  for each row when (
    new.raw_app_meta_data->'garage_registration_pending'='true'::jsonb
    and old.raw_app_meta_data->'garage_registration_pending' is distinct from 'true'::jsonb
  ) execute function garage_identity.mark_registration_pending();

-- Restore the approval requirement for any request created before this trigger.
update public.profiles p set active=false,registration_pending=true
  from auth.users u
  where p.id=u.id and p.role='mechanic' and p.active and p.removed_at is null
    and u.raw_app_meta_data->'garage_registration_pending'='true'::jsonb;

insert into public.garage_schema_migrations(version) values ('20261126185531');
commit;
