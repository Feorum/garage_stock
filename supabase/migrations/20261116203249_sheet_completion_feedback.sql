-- Source-bound operational feedback. Private issued blocks authenticate echoes.
begin;
create table public.garage_sheet_feedback_outputs (
  source_id uuid not null references public.garage_sheet_sources(id),
  order_id uuid not null references public.garage_orders(id),
  block_hash text not null check (block_hash ~ '^[a-f0-9]{64}$'),
  block text not null check (length(block) between 1 and 20000),
  complete boolean not null,
  created_at timestamptz not null default now(),
  primary key(source_id,order_id,block_hash)
);
create index garage_sheet_feedback_order_idx on public.garage_sheet_feedback_outputs(order_id);
alter table public.garage_sheet_feedback_outputs enable row level security;
revoke all on public.garage_sheet_feedback_outputs from public,anon,authenticated,service_role;

create function public.garage_sheet_feedback(p_source_id uuid,p_lease_token uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare parent public.garage_orders%rowtype; keys text[]; tasks jsonb; selected record;
  block text; complete boolean; known jsonb; scope jsonb; rows jsonb:='[]';
begin
  perform public.garage_sheet_require_lease(p_source_id,p_lease_token,p_expected_version);
  for selected in
    select k.order_id,array_agg(k.source_key order by k.source_key) as keys
      from public.garage_sheet_order_keys(p_source_id) k group by k.order_id order by k.order_id
  loop
    select * into parent from public.garage_orders where id=selected.order_id for share;
    keys:=selected.keys;
    select coalesce(jsonb_agg(jsonb_build_object('work_code',t.work_code,'work_name',left(t.work_name,200),'options',t.options,
      'status',t.status,'mechanic_name',left(p.name,120),'completed_at',c.completed_at) order by t.created_at,t.id),'[]'::jsonb),
      coalesce(count(*) filter(where t.status='completed')>0 and bool_and(t.status in('completed','cancelled')),false),
      string_agg(left(t.work_name,200)||case when t.work_code='W19' then ' · '||(t.options->>'tint_percent')||'%' else '' end
        ||' — '||t.status||case when c.task_id is not null then ' · '||coalesce(left(p.name,120),'Recorded mechanic')||' · '
          ||to_char(c.completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') else '' end,E'\n' order by t.created_at,t.id)
      into tasks,complete,block from (
        select * from public.garage_order_tasks where order_id=parent.id and status<>'cancelled'
        union all
        (select distinct on(work_code,options) * from public.garage_order_tasks where order_id=parent.id and status='cancelled'
          order by work_code,options,created_at desc,id)
      ) t
      left join public.garage_task_completions c on c.task_id=t.id and c.order_id=t.order_id
      left join public.profiles p on p.id=c.mechanic_id where t.order_id=parent.id;
    complete:=complete and parent.status<>'cancelled';
    block:='[Garage '||parent.order_number||']'||E'\n'||coalesce(block,'No approved work.')||E'\n[/Garage]';
    if length(block)>20000 then raise exception 'The completion summary exceeds the supported size.'; end if;
    insert into public.garage_sheet_feedback_outputs(source_id,order_id,block_hash,block,complete)
      values(p_source_id,parent.id,public.garage_sheet_hash(block||complete::text),block,complete) on conflict do nothing;
    select coalesce(jsonb_agg(jsonb_build_object('block',f.block,'complete',f.complete) order by f.created_at,f.block_hash),'[]')
      into known from public.garage_sheet_feedback_outputs f where f.source_id=p_source_id and f.order_id=parent.id;
    scope:=jsonb_build_object('order',jsonb_build_object('vehicle',parent.vehicle,'vin',parent.vin,'colour',parent.colour,
      'vehicle_group_code',parent.vehicle_group_code,'planned_date',parent.planned_date,'due_date',parent.due_date,
      'priority',parent.priority,'manager_label',parent.manager_label),
      'tasks',coalesce((select jsonb_agg(jsonb_build_object('work_code',t.work_code,'options',t.options,'instructions',t.instructions)
        order by t.work_code,t.id) from public.garage_order_tasks t where t.order_id=parent.id and t.status<>'cancelled'),'[]'::jsonb));
    rows:=rows||jsonb_build_array(jsonb_build_object('order_id',parent.id,'order_number',parent.order_number,
      'order_version',parent.version,'source_keys',to_jsonb(keys),'complete',complete,'tasks',tasks,
      'block',block,'known_outputs',known,'operational_scope',scope));
  end loop;
  return jsonb_build_object('version',p_expected_version,'rows',rows);
end $$;
revoke all on function public.garage_sheet_feedback(uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.garage_sheet_feedback(uuid,uuid,integer) to service_role;
insert into public.garage_schema_migrations(version) values('20261116203249');
notify pgrst,'reload schema';
commit;
