begin;

-- An Owner's saved allocation belongs to the job, even if the mechanic later
-- corrects its completion. The worklist still joins to current completions.
alter table garage_pay.items
  drop constraint items_task_id_fkey,
  add constraint items_task_id_fkey foreign key (task_id) references public.garage_order_tasks(id);

create or replace function garage_pay.enqueue_completion() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  insert into garage_pay.items(task_id) values(new.task_id) on conflict (task_id) do nothing;
  return new;
end $$;

-- The pay save and mechanic correction both lock the pay item. Reject a fresh
-- allocation from a stale Owner form if the final check has been withdrawn.
create function garage_pay.require_current_completion() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  if not exists(select from public.garage_task_completions where task_id=new.task_id) then
    raise exception using errcode='40001', message='Job completion changed. Refresh the allocation.';
  end if;
  return new;
end $$;

revoke all on function garage_pay.require_current_completion() from public, anon, authenticated, service_role;
create trigger garage_require_current_completion before insert on garage_pay.revisions
  for each row execute function garage_pay.require_current_completion();

insert into public.garage_schema_migrations(version) values ('20261120155922');
commit;
