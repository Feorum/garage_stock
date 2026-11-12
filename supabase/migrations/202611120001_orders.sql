-- Additive order workflow. Apply once after schema.sql, in a transaction.
-- Approved operational catalogue only: no actual rates or uploaded records.
begin;

alter table public.profiles add column if not exists active boolean not null default true;

-- Old installed daily-log clients must not bypass the ordered-task workflow.
-- Existing legacy rows remain readable under their original SELECT policy.
revoke insert, update, delete on public.jobs from anon, authenticated;
drop policy if exists "insert own jobs" on public.jobs;
drop policy if exists "delete own recent jobs" on public.jobs;

create table public.garage_schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
create table public.garage_works (
  code text primary key,
  name text not null check (length(btrim(name)) > 0),
  sort integer not null,
  active boolean not null default true
);
create table public.garage_vehicle_groups (
  code text primary key,
  name text not null check (length(btrim(name)) > 0),
  sort integer not null
);
create table public.garage_work_availability (
  vehicle_group_code text not null references public.garage_vehicle_groups(code),
  work_code text not null references public.garage_works(code),
  primary key (vehicle_group_code, work_code)
);

-- A row is one vehicle visit. It retains its own vehicle/model snapshot, so an
-- unverified or reused plate/VIN cannot merge different visits automatically.
create table public.garage_orders (
  id uuid primary key default gen_random_uuid(),
  order_no bigint generated always as identity unique,
  order_number text generated always as ('G-' || lpad(order_no::text, 6, '0')) stored,
  vehicle text not null check (length(btrim(vehicle)) between 1 and 200),
  vin text not null default '' check (length(vin) <= 40),
  colour text not null default '' check (length(colour) <= 80),
  vehicle_group_code text not null references public.garage_vehicle_groups(code),
  source text not null check (source in ('owner', 'manager')),
  manager_label text not null default '' check (length(manager_label) <= 120),
  status text not null default 'published' check (status in ('published', 'closed', 'cancelled')),
  instructions text not null default '' check (length(instructions) <= 4000),
  due_date date,
  planned_date date,
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  version integer not null default 1 check (version > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  cancellation_reason text
);
create table public.garage_order_tasks (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.garage_orders(id),
  work_code text not null references public.garage_works(code),
  work_name text not null,
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  instructions text not null default '' check (length(instructions) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'blocked', 'completed', 'cancelled')),
  assigned_to uuid references public.profiles(id),
  working_mechanic_id uuid references public.profiles(id),
  blocker_reason text not null default '',
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  check (status <> 'pending' or working_mechanic_id is null),
  check (status not in ('in_progress', 'blocked', 'completed') or working_mechanic_id is not null),
  check (status <> 'completed' or completed_at is not null)
);
create table public.garage_task_completions (
  task_id uuid primary key references public.garage_order_tasks(id),
  order_id uuid not null references public.garage_orders(id),
  mechanic_id uuid not null references public.profiles(id),
  work_code text not null,
  work_name text not null,
  completed_at timestamptz not null default now()
);
create table public.garage_task_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.garage_orders(id),
  task_id uuid references public.garage_order_tasks(id),
  actor_id uuid not null references public.profiles(id),
  action text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);
create table public.garage_requests (
  actor_id uuid not null references public.profiles(id),
  request_id uuid not null,
  payload jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, request_id)
);

-- These tables are intentionally separate from all mechanic-readable rows.
-- Real rates are loaded privately by the Owner after the migration.
create table public.garage_price_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  currency text not null default 'BYN' check (currency = 'BYN'),
  vat_rate numeric(5,4) not null default 0.20 check (vat_rate between 0 and 1),
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  effective_date date not null default current_date,
  created_at timestamptz not null default now()
);
create unique index garage_one_active_price_list on public.garage_price_lists ((status)) where status = 'active';
create table public.garage_price_matrix (
  price_list_id uuid not null references public.garage_price_lists(id),
  vehicle_group_code text not null,
  work_code text not null,
  net_amount numeric(12,2) not null check (net_amount >= 0),
  primary key (price_list_id, vehicle_group_code, work_code),
  foreign key (vehicle_group_code, work_code) references public.garage_work_availability(vehicle_group_code, work_code)
);
create table public.garage_task_financials (
  task_id uuid primary key references public.garage_order_tasks(id),
  price_list_id uuid references public.garage_price_lists(id),
  pricing_status text not null check (pricing_status in ('priced', 'needs_pricing')),
  net_amount numeric(12,2),
  vat_rate numeric(5,4),
  vat_amount numeric(12,2),
  gross_amount numeric(12,2),
  created_at timestamptz not null default now(),
  check (
    (pricing_status = 'needs_pricing' and price_list_id is null and net_amount is null and vat_rate is null and vat_amount is null and gross_amount is null)
    or (pricing_status = 'priced' and price_list_id is not null
      and net_amount is not null and vat_rate is not null and vat_amount is not null and gross_amount is not null
      and net_amount >= 0 and vat_rate between 0 and 1
      and vat_amount = round(net_amount * vat_rate, 2) and gross_amount = net_amount + vat_amount)
  )
);

