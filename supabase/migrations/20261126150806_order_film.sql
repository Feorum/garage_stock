begin;

-- Revisions are also the on-disk bytes of one private, append-only JSON Lines file.
-- Persist the byte ranges with the amount so that a correction and the file cannot diverge.
create table garage_pay.film_file (
  name text primary key check (name = 'film-patterns.jsonl'),
  size_bytes bigint not null default 0 check (size_bytes >= 0)
);
insert into garage_pay.film_file (name) values ('film-patterns.jsonl');

create table garage_pay.film_revisions (
  order_id uuid not null references public.garage_orders(id),
  version integer not null check (version > 0),
  request_id uuid not null unique,
  request jsonb not null,
  response jsonb not null,
  byte_start bigint not null unique,
  bytes bytea not null check (octet_length(bytes) > 0),
  byte_end bigint generated always as (byte_start + octet_length(bytes)) stored,
  primary key (order_id, version)
);
create index film_revisions_byte_end_idx on garage_pay.film_revisions(byte_end);
alter table garage_pay.film_file enable row level security;
alter table garage_pay.film_revisions enable row level security;
revoke all on garage_pay.film_file, garage_pay.film_revisions from public, anon, authenticated, service_role;

create function garage_pay.film_percent(amount bigint, price bigint) returns numeric
language sql immutable set search_path = pg_catalog as $$
  select round(amount::numeric * 100 / nullif(price, 0), 2)
$$;

create function garage_pay.order_film(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog as $$
declare
  saved jsonb;
  model public.garage_orders%rowtype;
  terms garage_pay.commercial_terms%rowtype;
  quote jsonb;
  order_price bigint;
  amount bigint;
begin
  if not public.garage_is_owner() then
    raise exception using errcode = '42501', message = 'Owner access required.';
  end if;
  select * into model from public.garage_orders where id = p_order_id;
  if not found then
    raise exception using errcode = '22023', message = 'Standard order unavailable.';
  end if;
  select * into strict terms from garage_pay.commercial_terms where order_id = p_order_id;
  select response into saved from garage_pay.film_revisions
    where order_id = p_order_id order by version desc limit 1;

  with lines as (
    select t.*, l.internal_price_kopeks as price,
      (saved->'work_amounts'->>t.id::text)::bigint as film
    from garage_pay.commercial_lines(p_order_id) l
    join public.garage_order_tasks t on t.id = l.task_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'task_id', id, 'name', work_name, 'work_code', work_code, 'status', status, 'options', options,
      'price_kopeks', price, 'amount_kopeks', film, 'percent', garage_pay.film_percent(film, price)
    ) order by created_at, id), '[]'::jsonb)
  into quote from lines;
  order_price := garage_pay.internal_total_kopeks(p_order_id);
  amount := (saved->>'amount_kopeks')::bigint;
  return jsonb_build_object(
    'version', coalesce(saved->'version', '0'::jsonb),
    'price_token', md5(jsonb_build_array(model.vehicle, model.vehicle_group_code, model.status,
      terms.basis, order_price, (select jsonb_agg(q - 'amount_kopeks' - 'percent') from jsonb_array_elements(quote) q))::text),
    'mode', coalesce(saved->>'mode', 'order'),
    'order_price_kopeks', order_price, 'amount_kopeks', amount,
    'percent', garage_pay.film_percent(amount, order_price),
    'lines', quote, 'editable', model.status <> 'cancelled',
    'price_changed', saved is not null and (saved->>'order_price_kopeks' is distinct from order_price::text
      or exists (select 1 from jsonb_array_elements(saved->'lines') s
        left join jsonb_array_elements(quote) q on q->>'task_id' = s->>'task_id'
        where s->'amount_kopeks' <> 'null'::jsonb and q->'price_kopeks' is distinct from s->'price_kopeks'))
  );
end $$;

