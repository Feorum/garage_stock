begin;
insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values
  ('ac100000-0000-4000-8000-000000000001','delete-owner@example.invalid','{"name":"Fixture owner for deletion"}','{}'),
  ('ac100000-0000-4000-8000-000000000002','new@accounts.garage.invalid','{"name":"Fixture pending mechanic"}','{"garage_registration_pending":true}'),
  ('ac100000-0000-4000-8000-000000000003','another@accounts.garage.invalid','{"name":"Fixture rejected mechanic"}','{"garage_registration_pending":true}');
update public.profiles set role='admin' where id='ac100000-0000-4000-8000-000000000001';

set local role service_role;
do $$
begin
  if public.garage_resolve_login_name('Fixture pending mechanic') is not null then
    raise exception 'Pending mechanic can sign in.';
  end if;
  for attempt in 1..31 loop
    if public.garage_allow_mechanic_registration() is distinct from (attempt<=30) then
      raise exception 'Registration rate limit is inconsistent.';
    end if;
  end loop;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub='ac100000-0000-4000-8000-000000000002';
do $$
begin
  begin
    perform public.garage_manage_mechanic('ac100000-0000-4000-8000-000000000002','approve');
    raise exception 'Pending mechanic can approve their own registration.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.garage_list_orders();
    raise exception 'Pending mechanic can list orders.';
  exception when insufficient_privilege then null; end;
end $$;

set local request.jwt.claim.sub='ac100000-0000-4000-8000-000000000001';
do $$
declare pending_id uuid:='ac100000-0000-4000-8000-000000000002';
  rejected_id uuid:='ac100000-0000-4000-8000-000000000003';
begin
  if not public.garage_mechanic_accounts() @> '[{"id":"ac100000-0000-4000-8000-000000000002","email":null,"active":false,"pending":true}]'
    then raise exception 'Owner directory failed to show a pending name-only profile.'; end if;
  perform public.garage_manage_mechanic(pending_id,'approve');
  perform public.garage_manage_mechanic(pending_id,'approve');
  perform public.garage_manage_mechanic(rejected_id,'reject');
  if not public.garage_mechanic_accounts() @> '[{"id":"ac100000-0000-4000-8000-000000000002","email":null,"active":true,"pending":false}]'
    or public.garage_mechanic_accounts() @> jsonb_build_array(jsonb_build_object('id',rejected_id))
    then raise exception 'Approval or rejection did not update the owner directory.'; end if;
end $$;
reset role;
set local role service_role;
do $$
begin
  if public.garage_resolve_login_name('Fixture pending mechanic') is distinct from 'new@accounts.garage.invalid'
    or public.garage_resolve_login_name('Fixture rejected mechanic') is not null
    then raise exception 'Name login did not follow approval and rejection.'; end if;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub='ac100000-0000-4000-8000-000000000001';
do $$
declare owner_id uuid:=auth.uid(); mechanic_id uuid:='ac100000-0000-4000-8000-000000000002';
  standard uuid; custom uuid; request_id uuid:=gen_random_uuid();
  draft jsonb:='{"vehicle":"Fixture deleted custom","services":"Work","visit_date":"2026-11-26","status":"closed",
    "customer_kopeks":8000,"payments":[{"name":"Fixture mechanic","kopeks":2000}],"allocations":[]}';
  standard_tag jsonb; custom_tag jsonb;
begin
  standard:=(public.garage_create_order('Fixture deleted standard','VG02','manager','[{"work_code":"W01"}]',gen_random_uuid())->>'order_id')::uuid;
  custom:=(public.garage_save_custom_order(null,0,draft,gen_random_uuid())->>'id')::uuid;
  standard_tag:=jsonb_build_array(jsonb_build_object('id',standard));
  custom_tag:=jsonb_build_array(jsonb_build_object('id',custom));
  perform set_config('request.jwt.claim.sub',mechanic_id::text,true);
  if not public.garage_list_orders() @> standard_tag then raise exception 'Fixture should be visible before deletion.'; end if;
  begin
    perform public.garage_delete_order(standard,false,1,request_id);
    raise exception 'A mechanic could delete a standard order.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  begin
    perform public.garage_delete_order(standard,false,0,gen_random_uuid());
    raise exception 'A stale standard order could be deleted.';
  exception when serialization_failure then null; end;
  if public.garage_delete_order(standard,false,1,request_id)->>'order_id' <> standard::text or
    public.garage_delete_order(standard,false,1,request_id)->>'order_id' <> standard::text then
    raise exception 'Deletion receipt or retry failed.';
  end if;
  perform public.garage_delete_order(custom,true,1,gen_random_uuid());
  if public.garage_list_orders() @> standard_tag or public.garage_custom_orders() @> custom_tag then
    raise exception 'A deleted order is still listed.';
  end if;
  begin
    perform public.garage_custom_orders(custom);
    raise exception 'A deleted custom order is still visible by ID.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.garage_save_custom_order(custom,2,draft,gen_random_uuid());
    raise exception 'A deleted custom order is still editable.';
  exception when serialization_failure then null; end;
  perform set_config('request.jwt.claim.sub',mechanic_id::text,true);
  if public.garage_list_orders() @> standard_tag or public.garage_can_view_order(standard) then
    raise exception 'A deleted order is still visible to the mechanic.';
  end if;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.garage_manage_mechanic(mechanic_id,'delete');
  if public.garage_mechanic_accounts() @> jsonb_build_array(jsonb_build_object('id',mechanic_id)) then
    raise exception 'A deleted profile is still listed.';
  end if;
end $$;
reset role;
do $$
begin
  if public.garage_resolve_login_name('Fixture pending mechanic') is not null
    or not exists(select from public.profiles where name='Fixture pending mechanic' and not active and removed_at is not null)
    or not exists(select from public.garage_orders where vehicle='Fixture deleted standard' and deleted_at is not null)
    or not exists(select from garage_custom.orders where vehicle='Fixture deleted custom' and deleted_at is not null
      and payments @> '[{"kopeks":2000}]')
    then raise exception 'Profile access persisted or financial history was lost.'; end if;
end $$;
rollback;