create index garage_orders_source_status_idx on public.garage_orders(source, status, created_at desc);
create index garage_tasks_order_idx on public.garage_order_tasks(order_id, created_at, id);
create index garage_tasks_assignee_status_idx on public.garage_order_tasks(assigned_to, status);
create index garage_tasks_worker_status_idx on public.garage_order_tasks(working_mechanic_id, status);
create index garage_completions_mechanic_idx on public.garage_task_completions(mechanic_id, completed_at desc);
create index garage_events_order_idx on public.garage_task_events(order_id, created_at);

insert into public.garage_works(code,name,sort) values
  ('W01','капот полностью',1),
  ('W02','Бампер',2),
  ('W03','Полоса капот 45см.',3),
  ('W04','узкая полоса капот 25 см.',4),
  ('W05','крылья целиком (2шт)',5),
  ('W06','Часть крыльев  (2шт)',6),
  ('W07','Фары передние',7),
  ('W08','ПТФ',8),
  ('W09','Зона над лобовым',9),
  ('W10','Стойки лобового (2шт)',10),
  ('W11','Зона маникюра (4шт)',11),
  ('W12','Погрузочная зона 20 см*1м',12),
  ('W13','Зеркала',13),
  ('W14','нижняя часть передних дверей 25 см',14),
  ('W15','нижняя часть задних дверей  25 см',15),
  ('W16','канты дверей 4 шт',16),
  ('W17','пороги внутренние 4шт',17),
  ('W18','акрки 4 шт',18),
  ('W19','тонировка задней полусферы (5%,15%)',19);

insert into public.garage_vehicle_groups(code,name,sort) values
  ('VG01','е7',1),
  ('VG02','e7 new / S50',2),
  ('VG03','х7',3),
  ('VG04','атлас ФХ-11',4),
  ('VG05','атлас PRO \X70',5),
  ('VG06','атлас',6),
  ('VG07','Сityray',7),
  ('VG08','Coolray / X50/X50+',8),
  ('VG09','Х80',9),
  ('VG10','GS',10),
  ('VG11','Geometry C',11),
  ('VG12','Mongaro',12),
  ('VG13','Okovango 20-24',13),
  ('VG14','EX2',14),
  ('VG15','EX5',15),
  ('VG16','E8',16),
  ('VG17','Tugella',17);

