begin;

-- Keep the original rate for history and use the order editor's calculation for review.
create or replace function garage_pay.owner_review_prices(p_order_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if not public.garage_is_owner() then
    raise exception using errcode='42501', message='Owner access required.';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) > 100 then
    raise exception using errcode='22023', message='Specify up to 100 orders.';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc, r.order_id), '[]'::jsonb)
    from (
      select o.id as order_id, o.created_at, o.closed_at,
             coalesce(jsonb_agg(jsonb_build_object(
               'task_id', t.id, 'net_kopeks', (f.net_amount * 100)::bigint,
               'effective_kopeks', garage_pay.price_fields(t.id, (f.net_amount * 100)::bigint) -> 'effective_kopeks'
             ) order by t.created_at, t.id) filter (where t.id is not null), '[]'::jsonb) as tasks
      from public.garage_orders o
      left join public.garage_order_tasks t on t.order_id = o.id and t.status <> 'cancelled'
      left join public.garage_task_financials f on f.task_id = t.id
      where o.id = any(p_order_ids)
      group by o.id
    ) r
  );
end $$;

insert into public.garage_schema_migrations(version) values ('20261120155421');
notify pgrst, 'reload schema';
commit;
