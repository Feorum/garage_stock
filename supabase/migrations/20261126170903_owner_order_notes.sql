begin;

create schema garage_notes;
revoke all on schema garage_notes from public, anon, authenticated, service_role;
grant usage on schema garage_notes to authenticated;

create table garage_notes.order_notes (
  standard_id uuid references public.garage_orders(id) on delete cascade,
  custom_id uuid references garage_custom.orders(id) on delete cascade,
  order_id uuid generated always as (coalesce(standard_id,custom_id)) stored,
  custom boolean generated always as (custom_id is not null) stored,
  note text not null check (length(note) <= 4000),
  version integer not null check (version > 0),
  check (num_nonnulls(standard_id,custom_id) = 1),
  primary key (order_id,custom)
);
alter table garage_notes.order_notes enable row level security;
revoke all on garage_notes.order_notes from public, anon, authenticated, service_role;

create function garage_notes.check_order(p_order_id uuid, p_custom boolean) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() or p_custom is null or p_order_id is null then
    raise exception using errcode='42501', message='Order unavailable.';
  end if;
  if p_custom then
    if exists(select from garage_custom.orders where id=p_order_id and owner_id=auth.uid()) then return; end if;
  elsif exists(select from public.garage_orders where id=p_order_id) then
    return;
  end if;
  raise exception using errcode='42501', message='Order unavailable.';
end $$;

create function garage_notes.read_note(p_order_id uuid, p_custom boolean) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
  perform garage_notes.check_order(p_order_id,p_custom);
  select jsonb_build_object('note',note,'version',version) into result
    from garage_notes.order_notes where order_id=p_order_id and custom=p_custom;
  return coalesce(result, '{"note":"","version":0}'::jsonb);
end $$;

create function garage_notes.save_note(p_order_id uuid, p_custom boolean, p_expected_version integer,
  p_note text, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare payload jsonb; result jsonb; saved_version integer;
begin
  perform public.garage_lock_actor();
  perform garage_notes.check_order(p_order_id,p_custom);
  if p_expected_version is null or p_expected_version < 0 or p_note is null or length(p_note)>4000 then
    raise exception using errcode='22023', message='Invalid order note.';
  end if;
  payload := jsonb_build_array('owner_order_note',p_order_id,p_custom,p_expected_version,p_note);
  result := public.garage_begin_request(p_request_id,payload);
  if result is not null then return result; end if;

  if p_expected_version=0 then
    insert into garage_notes.order_notes(standard_id,custom_id,note,version)
      values(case when not p_custom then p_order_id end,case when p_custom then p_order_id end,p_note,1)
      on conflict (order_id,custom) do nothing returning version into saved_version;
  else
    update garage_notes.order_notes set note=p_note, version=version+1
      where order_id=p_order_id and custom=p_custom and version=p_expected_version
      returning version into saved_version;
  end if;
  if saved_version is null then
    raise exception using errcode='40001', message='Order note changed.';
  end if;
  return public.garage_finish_request(p_request_id,payload,jsonb_build_object('note',p_note,'version',saved_version));
end $$;

create function public.garage_owner_order_note(p_order_id uuid, p_custom boolean) returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$
  select garage_notes.read_note(p_order_id,p_custom)
$$;
create function public.garage_save_owner_order_note(p_order_id uuid, p_custom boolean, p_expected_version integer,
  p_note text, p_request_id uuid) returns jsonb
language sql security invoker set search_path=pg_catalog as $$
  select garage_notes.save_note(p_order_id,p_custom,p_expected_version,p_note,p_request_id)
$$;
revoke all on all functions in schema garage_notes from public, anon, authenticated, service_role;
revoke all on function public.garage_owner_order_note(uuid,boolean),
  public.garage_save_owner_order_note(uuid,boolean,integer,text,uuid) from public, anon, authenticated, service_role;
grant execute on function garage_notes.read_note(uuid,boolean), garage_notes.save_note(uuid,boolean,integer,text,uuid),
  public.garage_owner_order_note(uuid,boolean), public.garage_save_owner_order_note(uuid,boolean,integer,text,uuid)
  to authenticated;

insert into public.garage_schema_migrations(version) values ('20261126170903');
notify pgrst, 'reload schema';
commit;
