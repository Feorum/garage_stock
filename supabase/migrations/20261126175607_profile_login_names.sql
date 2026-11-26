begin;

create schema garage_identity;
revoke all on schema garage_identity from public, anon, authenticated, service_role;
grant usage on schema garage_identity to authenticated, service_role;

create function garage_identity.display_name(p_name text) returns text
language sql immutable strict set search_path=pg_catalog as $$
  select btrim(regexp_replace(normalize(p_name,NFC) collate pg_catalog."und-x-icu",'[[:space:]]+',' ','g'))
$$;
create function garage_identity.name_key(p_display text) returns text
language sql immutable strict set search_path=pg_catalog as $$
  select case when length(p_display) between 1 and 120 and strpos(p_display,'@')=0
      and p_display collate pg_catalog."und-x-icu" !~ '[[:cntrl:]]'
    then lower(p_display collate pg_catalog."und-x-icu") end
$$;

-- Keep old ambiguous names reachable by email without changing the names on past work.
-- Every new name is protected by a unique index, including concurrent Auth user inserts.
create table garage_identity.profile_names (
  profile_id uuid primary key references public.profiles(id) on delete cascade deferrable initially deferred,
  name_key text collate "C" not null,
  legacy_duplicate boolean not null default false
);
alter table garage_identity.profile_names enable row level security;
revoke all on garage_identity.profile_names from public, anon, authenticated, service_role;
create unique index profile_names_unique on garage_identity.profile_names(name_key) where not legacy_duplicate;
create index profile_names_legacy on garage_identity.profile_names(name_key) where legacy_duplicate;

lock table public.profiles in share row exclusive mode;
with names as (
  select id,garage_identity.name_key(garage_identity.display_name(name)) as name_key from public.profiles
)
insert into garage_identity.profile_names(profile_id,name_key,legacy_duplicate)
  select id,name_key,count(*) over(partition by name_key)>1 from names where name_key is not null;

create function garage_identity.claim_profile_name() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare wanted text;
begin
  new.name := garage_identity.display_name(new.name);
  wanted := garage_identity.name_key(new.name);
  if wanted is null then raise exception using errcode='22023', message='Invalid profile name.'; end if;
  if tg_op='UPDATE' and wanted=garage_identity.name_key(garage_identity.display_name(old.name)) then return new; end if;
  if exists (select from garage_identity.profile_names where legacy_duplicate and name_key=wanted) then
    raise exception using errcode='23505', message='Profile name already in use.';
  end if;
  insert into garage_identity.profile_names(profile_id,name_key) values(new.id,wanted)
    on conflict (profile_id) do update set name_key=excluded.name_key, legacy_duplicate=false;
  return new;
end $$;
create trigger garage_claim_profile_name before insert or update of name on public.profiles
  for each row execute function garage_identity.claim_profile_name();

-- This function is invoked only by the authenticated service used for password verification.
-- Count inactive accounts too so that a historically ambiguous name can never select a different person.
create function garage_identity.resolve_login_name(p_name text) returns text
language sql stable security definer set search_path=pg_catalog as $$
  select case when count(*)=1 then min(u.email) filter (where p.active) end
  from garage_identity.profile_names n join public.profiles p on p.id=n.profile_id
  join auth.users u on u.id=p.id
  where n.name_key=garage_identity.name_key(garage_identity.display_name(p_name))
$$;

create function garage_identity.update_profile_name(p_name text) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare saved text;
begin
  update public.profiles set name=p_name
    where id=auth.uid() and active and role in ('admin','mechanic') returning name into saved;
  if not found then raise exception using errcode='42501', message='Active workshop account required.'; end if;
  return saved;
end $$;

create function garage_identity.mechanic_accounts() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then raise exception using errcode='42501', message='Owner access required.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'email',u.email,'role',p.role,'active',p.active,'color',garage_board.mechanic_color(p.id)
  ) order by p.name collate pg_catalog."und-x-icu",p.id),'[]'::jsonb)
    from public.profiles p join auth.users u on u.id=p.id where p.role='mechanic');
end $$;

create function public.garage_resolve_login_name(p_name text) returns text
language sql stable security invoker set search_path=pg_catalog as $$ select garage_identity.resolve_login_name(p_name) $$;
create function public.garage_update_profile_name(p_name text) returns text
language sql security invoker set search_path=pg_catalog as $$ select garage_identity.update_profile_name(p_name) $$;
create function public.garage_mechanic_accounts() returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$ select garage_identity.mechanic_accounts() $$;

revoke all on all functions in schema garage_identity from public, anon, authenticated, service_role;
revoke all on function public.garage_resolve_login_name(text),public.garage_update_profile_name(text),
  public.garage_mechanic_accounts() from public, anon, authenticated, service_role;
grant execute on function garage_identity.resolve_login_name(text),public.garage_resolve_login_name(text) to service_role;
grant execute on function garage_identity.update_profile_name(text),public.garage_update_profile_name(text),
  garage_identity.mechanic_accounts(),public.garage_mechanic_accounts() to authenticated;

insert into public.garage_schema_migrations(version) values ('20261126175607');
notify pgrst, 'reload schema';
commit;