insert into public.garage_work_availability(vehicle_group_code,work_code) values
  ('VG01','W01'),
  ('VG01','W02'),
  ('VG01','W03'),
  ('VG01','W04'),
  ('VG01','W06'),
  ('VG01','W07'),
  ('VG01','W08'),
  ('VG01','W09'),
  ('VG01','W10'),
  ('VG01','W11'),
  ('VG01','W12'),
  ('VG01','W13'),
  ('VG01','W14'),
  ('VG01','W15'),
  ('VG01','W16'),
  ('VG02','W01'),
  ('VG02','W02'),
  ('VG02','W03'),
  ('VG02','W04'),
  ('VG02','W05'),
  ('VG02','W06'),
  ('VG02','W07'),
  ('VG02','W08'),
  ('VG02','W09'),
  ('VG02','W10'),
  ('VG02','W11'),
  ('VG02','W12'),
  ('VG02','W13'),
  ('VG02','W14'),
  ('VG02','W15'),
  ('VG02','W16'),
  ('VG02','W17'),
  ('VG02','W18'),
  ('VG02','W19'),
  ('VG03','W01'),
  ('VG03','W02'),
  ('VG03','W03'),
  ('VG03','W04'),
  ('VG03','W06'),
  ('VG03','W07'),
  ('VG03','W08'),
  ('VG03','W09'),
  ('VG03','W10'),
  ('VG03','W11'),
  ('VG03','W12'),
  ('VG03','W13'),
  ('VG03','W14'),
  ('VG03','W15'),
  ('VG03','W16'),
  ('VG03','W17'),
  ('VG03','W19'),
  ('VG04','W01'),
  ('VG04','W02'),
  ('VG04','W03'),
  ('VG04','W04'),
  ('VG04','W05'),
  ('VG04','W06'),
  ('VG04','W07'),
  ('VG04','W09'),
  ('VG04','W10'),
  ('VG04','W11'),
  ('VG04','W12'),
  ('VG04','W13'),
  ('VG04','W14'),
  ('VG04','W15'),
  ('VG04','W16'),
  ('VG04','W17'),
  ('VG04','W19'),
  ('VG05','W01'),
  ('VG05','W02'),
  ('VG05','W03'),
  ('VG05','W04'),
  ('VG05','W05'),
  ('VG05','W06'),
  ('VG05','W07'),
  ('VG05','W09'),
  ('VG05','W10'),
  ('VG05','W11'),
  ('VG05','W13'),
  ('VG05','W14'),
  ('VG05','W15'),
  ('VG05','W16'),
  ('VG05','W17'),
  ('VG05','W19'),
  ('VG06','W01'),
  ('VG06','W02'),
  ('VG06','W03'),
  ('VG06','W04'),
  ('VG06','W06'),
  ('VG06','W07'),
  ('VG06','W08'),
  ('VG06','W09'),
  ('VG06','W10'),
  ('VG06','W11'),
  ('VG06','W12'),
  ('VG06','W13'),
  ('VG06','W14'),
  ('VG06','W15'),
  ('VG06','W16'),
  ('VG06','W17'),
  ('VG06','W19'),
  ('VG07','W01'),
  ('VG07','W02'),
  ('VG07','W03'),
  ('VG07','W04'),
  ('VG07','W05'),
  ('VG07','W06'),
  ('VG07','W07'),
  ('VG07','W09'),
  ('VG07','W10'),
  ('VG07','W11'),
  ('VG07','W12'),
  ('VG07','W13'),
  ('VG07','W14'),
  ('VG07','W15'),
  ('VG07','W16'),
  ('VG07','W17'),
  ('VG07','W19'),
  ('VG08','W01'),
  ('VG08','W02'),
  ('VG08','W03'),
  ('VG08','W04'),
  ('VG08','W05'),
  ('VG08','W06'),
  ('VG08','W07'),
  ('VG08','W08'),
  ('VG08','W09'),
  ('VG08','W10'),
  ('VG08','W11'),
  ('VG08','W12'),
  ('VG08','W13'),
  ('VG08','W14'),
  ('VG08','W15'),
  ('VG08','W16'),
  ('VG08','W17'),
  ('VG08','W19'),
  ('VG09','W01'),
  ('VG09','W02'),
  ('VG09','W03'),
  ('VG09','W04'),
  ('VG09','W05'),
  ('VG09','W06'),
  ('VG09','W07'),
  ('VG09','W08'),
  ('VG09','W09'),
  ('VG09','W10'),
  ('VG09','W11'),
  ('VG09','W12'),
  ('VG09','W13'),
  ('VG09','W14'),
  ('VG09','W15'),
  ('VG09','W16'),
  ('VG09','W17'),
  ('VG09','W19'),
  ('VG10','W01'),
  ('VG10','W02'),
  ('VG10','W03'),
  ('VG10','W04'),
  ('VG10','W06'),
  ('VG10','W07'),
  ('VG10','W09'),
  ('VG10','W10'),
  ('VG10','W11'),
  ('VG10','W12'),
  ('VG10','W13'),
  ('VG10','W14'),
  ('VG10','W15'),
  ('VG10','W16'),
  ('VG10','W17'),
  ('VG11','W01'),
  ('VG11','W02'),
  ('VG11','W03'),
  ('VG11','W04'),
  ('VG11','W06'),
  ('VG11','W07'),
  ('VG11','W08'),
  ('VG11','W09'),
  ('VG11','W10'),
  ('VG11','W11'),
  ('VG11','W12'),
  ('VG11','W13'),
  ('VG11','W14'),
  ('VG11','W15'),
  ('VG11','W16'),
  ('VG11','W17'),
  ('VG12','W01'),
  ('VG12','W02'),
  ('VG12','W03'),
  ('VG12','W04'),
  ('VG12','W05'),
  ('VG12','W06'),
  ('VG12','W07'),
  ('VG12','W08'),
  ('VG12','W09'),
  ('VG12','W10'),
  ('VG12','W11'),
  ('VG12','W12'),
  ('VG12','W13'),
  ('VG12','W16'),
  ('VG12','W17'),
  ('VG12','W19'),
  ('VG13','W01'),
  ('VG13','W02'),
  ('VG13','W03'),
  ('VG13','W04'),
  ('VG13','W05'),
  ('VG13','W06'),
  ('VG13','W07'),
  ('VG13','W08'),
  ('VG13','W09'),
  ('VG13','W10'),
  ('VG13','W11'),
  ('VG13','W12'),
  ('VG13','W13'),
  ('VG13','W16'),
  ('VG13','W17'),
  ('VG13','W19'),
  ('VG14','W01'),
  ('VG14','W02'),
  ('VG14','W03'),
  ('VG14','W04'),
  ('VG14','W06'),
  ('VG14','W07'),
  ('VG14','W08'),
  ('VG14','W09'),
  ('VG14','W10'),
  ('VG14','W11'),
  ('VG14','W12'),
  ('VG14','W13'),
  ('VG14','W14'),
  ('VG14','W15'),
  ('VG14','W16'),
  ('VG14','W17'),
  ('VG14','W19'),
  ('VG15','W01'),
  ('VG15','W02'),
  ('VG15','W03'),
  ('VG15','W04'),
  ('VG15','W05'),
  ('VG15','W06'),
  ('VG15','W07'),
  ('VG15','W09'),
  ('VG15','W10'),
  ('VG15','W11'),
  ('VG15','W12'),
  ('VG15','W13'),
  ('VG15','W14'),
  ('VG15','W15'),
  ('VG15','W16'),
  ('VG15','W17'),
  ('VG16','W01'),
  ('VG16','W02'),
  ('VG16','W03'),
  ('VG16','W04'),
  ('VG16','W05'),
  ('VG16','W06'),
  ('VG16','W07'),
  ('VG16','W09'),
  ('VG16','W10'),
  ('VG16','W11'),
  ('VG16','W12'),
  ('VG16','W13'),
  ('VG16','W14'),
  ('VG16','W15'),
  ('VG16','W16'),
  ('VG16','W17'),
  ('VG17','W01'),
  ('VG17','W02'),
  ('VG17','W03'),
  ('VG17','W04'),
  ('VG17','W05'),
  ('VG17','W06'),
  ('VG17','W07'),
  ('VG17','W09'),
  ('VG17','W10'),
  ('VG17','W11'),
  ('VG17','W12'),
  ('VG17','W13'),
  ('VG17','W14'),
  ('VG17','W15'),
  ('VG17','W16'),
  ('VG17','W17'),
  ('VG17','W19');