create function garage_pay.save_order_film(p_order_id uuid, p_expected_version integer, p_price_token text,
  p_mode text, p_amount_kopeks bigint, p_works jsonb, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := public.garage_lock_actor();
  model public.garage_orders%rowtype;
  previous garage_pay.film_revisions%rowtype;
  current_state jsonb;
  saved_state jsonb;
  work_lines jsonb;
  input jsonb;
  version integer;
  file_size bigint;
  entry bytea;
begin
  if not public.garage_is_owner() then
    raise exception using errcode = '42501', message = 'Owner access required.';
  end if;
  if p_expected_version is null or p_expected_version < 0 or p_price_token is null or p_request_id is null
    or p_mode is null or p_mode not in ('order','works')
    or p_amount_kopeks not between 0 and 999999999999
    or jsonb_typeof(p_works) is distinct from 'object'
    or (p_mode = 'order' and p_works <> '{}'::jsonb)
    or (p_mode = 'works' and p_amount_kopeks is not null) then
    raise exception using errcode = '22023', message = 'Invalid film amount or recording mode.';
  end if;
  input := jsonb_build_array(p_order_id, p_expected_version, p_price_token, p_mode, p_amount_kopeks, p_works);
  select * into model from public.garage_orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Standard order unavailable.';
  end if;
  select * into previous from garage_pay.film_revisions where request_id = p_request_id;
  if found then
    if previous.request = input then return previous.response - 'work_amounts'; end if;
    raise exception using errcode = '40001', message = 'Film request changed.';
  end if;
  if model.status = 'cancelled' then
    raise exception using errcode = '22023', message = 'Standard order unavailable.';
  end if;

  -- Some legacy price mutations take the task lock first. Try again if a price edit is active.
  begin
    perform t.id from public.garage_order_tasks t where t.order_id = p_order_id order by t.id for share nowait;
  exception when lock_not_available then
    raise exception using errcode = '40001', message = 'Order works or prices changed.';
  end;
  current_state := garage_pay.order_film(p_order_id);
  version := (current_state->>'version')::integer;
  if p_expected_version <> version or p_price_token <> current_state->>'price_token' then
    raise exception using errcode = '40001', message = 'Film amounts or prices changed.';
  end if;
  if exists (
    select 1 from jsonb_each(p_works) as w(task, value)
    where jsonb_typeof(w.value) <> 'number' or w.value::text !~ '^[0-9]{1,12}$'
      or not exists (select 1 from jsonb_array_elements(current_state->'lines') as line where line->>'task_id' = w.task)
  ) then
    raise exception using errcode = '22023', message = 'Specify amounts for existing order works.';
  end if;
  if version = 0 and p_amount_kopeks is null and p_works = '{}'::jsonb then
    return current_state;
  end if;
  if exists (
    select 1 from garage_pay.film_revisions
    where order_id = p_order_id and film_revisions.version = (current_state->>'version')::integer
      and response->>'price_token' = p_price_token and response->>'mode' = p_mode
      and (response->>'amount_kopeks')::bigint is not distinct from p_amount_kopeks
      and response->'work_amounts' = p_works
  ) then return current_state; end if;
  select coalesce(jsonb_agg(line || jsonb_build_object(
    'amount_kopeks', (p_works->>(line->>'task_id'))::bigint,
    'percent', garage_pay.film_percent((p_works->>(line->>'task_id'))::bigint, (line->>'price_kopeks')::bigint)
  ) order by ord), '[]'::jsonb)
  into work_lines from jsonb_array_elements(current_state->'lines') with ordinality as x(line, ord);
  saved_state := current_state || jsonb_build_object(
    'version', version + 1, 'mode', p_mode, 'amount_kopeks', p_amount_kopeks,
    'work_amounts', p_works, 'lines', work_lines, 'price_changed', false,
    'percent', garage_pay.film_percent(p_amount_kopeks, (current_state->>'order_price_kopeks')::bigint)
  );
  select convert_to(((saved_state - 'price_token' - 'editable' - 'price_changed' - 'work_amounts') ||
    jsonb_build_object('schema_version', 1, 'order_id', p_order_id, 'vehicle', model.vehicle,
      'vehicle_group_code', model.vehicle_group_code, 'price_basis', terms.basis,
      'completed_work_ids', array(select line->'task_id' from jsonb_array_elements(work_lines) line
        where line->>'status' = 'completed'),
      'order_status', model.status, 'saved_at', clock_timestamp(), 'saved_by', actor))::text || chr(10), 'UTF8')
    into entry from garage_pay.commercial_terms terms where terms.order_id = p_order_id;
  update garage_pay.film_file set size_bytes = size_bytes + octet_length(entry)
    where name = 'film-patterns.jsonl' returning size_bytes - octet_length(entry) into file_size;
  insert into garage_pay.film_revisions(order_id, version, request_id, request, response, byte_start, bytes)
    values (p_order_id, version + 1, p_request_id, input, saved_state, file_size, entry);
  return saved_state - 'work_amounts';
end $$;

create function garage_pay.finalize_order_film() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare
  current_film jsonb;
  works jsonb;
begin
  if not public.garage_is_owner()
    or not exists (select 1 from garage_pay.film_revisions where order_id = new.id) then
    return new;
  end if;
  current_film := garage_pay.order_film(new.id);
  select coalesce(jsonb_object_agg(line->>'task_id', line->'amount_kopeks'), '{}'::jsonb)
  into works from jsonb_array_elements(current_film->'lines') line
  where line->'amount_kopeks' <> 'null'::jsonb;
  perform garage_pay.save_order_film(new.id, (current_film->>'version')::integer, current_film->>'price_token',
    current_film->>'mode', (current_film->>'amount_kopeks')::bigint, works, gen_random_uuid());
  return new;
end $$;
create trigger finalize_order_film after update of status on public.garage_orders
for each row when (old.status <> 'closed' and new.status = 'closed') execute function garage_pay.finalize_order_film();

create function garage_pay.read_film_file(p_offset bigint, p_length integer) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog as $$
declare
  size bigint;
  chunk bytea;
begin
  if not public.garage_is_owner() then
    raise exception using errcode = '42501', message = 'Owner access required.';
  end if;
  select size_bytes into size from garage_pay.film_file where name = 'film-patterns.jsonl';
  if p_offset is null or p_offset < 0 or p_offset > size or p_length is null or p_length not between 1 and 262144 then
    raise exception using errcode = '22023', message = 'Invalid film file range.';
  end if;
  select string_agg(substring(bytes
    from greatest(p_offset - byte_start + 1, 1)::integer
    for (least(byte_end, p_offset + p_length) - greatest(byte_start, p_offset))::integer), ''::bytea order by byte_start)
    into chunk from garage_pay.film_revisions
    where byte_end > p_offset and byte_start < p_offset + p_length;
  return jsonb_build_object('size', size, 'data', encode(coalesce(chunk, ''::bytea), 'base64'));
end $$;

create function public.garage_order_film(p_order_id uuid) returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$
  select garage_pay.order_film(p_order_id)
$$;
create function public.garage_save_order_film(p_order_id uuid, p_expected_version integer, p_price_token text,
  p_mode text, p_amount_kopeks bigint, p_works jsonb, p_request_id uuid) returns jsonb
language sql security invoker set search_path = pg_catalog as $$
  select garage_pay.save_order_film(p_order_id, p_expected_version, p_price_token, p_mode, p_amount_kopeks, p_works, p_request_id)
$$;
create function public.garage_film_file(p_offset bigint, p_length integer) returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$
  select garage_pay.read_film_file(p_offset, p_length)
$$;

revoke all on function garage_pay.film_percent(bigint,bigint), garage_pay.finalize_order_film()
  from public, anon, authenticated, service_role;
revoke all on function
  garage_pay.order_film(uuid), garage_pay.save_order_film(uuid,integer,text,text,bigint,jsonb,uuid),
  garage_pay.read_film_file(bigint,integer), public.garage_order_film(uuid),
  public.garage_save_order_film(uuid,integer,text,text,bigint,jsonb,uuid), public.garage_film_file(bigint,integer)
  from public, anon, authenticated, service_role;
grant execute on function
  garage_pay.order_film(uuid), garage_pay.save_order_film(uuid,integer,text,text,bigint,jsonb,uuid),
  garage_pay.read_film_file(bigint,integer), public.garage_order_film(uuid),
  public.garage_save_order_film(uuid,integer,text,text,bigint,jsonb,uuid), public.garage_film_file(bigint,integer)
  to authenticated;

insert into public.garage_schema_migrations(version) values ('20261126150806');
notify pgrst, 'reload schema';
commit;
