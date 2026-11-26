begin;

-- One immutable object per photo, stored under the visit UUID (never a VIN or plate).
create schema garage_photos;
revoke all on schema garage_photos from public, anon, authenticated;
grant usage on schema garage_photos to authenticated;

create function garage_photos.order_id(object_name text) returns uuid
language sql immutable strict security invoker set search_path=pg_catalog as $$
  select case when object_name ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(jpg|png|webp|avif)$'
    then split_part(object_name,'/',1)::uuid end
$$;

create function garage_photos.can_upload(object_name text) returns boolean
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare
  visit_id uuid := garage_photos.order_id(object_name);
begin
  -- Serialize acceptance with closure of this order, including uploads during Owner review.
  if visit_id is null or not public.garage_can_view_order(visit_id) then return false; end if;
  perform 1 from public.garage_orders o where o.id=visit_id and o.status='published' for share;
  return found;
end $$;
revoke all on all functions in schema garage_photos from public, anon, authenticated, service_role;
grant execute on function garage_photos.order_id(text),garage_photos.can_upload(text) to authenticated;

-- The standalone database test installation does not include Supabase Storage.
do $$
begin
  if to_regclass('storage.objects') is null and to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
    values ('garage-order-photos','garage-order-photos',false,20971520,
            array['image/jpeg','image/png','image/webp','image/avif']);
  create policy garage_order_photo_read on storage.objects for select to authenticated
    using (bucket_id='garage-order-photos' and public.garage_can_view_order(garage_photos.order_id(name)));
  create policy garage_order_photo_upload on storage.objects for insert to authenticated
    with check (bucket_id='garage-order-photos' and garage_photos.can_upload(name));
end $$;

insert into public.garage_schema_migrations(version) values ('20261126145852');
notify pgrst,'reload schema';
commit;