create function public.garage_require_actor() returns uuid
language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not exists (select 1 from public.profiles where id = actor and active and role in ('admin', 'mechanic')) then
    raise exception using errcode = '42501', message = 'An active workshop account is required.';
  end if;
  return actor;
end $$;

create function public.garage_is_owner() returns boolean
language sql security definer stable set search_path = pg_catalog, public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- Mutations hold a SHARE lock on account access until commit. A concurrent
-- deactivation/role change must then observe any newly assigned or claimed work.
create function public.garage_lock_actor() returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare actor uuid := auth.uid(); selected_profile public.profiles%rowtype;
begin
  select * into selected_profile from public.profiles where id = actor for share;
  if not found or not selected_profile.active or selected_profile.role not in ('admin','mechanic') then
    raise exception using errcode = '42501', message = 'An active workshop account is required.';
  end if;
  return actor;
end $$;

create function public.garage_lock_mechanic(p_mechanic uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare selected_profile public.profiles%rowtype;
begin
  select * into selected_profile from public.profiles where id = p_mechanic for share;
  if not found or not selected_profile.active or selected_profile.role <> 'mechanic' then
    raise exception 'Choose an active mechanic.';
  end if;
end $$;

create function public.garage_can_view_order(p_order_id uuid) returns boolean
language sql security definer stable set search_path = pg_catalog, public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and (
    p.role = 'admin' or (p.role = 'mechanic' and (
      exists (select 1 from public.garage_orders o where o.id = p_order_id and o.source = 'manager' and o.status = 'published')
      or exists (select 1 from public.garage_order_tasks t where t.order_id = p_order_id
        and (t.assigned_to = p.id or t.working_mechanic_id = p.id))
      or exists (select 1 from public.garage_task_completions c where c.order_id = p_order_id and c.mechanic_id = p.id)
    ))
  ));
$$;

create function public.garage_can_view_task(p_task_id uuid) returns boolean
language sql security definer stable set search_path = pg_catalog, public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and (
    p.role = 'admin' or (p.role = 'mechanic' and exists (
      select 1 from public.garage_order_tasks t join public.garage_orders o on o.id = t.order_id
      where t.id = p_task_id and (t.assigned_to = p.id or t.working_mechanic_id = p.id
        or (o.source = 'manager' and o.status = 'published'))
    ))
  ));
$$;

create function public.garage_begin_request(p_request_id uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare actor uuid := public.garage_require_actor(); receipt public.garage_requests%rowtype;
begin
  if p_request_id is null then raise exception 'A request ID is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':' || p_request_id::text, 0));
  select * into receipt from public.garage_requests where actor_id = actor and request_id = p_request_id;
  if found then
    if receipt.payload is distinct from p_payload then raise exception 'This request ID was already used for a different operation.'; end if;
    return receipt.response;
  end if;
  return null;
end $$;

create function public.garage_finish_request(p_request_id uuid, p_payload jsonb, p_response jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.garage_requests(actor_id, request_id, payload, response) values (auth.uid(), p_request_id, p_payload, p_response);
  return p_response;
end $$;

create function public.garage_snapshot_task(p_task_id uuid, p_vehicle_group_code text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare selected_price record;
begin
  -- Freeze the chosen version against concurrent publication or matrix edits.
  -- The next SELECT gets a fresh committed snapshot after acquiring that lock.
  select l.id,l.vat_rate into selected_price from public.garage_price_lists l
    where l.status='active' and l.effective_date<=current_date for share;
  if found then
    select l.id,l.vat_rate,m.net_amount into selected_price
      from public.garage_price_lists l join public.garage_price_matrix m on m.price_list_id=l.id
      join public.garage_order_tasks t on t.id=p_task_id and t.work_code=m.work_code
      where l.id=selected_price.id and m.vehicle_group_code=p_vehicle_group_code;
  end if;
  if found then
    insert into public.garage_task_financials(task_id, price_list_id, pricing_status, net_amount, vat_rate, vat_amount, gross_amount)
    values (p_task_id, selected_price.id, 'priced', selected_price.net_amount, selected_price.vat_rate,
      round(selected_price.net_amount * selected_price.vat_rate, 2), selected_price.net_amount + round(selected_price.net_amount * selected_price.vat_rate, 2));
  else
    insert into public.garage_task_financials(task_id, pricing_status) values (p_task_id, 'needs_pricing');
  end if;
end $$;

create function public.garage_staff() returns jsonb
language plpgsql security definer stable set search_path = pg_catalog, public as $$
begin
  perform public.garage_require_actor();
  if not public.is_admin() then raise exception using errcode = '42501', message = 'Only the Owner can view the assignment directory.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name, id)
    from public.profiles where role = 'mechanic' and active), '[]'::jsonb);
end $$;

create function public.garage_list_orders() returns jsonb
language plpgsql security definer stable set search_path = pg_catalog, public as $$
begin
  perform public.garage_require_actor();
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', o.id, 'order_number', o.order_number, 'vehicle', o.vehicle, 'vin', o.vin, 'colour', o.colour,
    'vehicle_group_code', o.vehicle_group_code, 'vehicle_group_name', g.name,
    'source', o.source, 'manager_label', o.manager_label, 'status', o.status, 'instructions', o.instructions,
    'due_date', o.due_date, 'planned_date', o.planned_date, 'priority', o.priority, 'version', o.version, 'created_at', o.created_at,
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'work_code', t.work_code, 'work_name', t.work_name, 'options', t.options, 'instructions', t.instructions,
      'status', t.status, 'assigned_to', t.assigned_to, 'assigned_name', a.name,
      'working_mechanic_id', t.working_mechanic_id, 'working_name', w.name,
      'blocker_reason', t.blocker_reason, 'version', t.version, 'completed_at', t.completed_at
    ) order by t.created_at, t.id) from public.garage_order_tasks t
      left join public.profiles a on a.id = t.assigned_to left join public.profiles w on w.id = t.working_mechanic_id
      where t.order_id = o.id and public.garage_can_view_task(t.id)), '[]'::jsonb)
    ) order by o.created_at desc, o.order_no desc)
    from public.garage_orders o join public.garage_vehicle_groups g on g.code = o.vehicle_group_code
    where public.garage_can_view_order(o.id)), '[]'::jsonb);
