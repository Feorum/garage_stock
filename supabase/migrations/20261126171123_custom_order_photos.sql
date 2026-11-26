begin;

-- The custom prefix keeps private owner records separate from standard visit paths.
create function garage_photos.custom_order_id(object_name text) returns uuid
language sql immutable strict set search_path=pg_catalog as $$
  select case when object_name ~ '^custom/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(jpg|png|webp|avif)$'
    then split_part(object_name,'/',2)::uuid end
$$;

create function garage_photos.can_read_custom_photo(object_name text) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
  select public.garage_is_owner() and exists (
    select from garage_custom.orders
    where id=garage_photos.custom_order_id(object_name) and owner_id=auth.uid()
  )
$$;

create function garage_photos.can_upload_custom_photo(object_name text) returns boolean
language plpgsql volatile security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then return false; end if;
  perform 1 from garage_custom.orders
    where id=garage_photos.custom_order_id(object_name) and owner_id=auth.uid() and status='open' for share;
  return found;
end $$;

revoke all on function garage_photos.custom_order_id(text), garage_photos.can_read_custom_photo(text),
  garage_photos.can_upload_custom_photo(text) from public, anon, authenticated, service_role;
grant execute on function garage_photos.can_read_custom_photo(text), garage_photos.can_upload_custom_photo(text) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  alter policy garage_order_photo_read on storage.objects
    using (bucket_id='garage-order-photos' and garage_photos.order_id(name) is not null
      and public.garage_can_view_order(garage_photos.order_id(name)));
  create policy garage_custom_photo_read on storage.objects for select to authenticated
    using (bucket_id='garage-order-photos' and garage_photos.can_read_custom_photo(name));
  create policy garage_custom_photo_upload on storage.objects for insert to authenticated
    with check (bucket_id='garage-order-photos' and garage_photos.can_upload_custom_photo(name));
end $$;

insert into public.garage_schema_migrations(version) values ('20261126171123');
notify pgrst,'reload schema';
commit;
