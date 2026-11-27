begin;

create table garage_board.owner_preferences (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  key text not null check (length(key) between 1 and 180),
  value jsonb not null check (octet_length(value::text) <= 262144),
  primary key (owner_id, key)
);
alter table garage_board.owner_preferences enable row level security;
revoke all on garage_board.owner_preferences from public, anon, authenticated, service_role;
grant select, insert, update (value) on garage_board.owner_preferences to authenticated;
create policy own_workspace on garage_board.owner_preferences for all to authenticated
  using (owner_id = (select auth.uid()) and (select public.garage_is_owner()))
  with check (owner_id = (select auth.uid()) and (select public.garage_is_owner()));

create function public.garage_owner_preferences() returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from garage_board.owner_preferences
  where owner_id = (select auth.uid())
$$;
create function public.garage_save_owner_preference(p_owner_id uuid, p_key text, p_value jsonb) returns void
language sql security invoker set search_path = pg_catalog as $$
  insert into garage_board.owner_preferences (owner_id, key, value) values (p_owner_id, p_key, p_value)
  on conflict (owner_id, key) do update set value = excluded.value
$$;
revoke all on function public.garage_owner_preferences(), public.garage_save_owner_preference(uuid,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.garage_owner_preferences(), public.garage_save_owner_preference(uuid,text,jsonb) to authenticated;
insert into public.garage_schema_migrations(version) values ('20261127112816');
notify pgrst, 'reload schema';
commit;