end $$;

create function public.garage_create_order(
  p_vehicle text, p_vehicle_group_code text, p_source text, p_tasks jsonb, p_request_id uuid,
  p_instructions text default '', p_due_date date default null, p_priority text default 'normal',
  p_vin text default '', p_colour text default '', p_manager_label text default '', p_planned_date date default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor uuid := public.garage_lock_actor(); payload jsonb; cached jsonb;
  created_order public.garage_orders%rowtype; item jsonb; chosen_work public.garage_works%rowtype;
  assignee uuid; created_task uuid; task_options jsonb;
begin
  if not public.is_admin() then raise exception using errcode = '42501', message = 'Only the Owner can create an order.'; end if;
  payload := jsonb_build_object('operation','create','vehicle',p_vehicle,'group',p_vehicle_group_code,'source',p_source,
    'tasks',p_tasks,'instructions',p_instructions,'due_date',p_due_date,'planned_date',p_planned_date,'priority',p_priority,'vin',p_vin,'colour',p_colour,'manager',p_manager_label);
  cached := public.garage_begin_request(p_request_id, payload);
  if cached is not null then return cached; end if;
  if p_source is null or p_source not in ('owner', 'manager') then raise exception 'Choose Owner or Manager as the order source.'; end if;
  if p_vehicle is null or length(btrim(p_vehicle)) not between 1 and 200 then raise exception 'Enter a vehicle identifier of up to 200 characters.'; end if;
  if p_priority is null or p_priority not in ('normal', 'high', 'urgent') then raise exception 'Choose a supported priority.'; end if;
  if p_tasks is null or jsonb_typeof(p_tasks) <> 'array' then raise exception 'An order needs an authorized work list.'; end if;
  if jsonb_array_length(p_tasks) not between 1 and 50 then raise exception 'Choose between 1 and 50 ordered tasks.'; end if;
  if not exists (select 1 from public.garage_vehicle_groups where code = p_vehicle_group_code) then raise exception 'Choose an approved vehicle group.'; end if;
  if length(coalesce(p_instructions,'')) > 4000 or length(coalesce(p_vin,'')) > 40
    or length(coalesce(p_colour,'')) > 80 or length(coalesce(p_manager_label,'')) > 120 then raise exception 'An order field is too long.'; end if;

  insert into public.garage_orders(vehicle, vin, colour, vehicle_group_code, source, manager_label, instructions, due_date, planned_date, priority, created_by)
  values (btrim(p_vehicle), upper(btrim(coalesce(p_vin,''))), btrim(coalesce(p_colour,'')), p_vehicle_group_code, p_source,
    case when p_source = 'manager' then btrim(coalesce(p_manager_label,'')) else '' end,
    btrim(coalesce(p_instructions,'')), p_due_date, p_planned_date, p_priority, actor) returning * into created_order;

  for item in select value from jsonb_array_elements(p_tasks) loop
    if jsonb_typeof(item) <> 'object' or exists (select 1 from jsonb_object_keys(item) k
      where k not in ('work_code','assigned_to','instructions','options')) then raise exception 'Task fields are not supported.'; end if;
    select * into chosen_work from public.garage_works where code = item->>'work_code' and active;
    if not found or not exists (select 1 from public.garage_work_availability
      where vehicle_group_code = p_vehicle_group_code and work_code = chosen_work.code) then
      raise exception 'The selected work is unavailable for this vehicle group.';
    end if;
    task_options := coalesce(item->'options','{}'::jsonb);
    if chosen_work.code = 'W19' then
      if task_options not in ('{"tint_percent":5}'::jsonb, '{"tint_percent":15}'::jsonb) then raise exception 'Choose an approved tint level: 5%% or 15%%.'; end if;
    elsif task_options <> '{}'::jsonb then raise exception 'Options are not supported for this work.'; end if;
    if length(coalesce(item->>'instructions','')) > 2000 then raise exception 'Task instructions are too long.'; end if;
    assignee := nullif(item->>'assigned_to','')::uuid;
    if p_source = 'owner' then
      perform public.garage_lock_mechanic(assignee);
    elsif assignee is not null then raise exception 'Manager tasks belong to the shared queue and cannot have a mandatory assignee.';
    end if;
    insert into public.garage_order_tasks(order_id, work_code, work_name, options, instructions, assigned_to)
    values (created_order.id, chosen_work.code, chosen_work.name, task_options, btrim(coalesce(item->>'instructions','')), assignee)
    returning id into created_task;
    perform public.garage_snapshot_task(created_task, p_vehicle_group_code);
    insert into public.garage_task_events(order_id, task_id, actor_id, action) values (created_order.id, created_task, actor, 'created');
  end loop;
  return public.garage_finish_request(p_request_id, payload,
    jsonb_build_object('order_id', created_order.id, 'order_number', created_order.order_number, 'status', created_order.status));
end $$;

create function public.garage_task_action(
  p_task_id uuid, p_action text, p_expected_version integer, p_request_id uuid,
  p_note text default '', p_assignee uuid default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor uuid := public.garage_lock_actor(); owner boolean := public.is_admin(); payload jsonb; cached jsonb;
  selected_order public.garage_orders%rowtype; selected_task public.garage_order_tasks%rowtype; parent uuid;
begin
  payload := jsonb_build_object('operation','task','task_id',p_task_id,'action',p_action,'version',p_expected_version,'note',p_note,'assignee',p_assignee);
  cached := public.garage_begin_request(p_request_id, payload);
  if cached is not null then return cached; end if;
  if p_action is null or p_action not in ('start','block','resume','complete','release','cancel','reassign') then raise exception 'This task action is not supported.'; end if;
  if p_expected_version is null or p_expected_version < 1 then raise exception 'Refresh the task before trying again.'; end if;
  if length(coalesce(p_note,'')) > 2000 then raise exception 'The action note is too long.'; end if;
  select order_id into parent from public.garage_order_tasks where id = p_task_id;
  if parent is null then raise exception using errcode = '42501', message = 'This task is unavailable to your account.'; end if;
  -- Lock parent first for every mutation, including cancel/close and new claims.
  select * into selected_order from public.garage_orders where id = parent for update;
  select * into selected_task from public.garage_order_tasks where id = p_task_id for update;
  if not public.garage_can_view_task(p_task_id) then raise exception using errcode = '42501', message = 'This task is unavailable to your account.'; end if;
  if selected_order.status <> 'published' then raise exception 'This order is no longer open.'; end if;
  if selected_task.version <> p_expected_version then raise exception using errcode = '40001', message = 'This task changed. Refresh and try again.'; end if;
  if selected_task.status in ('completed','cancelled') then raise exception 'This task is already finished.'; end if;
  if p_assignee is not null and p_action <> 'reassign' then raise exception 'An assignee cannot be supplied for this action.'; end if;

  if p_action = 'start' then
    if owner then raise exception 'Assigned work must be started by its mechanic.'; end if;
    if selected_task.status <> 'pending' then raise exception 'This task has already been taken.'; end if;
    if selected_order.source = 'owner' and selected_task.assigned_to is distinct from actor then
      raise exception using errcode = '42501', message = 'Only the assigned mechanic can start this task.';
    end if;
    update public.garage_order_tasks set status = 'in_progress', working_mechanic_id = actor,
      started_at = coalesce(started_at, now()), blocker_reason = '', version = version + 1 where id = p_task_id;
  elsif p_action = 'reassign' then
    if not owner then raise exception using errcode = '42501', message = 'Only the Owner can reassign work.'; end if;
    if length(btrim(coalesce(p_note,''))) = 0 then raise exception 'Give a reason for reassignment.'; end if;
    perform public.garage_lock_mechanic(p_assignee);
    if selected_order.source = 'manager' then
      if selected_task.status not in ('in_progress','blocked') then raise exception 'Pending Manager work must remain available for self-selection.'; end if;
      update public.garage_order_tasks set working_mechanic_id = p_assignee, version = version + 1 where id = p_task_id;
    else
      update public.garage_order_tasks set assigned_to = p_assignee,
      working_mechanic_id = case when status in ('in_progress','blocked') then p_assignee else null end,
      version = version + 1 where id = p_task_id;
    end if;
  elsif p_action = 'cancel' then
    if not owner then raise exception using errcode = '42501', message = 'Only the Owner can cancel work.'; end if;
    if length(btrim(coalesce(p_note,''))) = 0 then raise exception 'Give a reason for cancellation.'; end if;
    update public.garage_order_tasks set status = 'cancelled', version = version + 1 where id = p_task_id;
  else
    if owner or selected_task.working_mechanic_id is distinct from actor then
      raise exception using errcode = '42501', message = 'Only the current mechanic can perform this action.';
    end if;
    if p_action = 'block' then
      if selected_task.status <> 'in_progress' then raise exception 'Only work in progress can be blocked.'; end if;
      if length(btrim(coalesce(p_note,''))) = 0 then raise exception 'Describe what is blocking this work.'; end if;
      update public.garage_order_tasks set status = 'blocked', blocker_reason = btrim(p_note), version = version + 1 where id = p_task_id;
    elsif p_action = 'resume' then
      if selected_task.status <> 'blocked' then raise exception 'Only blocked work can be resumed.'; end if;
      update public.garage_order_tasks set status = 'in_progress', blocker_reason = '', version = version + 1 where id = p_task_id;
    elsif p_action = 'release' then
      if selected_order.source <> 'manager' then raise exception 'Owner assignments cannot be released into the shared queue.'; end if;
      if selected_task.status not in ('in_progress','blocked') then raise exception 'Only your active work can be released.'; end if;
      if length(btrim(coalesce(p_note,''))) = 0 then raise exception 'Give a reason for releasing this work.'; end if;
      update public.garage_order_tasks set status = 'pending', working_mechanic_id = null,
        blocker_reason = '', version = version + 1 where id = p_task_id;
    elsif p_action = 'complete' then
      if selected_task.status <> 'in_progress' then raise exception 'Resume this work before marking it completed.'; end if;
      update public.garage_order_tasks set status = 'completed', completed_at = now(), blocker_reason = '', version = version + 1 where id = p_task_id;
      insert into public.garage_task_completions(task_id, order_id, mechanic_id, work_code, work_name)
      values (p_task_id, parent, actor, selected_task.work_code, selected_task.work_name);
    end if;
  end if;
  insert into public.garage_task_events(order_id, task_id, actor_id, action, note)
  values (parent, p_task_id, actor, p_action, btrim(coalesce(p_note,'')));
  -- Any transition invalidates a previously opened order-level action dialog.
  update public.garage_orders set version = version + 1 where id = parent;
  select * into selected_task from public.garage_order_tasks where id = p_task_id;
  return public.garage_finish_request(p_request_id, payload,
    jsonb_build_object('task_id', p_task_id, 'status', selected_task.status, 'version', selected_task.version));
end $$;

create function public.garage_order_action(
  p_order_id uuid, p_action text, p_expected_version integer, p_request_id uuid, p_note text default ''
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare actor uuid := public.garage_lock_actor(); payload jsonb; cached jsonb; selected_order public.garage_orders%rowtype;
begin
  if not public.is_admin() then raise exception using errcode = '42501', message = 'Only the Owner can close or cancel orders.'; end if;
  payload := jsonb_build_object('operation','order','order_id',p_order_id,'action',p_action,'version',p_expected_version,'note',p_note);
  cached := public.garage_begin_request(p_request_id, payload);
  if cached is not null then return cached; end if;
  if p_action is null or p_action not in ('close','cancel') then raise exception 'This order action is not supported.'; end if;
  if p_expected_version is null or p_expected_version < 1 then raise exception 'Refresh the order before trying again.'; end if;
  if length(coalesce(p_note,'')) > 2000 then raise exception 'The action note is too long.'; end if;
  select * into selected_order from public.garage_orders where id = p_order_id for update;
  if not found then raise exception 'This order is unavailable.'; end if;
  if selected_order.version <> p_expected_version then raise exception using errcode = '40001', message = 'This order changed. Refresh and try again.'; end if;
  if selected_order.status <> 'published' then raise exception 'This order is already closed or cancelled.'; end if;
  perform 1 from public.garage_order_tasks where order_id = p_order_id order by id for update;
  if p_action = 'close' then
    if exists (select 1 from public.garage_order_tasks where order_id = p_order_id and status not in ('completed','cancelled')) then raise exception 'Complete or explicitly cancel all remaining tasks before closing the order.'; end if;
    if not exists (select 1 from public.garage_order_tasks where order_id = p_order_id and status = 'completed') then raise exception 'An order with no completed work must be cancelled rather than closed.'; end if;
    update public.garage_orders set status = 'closed', closed_at = now(), version = version + 1 where id = p_order_id;
  else
    if length(btrim(coalesce(p_note,''))) = 0 then raise exception 'Give a reason for cancellation.'; end if;
    insert into public.garage_task_events(order_id, task_id, actor_id, action, note)
      select p_order_id, id, actor, 'cancel', btrim(p_note) from public.garage_order_tasks
      where order_id = p_order_id and status not in ('completed','cancelled');
    update public.garage_order_tasks set status = 'cancelled', version = version + 1
      where order_id = p_order_id and status not in ('completed','cancelled');
    update public.garage_orders set status = 'cancelled', cancellation_reason = btrim(p_note), closed_at = now(), version = version + 1 where id = p_order_id;
  end if;
  insert into public.garage_task_events(order_id, actor_id, action, note) values (p_order_id, actor, p_action, btrim(coalesce(p_note,'')));
  return public.garage_finish_request(p_request_id, payload, jsonb_build_object('order_id',p_order_id,'status',case when p_action='close' then 'closed' else 'cancelled' end,'version',selected_order.version+1));
end $$;

create function public.garage_order_financials(p_order_id uuid) returns jsonb
language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare task_values jsonb; missing boolean; net numeric; vat numeric; gross numeric;
begin
  perform public.garage_require_actor();
  if not public.is_admin() then raise exception using errcode = '42501', message = 'Only the Owner can access financial information.'; end if;
  if not exists (select 1 from public.garage_orders where id = p_order_id) then raise exception 'This order is unavailable.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('task_id',t.id,'status',f.pricing_status,'net_amount',f.net_amount,
      'vat_amount',f.vat_amount,'gross_amount',f.gross_amount) order by t.created_at,t.id), '[]'::jsonb),
    coalesce(bool_or(f.pricing_status <> 'priced' or f.task_id is null),false),
    coalesce(sum(f.net_amount),0),coalesce(sum(f.vat_amount),0),coalesce(sum(f.gross_amount),0)
  into task_values, missing, net, vat, gross from public.garage_order_tasks t
    left join public.garage_task_financials f on f.task_id = t.id
    where t.order_id = p_order_id and t.status <> 'cancelled';
  return jsonb_build_object('currency','BYN','status',case when missing then 'needs_pricing' else 'priced' end,
    'net_amount',case when missing then null else net end,'vat_amount',case when missing then null else vat end,
    'gross_amount',case when missing then null else gross end,'tasks',task_values);
