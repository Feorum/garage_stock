-- The workbook rule is configured privately. Public clients receive no catalogue rates or promotion configuration.
begin;

create table garage_pay.gift_offer (
  singleton boolean primary key default true check (singleton),
  gift_work_code text not null references public.garage_works(code),
  qualifying_count integer not null check (qualifying_count between 1 and 100)
);
alter table garage_pay.gift_offer enable row level security;
revoke all on garage_pay.gift_offer from public, anon, authenticated, service_role;

create function garage_pay.owner_gift_offer() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  return (select jsonb_build_object('work_code',gift_work_code,'qualifying_count',qualifying_count)
          from garage_pay.gift_offer where singleton);
end $$;

-- The optional service is a normal, assignable operational task. Only its Owner charge
-- is overridden. Keeping the two writes in one transaction also covers an ambiguous retry.
create function garage_pay.save_order_with_gift(
  p_mode text,p_id uuid,p_expected_version integer,p_order jsonb,p_tasks jsonb,
  p_gift_expected_version integer,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  rule garage_pay.gift_offer%rowtype;
  result jsonb;
  payload jsonb;
  gift_task uuid;
  gift_private jsonb;
  visit uuid;
begin
  if not public.garage_is_owner() then raise exception using errcode='42501',message='Owner access required.'; end if;
  payload:=jsonb_build_object('op','save_order_with_gift','mode',p_mode,'id',p_id,'version',p_expected_version,
    'order',p_order,'tasks',p_tasks,'price_version',p_gift_expected_version);
  result:=public.garage_begin_request(p_request_id,payload);
  if result is not null then return result; end if;
  select * into rule from garage_pay.gift_offer where singleton for share;
  if not found then raise exception 'The offer is unavailable.'; end if;
  if p_gift_expected_version is null or p_gift_expected_version<0 then raise exception 'Invalid price version.'; end if;
  result:=public.garage_save_team_order(p_mode,p_id,p_expected_version,p_order,p_tasks,gen_random_uuid());
  visit:=(result->>'order_id')::uuid;
  select t.id into strict gift_task from public.garage_order_tasks t where t.order_id=visit
    and t.status<>'cancelled' and t.work_code=rule.gift_work_code for update;
  if (select count(distinct t.work_code) from public.garage_order_tasks t where t.order_id=visit
      and t.status<>'cancelled' and t.work_code<>rule.gift_work_code)<rule.qualifying_count then
    raise exception using errcode='22023',message='The visit does not qualify for the offer.';
  end if;
  gift_private:=garage_pay.price_fields(gift_task,null);
  if (gift_private->>'private_version')::integer<>p_gift_expected_version then
    raise exception using errcode='40001',message='The price changed. Reload the order.';
  end if;
  if (gift_private->>'override_kopeks')::bigint is distinct from 0 then
    perform public.garage_save_task_pricing(gift_task,p_gift_expected_version,0,gift_private->>'private_comment',gen_random_uuid());
  end if;
  return public.garage_finish_request(p_request_id,payload,result);
end $$;

create function public.garage_owner_gift_offer() returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$select garage_pay.owner_gift_offer()$$;
create function public.garage_save_order_with_gift(
  p_mode text,p_id uuid,p_expected_version integer,p_order jsonb,p_tasks jsonb,
  p_gift_expected_version integer,p_request_id uuid
) returns jsonb language sql security invoker set search_path=pg_catalog as $$
  select garage_pay.save_order_with_gift(p_mode,p_id,p_expected_version,p_order,p_tasks,p_gift_expected_version,p_request_id)
$$;

revoke all on function garage_pay.owner_gift_offer(),public.garage_owner_gift_offer(),
  garage_pay.save_order_with_gift(text,uuid,integer,jsonb,jsonb,integer,uuid),
  public.garage_save_order_with_gift(text,uuid,integer,jsonb,jsonb,integer,uuid)
  from public,anon,authenticated,service_role;
grant execute on function garage_pay.owner_gift_offer(),public.garage_owner_gift_offer(),
  garage_pay.save_order_with_gift(text,uuid,integer,jsonb,jsonb,integer,uuid),
  public.garage_save_order_with_gift(text,uuid,integer,jsonb,jsonb,integer,uuid) to authenticated;
insert into public.garage_schema_migrations(version) values('20261118185548');
notify pgrst,'reload schema';
commit;
