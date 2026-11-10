-- Garage Daily Log: database schema for Supabase (run in SQL Editor)

create table profiles (
  id   uuid primary key references auth.users on delete cascade,
  name text not null,
  role text not null default 'mechanic' check (role in ('admin','mechanic'))
);
create table works (
  id     bigint generated always as identity primary key,
  name   text not null,
  sort   int  not null default 0,
  active boolean not null default true
);
-- Prices live in their OWN table so mechanics can never read them
create table work_prices (
  work_id bigint primary key references works on delete cascade,
  price   numeric(10,2) not null default 0
);
create table jobs (
  id          bigint generated always as identity primary key,
  mechanic_id uuid   not null default auth.uid() references profiles(id),
  job_date    date   not null default current_date,
  car         text   not null,
  work_id     bigint not null references works,
  created_at  timestamptz not null default now()
);
create index jobs_date_idx on jobs(job_date);

-- Helper: is the current user an admin?
create function is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

-- Every new auth user automatically gets a mechanic profile
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles(id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Row Level Security: the server enforces who sees what
alter table profiles    enable row level security;
alter table works       enable row level security;
alter table work_prices enable row level security;
alter table jobs        enable row level security;

create policy "own profile or admin" on profiles for select
  using (id = auth.uid() or is_admin());

create policy "everyone reads works" on works for select to authenticated using (true);
create policy "admin writes works" on works for all
  using (is_admin()) with check (is_admin());

create policy "admin only prices" on work_prices for all
  using (is_admin()) with check (is_admin());

create policy "read own jobs or admin" on jobs for select
  using (mechanic_id = auth.uid() or is_admin());
create policy "insert own jobs" on jobs for insert
  with check (mechanic_id = auth.uid() and job_date between current_date - 1 and current_date + 1);
create policy "delete own recent jobs" on jobs for delete
  using (mechanic_id = auth.uid() and job_date >= current_date - 1);

-- Admin report: jobs joined with prices (only returns rows for admins)
create function admin_report(d date)
returns table (mechanic text, car text, work text, price numeric)
language sql security definer stable set search_path = public as $$
  select p.name, j.car, w.name, coalesce(wp.price, 0)
  from jobs j
  join profiles p on p.id = j.mechanic_id
  join works w on w.id = j.work_id
  left join work_prices wp on wp.work_id = w.id
  where j.job_date = d and is_admin()
  order by p.name, j.car, j.id
$$;
revoke execute on function admin_report(date) from public, anon;
grant  execute on function admin_report(date) to authenticated;

-- Sample work list with fictitious prices (EUR)
insert into works(name, sort) values
 ('Engine oil & filter change',1),('Brake pads replacement (front)',2),('Brake discs replacement (front)',3),
 ('Tire change & wheel balancing',4),('Wheel alignment',5),('Timing belt replacement',6),
 ('Spark plugs replacement',7),('Air & cabin filter replacement',8),('Battery replacement',9),
 ('Clutch replacement',10),('Shock absorbers (pair)',11),('A/C service & refill',12),
 ('Engine diagnostics (OBD)',13),('Exhaust muffler replacement',14),('Coolant flush',15),
 ('Alternator replacement',16),('Headlight bulb replacement',17),('Gearbox oil change',18),
 ('Wiper replacement',19),('Full vehicle inspection',20);
insert into work_prices(work_id, price)
select w.id, v.price from works w join (values
 ('Engine oil & filter change',65),('Brake pads replacement (front)',180),('Brake discs replacement (front)',290),
 ('Tire change & wheel balancing',70),('Wheel alignment',85),('Timing belt replacement',420),
 ('Spark plugs replacement',95),('Air & cabin filter replacement',55),('Battery replacement',120),
 ('Clutch replacement',780),('Shock absorbers (pair)',460),('A/C service & refill',130),
 ('Engine diagnostics (OBD)',60),('Exhaust muffler replacement',240),('Coolant flush',75),
 ('Alternator replacement',350),('Headlight bulb replacement',35),('Gearbox oil change',150),
 ('Wiper replacement',25),('Full vehicle inspection',110)
) as v(name, price) on v.name = w.name;