end $$;

create function public.garage_protect_price_version() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare selected_version uuid;
begin
  if tg_table_name = 'garage_price_matrix' then
    selected_version := case when tg_op = 'DELETE' then old.price_list_id else new.price_list_id end;
    perform 1 from public.garage_price_lists where id=selected_version for update;
    if tg_op='UPDATE' and old.price_list_id<>new.price_list_id then
      raise exception 'Move a rate by publishing a new price-list version.';
    end if;
    if exists (select 1 from public.garage_task_financials where price_list_id = selected_version)
      or (tg_op = 'UPDATE' and exists (select 1 from public.garage_task_financials where price_list_id = old.price_list_id)) then
      raise exception 'This price-list version is already used. Publish a new version instead.';
    end if;
  elsif exists (select 1 from public.garage_task_financials where price_list_id = old.id) then
    if tg_op = 'DELETE' then raise exception 'A used price-list version must remain in history.'; end if;
    if row(new.name,new.source_sha256,new.currency,new.vat_rate,new.effective_date)
      is distinct from row(old.name,old.source_sha256,old.currency,old.vat_rate,old.effective_date) then
      raise exception 'This price-list version is already used. Publish a new version instead.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger garage_price_list_history before update or delete on public.garage_price_lists
  for each row execute function public.garage_protect_price_version();
create trigger garage_matrix_history before insert or update or delete on public.garage_price_matrix
  for each row execute function public.garage_protect_price_version();

create function public.garage_protect_active_assignments() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if old.role = 'mechanic' and (not new.active or new.role <> 'mechanic') and exists (
    select 1 from public.garage_order_tasks where status in ('pending','in_progress','blocked')
      and (assigned_to = old.id or working_mechanic_id = old.id)
  ) then raise exception 'Resolve this mechanic''s outstanding work before changing account access.'; end if;
  return new;
end $$;
create trigger garage_profile_assignments before update of role,active on public.profiles
  for each row execute function public.garage_protect_active_assignments();

-- Default Supabase privileges must not create uncontrolled write paths.
do $$ declare t text; begin
  foreach t in array array['garage_schema_migrations','garage_works','garage_vehicle_groups','garage_work_availability',
    'garage_orders','garage_order_tasks','garage_task_completions','garage_task_events','garage_requests',
    'garage_price_lists','garage_price_matrix','garage_task_financials'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public, anon, authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;
end $$;
grant select on public.garage_works,public.garage_vehicle_groups,public.garage_work_availability,
  public.garage_orders,public.garage_order_tasks,public.garage_task_completions,public.garage_task_events,
  public.garage_price_lists,public.garage_price_matrix,public.garage_task_financials to authenticated;
create policy garage_catalogue_read on public.garage_works for select to authenticated using (auth.uid() is not null);
create policy garage_groups_read on public.garage_vehicle_groups for select to authenticated using (auth.uid() is not null);
create policy garage_availability_read on public.garage_work_availability for select to authenticated using (auth.uid() is not null);
create policy garage_orders_read on public.garage_orders for select to authenticated using (public.garage_can_view_order(id));
create policy garage_tasks_read on public.garage_order_tasks for select to authenticated using (public.garage_can_view_task(id));
create policy garage_completions_read on public.garage_task_completions for select to authenticated using (public.garage_is_owner() or (mechanic_id = auth.uid() and public.garage_can_view_task(task_id)));
create policy garage_events_read on public.garage_task_events for select to authenticated using (
  public.garage_is_owner() or (actor_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and active))
  or (task_id is not null and public.garage_can_view_task(task_id)));
create policy garage_lists_owner on public.garage_price_lists for select to authenticated using (public.garage_is_owner());
create policy garage_matrix_owner on public.garage_price_matrix for select to authenticated using (public.garage_is_owner());
create policy garage_financials_owner on public.garage_task_financials for select to authenticated using (public.garage_is_owner());

-- Helpers that mutate or reveal internal payloads are never callable by clients.
revoke all on function public.garage_require_actor(), public.garage_begin_request(uuid,jsonb),
  public.garage_lock_actor(),public.garage_lock_mechanic(uuid),
  public.garage_finish_request(uuid,jsonb,jsonb), public.garage_snapshot_task(uuid,text),
  public.garage_protect_price_version(),public.garage_protect_active_assignments() from public,anon,authenticated;
revoke all on function public.garage_is_owner(),public.garage_can_view_order(uuid),public.garage_can_view_task(uuid),public.garage_staff(),public.garage_list_orders(),
  public.garage_create_order(text,text,text,jsonb,uuid,text,date,text,text,text,text,date),
  public.garage_task_action(uuid,text,integer,uuid,text,uuid), public.garage_order_action(uuid,text,integer,uuid,text),
  public.garage_order_financials(uuid) from public,anon;
grant execute on function public.garage_is_owner(),public.garage_can_view_order(uuid),public.garage_can_view_task(uuid),public.garage_staff(),public.garage_list_orders(),
  public.garage_create_order(text,text,text,jsonb,uuid,text,date,text,text,text,text,date),
  public.garage_task_action(uuid,text,integer,uuid,text,uuid), public.garage_order_action(uuid,text,integer,uuid,text),
  public.garage_order_financials(uuid) to authenticated;

insert into public.garage_schema_migrations(version) values ('202611120001');
commit;
