#!/usr/bin/env python3
"""Exercise actual migrations and independent browser sessions against temporary PostgreSQL 17."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import subprocess
from time import monotonic, sleep
from threading import Barrier
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994'
OWNER, A, B, C = [f'00000000-0000-4000-8000-{number:012d}' for number in range(1, 5)]
PEOPLE = {OWNER: 'Test Owner', A: 'Андрей', B: 'Миша', C: 'Механик В'}
ROLE = 'set local role authenticated; select set_config(\'request.jwt.claim.sub\', :\'subject\', true) as subject \\gset'
BOOTSTRAP = """
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create publication supabase_realtime;
create schema auth;
create table auth.users(id uuid primary key, email text not null, raw_user_meta_data jsonb not null default '{}',
                        raw_app_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema public,auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
"""
GRANTS = """
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;
"""
# Only these fixture operations can be issued from the mocked browser transport.
RPC = {
    'garage_list_orders', 'garage_manager_intakes', 'garage_staff',
    'garage_create_order', 'garage_task_action', 'garage_team_action', 'garage_save_team_order', 'garage_vehicle_action',
    'garage_order_financials', 'garage_record_team_omission', 'garage_quote_order',
    'garage_pay_worklist', 'garage_pay_history', 'garage_pay_save', 'garage_pay_save_amounts', 'garage_save_task_pricing',
    'garage_owner_gift_offer', 'garage_save_order_with_gift', 'garage_owner_review_prices',
    'garage_check_work', 'garage_uncheck_work', 'garage_submit_work',
}
PARAM_TYPES = {
    'p_order_id': 'uuid', 'p_order_ids': 'uuid[]', 'p_id': 'uuid', 'p_task_id': 'uuid', 'p_request_id': 'uuid',
    'p_mechanic_id': 'uuid', 'p_replacement_id': 'uuid', 'p_assignee': 'uuid',
    'p_order': 'jsonb', 'p_tasks': 'jsonb', 'p_options': 'jsonb', 'p_mechanic_ids': 'uuid[]',
    'p_action': 'text', 'p_mode': 'text', 'p_note': 'text', 'p_vehicle': 'text', 'p_source': 'text',
    'p_vehicle_group_code': 'text', 'p_work_code': 'text', 'p_expected_version': 'integer',
    'p_pool_kopeks': 'bigint', 'p_shares': 'jsonb', 'p_amounts': 'jsonb', 'p_reason': 'text', 'p_zero_confirmed': 'boolean',
    'p_completed_at': 'timestamptz', 'p_instructions': 'text', 'p_due_date': 'date', 'p_priority': 'text',
    'p_vin': 'text', 'p_colour': 'text', 'p_manager_label': 'text', 'p_planned_date': 'date',
    'p_override_kopeks': 'bigint', 'p_private_comment': 'text',
    'p_equal_split': 'boolean',
    'p_gift_expected_version': 'integer',
}


class Database:
    """No configurable server address: every statement goes to our network-isolated disposable container."""

    def __init__(self):
        self.container = 'garage-team-test-' + uuid4().hex[:12]
        self.environment = {k: v for k, v in os.environ.items() if not k.startswith('DOCKER_')}

    def docker(self, *args, data=None):
        return subprocess.run(
            ['docker', '--host=unix:///var/run/docker.sock', *args], env=self.environment,
            input=data, capture_output=True, text=True, check=True
        ).stdout.strip()

    def __enter__(self):
        self.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE)
        self.docker('run', '-d', '--name', self.container, '--network', 'none', '--memory', '384m',
                    '--tmpfs', '/var/lib/postgresql/data:rw,size=256m', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE)
        try:
            deadline = monotonic() + 60
            while monotonic() < deadline:
                try:
                    self.docker('exec', self.container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres')
                    return self
                except subprocess.CalledProcessError:
                    sleep(0.25)
            raise RuntimeError('Temporary PostgreSQL did not become ready.')
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, exc_type, exc_value, traceback):
        self.docker('rm', '-f', self.container)

    def sql(self, statement, variables=None):
        options = []
        for name, value in (variables or {}).items():
            options.extend(['-v', f'{name}={value}'])
        return self.docker('exec', '-i', self.container, 'psql', '-XqAt', '-U', 'postgres',
                           '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', *options, data=statement)

    def setup(self):
        self.sql(BOOTSTRAP + (ROOT / 'schema.sql').read_text() + GRANTS)
        for user_id, name in PEOPLE.items():
            self.sql("insert into auth.users values (:'id', :'email', jsonb_build_object('name', :'name'));",
                     {'id': user_id, 'email': f'{user_id}@example.invalid', 'name': name})
        for user_id, color in ((A, 'red'), (B, 'blue')):
            self.sql("update auth.users set raw_app_meta_data=jsonb_build_object('mechanic_color', :'color'::text) where id=:'id';",
                     {'id': user_id, 'color': color})
        self.sql("update profiles set role='admin' where id=:'owner';", {'owner': OWNER})
        migrations = sorted((ROOT / 'supabase/migrations').glob('*.sql'))
        historical = [p for p in migrations if p.name.split('_')[0] < '20261118000001']
        team_pay_release = [p for p in migrations if '20261118000001' <= p.name.split('_')[0] <= '20261118174234']
        vehicle_price_release = [p for p in migrations if '20261118174234' < p.name.split('_')[0] < '20261118223856']
        inline_release = [p for p in migrations if p.name.split('_')[0] >= '20261118223856']
        for migration in historical:
            self.sql(migration.read_text())
        legacy = create(self, 'До перехода')
        old = task(self, OWNER, legacy)
        self.rpc(A, 'garage_task_action', p_task_id=old['id'], p_action='start', p_expected_version=1,
                 p_request_id=str(uuid4()))
        self.rpc(A, 'garage_task_action', p_task_id=old['id'], p_action='complete', p_expected_version=2,
                 p_request_id=str(uuid4()))
        old = task(self, OWNER, legacy)
        for migration in team_pay_release:
            self.sql(migration.read_text())
        recovered = task(self, OWNER, legacy)
        for name in ('id', 'status', 'completed_at', 'work_code', 'version'):
            assert recovered[name] == old[name], (name, old[name], recovered[name])
        assert [member['mechanic_id'] for member in recovered['participants']] == [A]
        assert all(item['task_id'] != old['id'] for item in self.rpc(OWNER, 'garage_pay_worklist'))
        # Exercise the prior contract and carry real in-flight work through the next cutover.
        for suite in ('pay-allocation.sql', 'owner-team-orders.sql'):
            self.sql((ROOT / 'tests' / suite).read_text())
        ongoing = create(self, 'Начато до передачи автомобиля')
        act(self, A, task(self, A, ongoing), 'join')
        settled = create(self, 'Распределено до пересчёта')
        act(self, B, task(self, B, settled), 'join')
        act(self, B, task(self, B, settled), 'confirm')
        settled_id = task(self, OWNER, settled)['id']
        self.rpc(OWNER, 'garage_pay_save', p_task_id=settled_id, p_expected_version=0, p_pool_kopeks=3222,
                 p_shares=[{'mechanic_id': B, 'basis_points': 10000}], p_reason='',
                 p_zero_confirmed=False, p_request_id=str(uuid4()))
        for migration in vehicle_price_release:
            self.sql(migration.read_text())
        migrated = order(self, A, ongoing)
        assert migrated['vehicle_workflow']['state'] == 'active' and migrated['vehicle_workflow']['holder_id'] == A
        assert migrated['tasks'][0]['my_status'] == 'working'
        paid = next(item for item in self.rpc(OWNER, 'garage_pay_worklist') if item['task_id'] == settled_id)
        assert paid['pool_kopeks'] == 3222 and paid['version'] == 1 and paid['equal_split'] is False
        for migration in inline_release:
            self.sql(migration.read_text())
        assert task(self, A, ongoing)['can_check_work']
        assert task(self, OWNER, settled)['completed_at'] is not None

    def rpc(self, actor, method, **parameters):
        assert method in RPC, method
        arguments, variables = [], {'subject': actor}
        for name, value in parameters.items():
            data_type = PARAM_TYPES[name]
            if value is None:
                expression = f'null::{data_type}'
            elif data_type == 'uuid[]':
                expression = f"array(select jsonb_array_elements_text(:'{name}'::jsonb)::uuid)"
                variables[name] = json.dumps(value)
            else:
                variables[name] = json.dumps(value) if data_type == 'jsonb' else str(value)
                expression = f":'{name}'::{data_type}"
            arguments.append(f'{name} => {expression}')
        statement = f'begin;\n{ROLE}\nselect to_jsonb(public.{method}({", ".join(arguments)}));\ncommit;'
        response = self.sql(statement, variables)
        return json.loads(response) if response else None

    def transport(self, actor, method, parameters):
        try:
            return {'data': self.rpc(actor, method, **parameters), 'error': None}
        except subprocess.CalledProcessError as error:
            match = re.search(r'ERROR:\s+([0-9A-Z]{5}): (.*)', error.stderr)
            if not match:
                raise
            return {'data': None, 'error': {'code': match.group(1), 'message': match.group(2)}}


def create(db, vehicle):
    db.rpc(OWNER, 'garage_create_order', p_vehicle=vehicle, p_vehicle_group_code='VG02', p_source='manager',
           p_tasks=[{'work_code': 'W01'}], p_request_id=str(uuid4()))
    return vehicle


def order(db, who, vehicle):
    return next((row for row in db.rpc(who, 'garage_list_orders') if row['vehicle'] == vehicle), None)


def task(db, who, vehicle):
    return order(db, who, vehicle)['tasks'][0]


def act(db, actor, record, action, **extra):
    return db.rpc(actor, 'garage_team_action', p_task_id=record['id'], p_action=action,
                  p_expected_version=record['version'], p_request_id=str(uuid4()), **extra)


def vehicle_action(db, actor, record, action, **extra):
    return db.rpc(actor, 'garage_vehicle_action', p_order_id=record['id'], p_action=action,
                  p_expected_version=record['version'], p_request_id=str(uuid4()), **extra)


def expect_rejection(call):
    try:
        call()
    except subprocess.CalledProcessError as error:
        assert re.search(r'ERROR:\s+(42501|40001|P0001|22023|23514):', error.stderr), error.stderr
    else:
        raise AssertionError('Expected a rejected mutation.')


def concurrent_pair(function):
    with ThreadPoolExecutor(max_workers=2) as sessions:
        futures = [sessions.submit(function, actor) for actor in (A, B)]
        for future in futures:
            future.result()


def check_handoff_race(db):
    label = create(db, 'Передача одновременно с выполнением')
    vehicle_action(db, A, order(db, A, label), 'take')
    act(db, B, task(db, B, label), 'join')
    before = order(db, A, label)
    work = before['tasks'][0]
    with ThreadPoolExecutor(max_workers=2) as sessions:
        handoff = sessions.submit(db.transport, A, 'garage_vehicle_action', {
            'p_order_id': before['id'], 'p_action': 'handoff',
            'p_expected_version': before['version'], 'p_request_id': str(uuid4())})
        confirm = sessions.submit(db.transport, B, 'garage_team_action', {
            'p_task_id': work['id'], 'p_action': 'confirm',
            'p_expected_version': work['version'], 'p_request_id': str(uuid4())})
        handed, finished = handoff.result(), confirm.result()
    assert (handed['error'] is None) != (finished['error'] is None), (handed, finished)
    after = order(db, OWNER, label)
    visit = after['vehicle_workflow']
    if handed['error'] is None:
        assert visit['state'] == 'review' and visit['handoff_tasks'][0]['status'] == 'in_progress'
        assert finished['error']['code'] == '40001' and after['tasks'][0]['status'] == 'in_progress'
    else:
        assert visit['state'] == 'active' and handed['error']['code'] == '40001'
        assert after['tasks'][0]['status'] == 'completed'
        vehicle_action(db, A, after, 'handoff')
        reviewed = order(db, OWNER, label)['vehicle_workflow']
        assert reviewed['handoff_tasks'][0]['status'] == 'completed'


def check_undo_handoff_race(db):
    label = create(db, 'Передача одновременно со снятием отметки')
    job_id = task(db, A, label)['id']
    for actor in (A, B):
        db.rpc(actor, 'garage_check_work', p_task_id=job_id, p_request_id=str(uuid4()))
    before = order(db, B, label)
    gate = Barrier(2)

    def send(actor, method, params):
        gate.wait(timeout=10)
        return db.transport(actor, method, {**params, 'p_request_id': str(uuid4())})

    with ThreadPoolExecutor(max_workers=2) as sessions:
        undo = sessions.submit(send, A, 'garage_uncheck_work', {
            'p_task_id': job_id, 'p_expected_version': before['tasks'][0]['version']})
        submit = sessions.submit(send, B, 'garage_submit_work', {
            'p_order_id': before['id'], 'p_expected_version': before['version'], 'p_note': ''})
        undone, handed = undo.result(), submit.result()
    assert (undone['error'] is None) != (handed['error'] is None), (undone, handed)
    after = order(db, OWNER, label)
    confirmed = {p['mechanic_id'] for p in after['tasks'][0]['participants'] if p['status'] == 'confirmed'}
    assert after['tasks'][0]['status'] == 'completed'
    assert confirmed == ({B} if undone['error'] is None else {A, B}), confirmed
    assert (after['vehicle_workflow']['state'] == 'review') == (handed['error'] is None)


def check_inline_work(db):
    label = create(db, 'Совместные отметки без бронирования')
    available = order(db, A, label)
    work_id = available['tasks'][0]['id']
    assert available['tasks'][0]['can_check_work'] and not available['vehicle_workflow']['can_submit']
    assert available['vehicle_workflow']['holder_id'] is None
    requests = {actor: str(uuid4()) for actor in (A, B)}
    ready = Barrier(2)

    def check(actor):
        ready.wait(timeout=10)
        return db.rpc(actor, 'garage_check_work', p_task_id=work_id, p_request_id=requests[actor])

    concurrent_pair(check)
    finished = order(db, A, label)
    item = finished['tasks'][0]
    assert item['status'] == 'completed' and not item['can_check_work']
    assert finished['vehicle_workflow']['can_submit']
    people = [person for person in item['participants'] if person['status'] == 'confirmed']
    assert len(people) == 2 and {person['mechanic_id'] for person in people} == {A, B}
    assert {(p['name'], p['color'].lower()) for p in people} == {('Андрей','#ff939d'), ('Миша','#8ac4ff')}
    assert db.sql("select count(*) from garage_task_completions where task_id=:'task';", {'task': work_id}) == '1'
    assert len([row for row in db.rpc(OWNER, 'garage_pay_worklist') if row['task_id'] == work_id]) == 1
    assert task(db, C, label)['can_check_work'] and not order(db, C, label)['vehicle_workflow']['can_submit']
    for request in (requests[A], str(uuid4())):
        assert db.rpc(A, 'garage_check_work', p_task_id=work_id, p_request_id=request)['status'] == 'completed'
    assert order(db, A, label)['version'] == finished['version']
    for actor in (A, B, C):
        recipients = db.sql("begin;\n" + ROLE + "\nselect recipient_id from garage_board_updates; commit;",
                            {'subject': actor}).splitlines()
        assert recipients == [actor], recipients
    assert db.sql("select tablename from pg_publication_tables where pubname='supabase_realtime';") == 'garage_board_updates'
    expect_rejection(lambda: db.rpc(C, 'garage_submit_work', p_order_id=finished['id'],
                                    p_expected_version=finished['version'], p_note='', p_request_id=str(uuid4())))
    send = dict(p_order_id=finished['id'], p_expected_version=finished['version'],
                p_note='Проверено двумя механиками', p_request_id=str(uuid4()))
    receipt = db.rpc(B, 'garage_submit_work', **send)
    assert receipt['state'] == 'review' and db.rpc(B, 'garage_submit_work', **send) == receipt
    expect_rejection(lambda: db.rpc(C, 'garage_check_work', p_task_id=work_id, p_request_id=str(uuid4())))
    assert db.rpc(A, 'garage_check_work', p_task_id=work_id, p_request_id=requests[A])['task_id'] == work_id
    assert not task(db, C, label)['can_check_work']
    revision = "select revision from garage_board_updates where recipient_id=:'id';"
    before_private = db.sql(revision, {'id': C})
    private = db.rpc(OWNER, 'garage_save_team_order', p_mode='new', p_id=None, p_expected_version=None,
                     p_order={'source':'owner','vehicle':'Личная отметка','vehicle_group_code':'VG02'},
                     p_tasks=[{'work_code':'W01','assigned_to':A,'mechanic_ids':[A]}], p_request_id=str(uuid4()))
    mine = next(row for row in db.rpc(A, 'garage_list_orders') if row['id'] == private['order_id'])
    assert mine['tasks'][0]['can_check_work'] and not order(db, C, 'Личная отметка')
    expect_rejection(lambda: db.rpc(C, 'garage_check_work', p_task_id=mine['tasks'][0]['id'], p_request_id=str(uuid4())))
    db.rpc(A, 'garage_check_work', p_task_id=mine['tasks'][0]['id'], p_request_id=str(uuid4()))
    assert db.sql(revision, {'id': C}) == before_private
    print('Passed simultaneous check-off, one completion/pay item, distinct credit, receipt replay, private eligibility and scoped notification rows.')


def exercise_database(db):
    shared = create(db, 'Параллельная работа')
    available = order(db, A, shared)
    expect_rejection(lambda: act(db, A, available['tasks'][0], 'join'))
    def compete(actor):
        return db.transport(actor, 'garage_vehicle_action', {
            'p_order_id': available['id'], 'p_action': 'take', 'p_expected_version': available['version'],
            'p_request_id': str(uuid4()),
        })
    with ThreadPoolExecutor(max_workers=2) as sessions:
        attempts = dict(zip((A, B), sessions.map(compete, (A, B))))
    winners = [actor for actor, reply in attempts.items() if reply['error'] is None]
    assert len(winners) == 1, attempts
    holder = winners[0]
    active = order(db, holder, shared)
    assert active['vehicle_workflow']['holder_id'] == holder
    assert active['tasks'][0]['status'] == 'pending'
    expect_rejection(lambda: vehicle_action(db, C, active, 'handoff'))
    empty = task(db, A, shared)
    private_comment = 'Индивидуальная скидка постоянному клиенту'
    pricing = dict(p_task_id=empty['id'], p_expected_version=0,
                   p_override_kopeks=9876, p_private_comment=private_comment, p_request_id=str(uuid4()))
    expect_rejection(lambda: db.rpc(B, 'garage_save_task_pricing', **pricing))
    assert db.rpc(OWNER, 'garage_save_task_pricing', **pricing) == 1
    for mechanic in (A, B, C):
        payload = json.dumps(order(db, mechanic, shared), ensure_ascii=False)
        assert all(value not in payload for value in (private_comment, 'override_kopeks', 'private_comment', 'effective_kopeks'))
        expect_rejection(lambda: db.rpc(mechanic, 'garage_order_financials', p_order_id=available['id']))
    concurrent_pair(lambda actor: act(db, actor, empty, 'join'))
    joined = task(db, A, shared)
    assert {m['mechanic_id'] for m in joined['participants']} == {A, B}
    act(db, A, joined, 'note', p_note='Командное уточнение')
    peer = task(db, C, shared)
    assert {m['name'] for m in peer['participants']} == {PEOPLE[A], PEOPLE[B]}
    assert peer.get('notes') == [] and not peer.get('can_see_notes')
    assert 'Командное уточнение' not in json.dumps(peer, ensure_ascii=False)
    # The safe summary must agree with direct table privileges for the same authenticated actor.
    hidden = db.sql("begin;\n" + ROLE + "\nselect count(*) from garage_task_events where task_id=:'task' and note='Командное уточнение';"
                    "\nselect count(*) from garage_order_tasks where id=:'task'; commit;",
                    {'subject': C, 'task': joined['id']})
    assert hidden.splitlines() == ['0', '0'], hidden
    expect_rejection(lambda: db.rpc(C, 'garage_pay_worklist'))
    visible = task(db, B, shared)
    assert any(note['note'] == 'Командное уточнение' for note in visible['notes'])
    expect_rejection(lambda: act(db, C, visible, 'confirm'))
    expect_rejection(lambda: db.rpc(A, 'garage_task_action', p_task_id=joined['id'], p_action='complete',
                                     p_expected_version=visible['version'], p_request_id=str(uuid4())))
    concurrent_pair(lambda actor: act(db, actor, visible, 'confirm'))
    completed = task(db, OWNER, shared)
    assert completed['status'] == 'completed'
    assert all(m['status'] == 'confirmed' for m in completed['participants'])
    assert db.sql("select count(*) from garage_task_completions where task_id=:'id';", {'id': completed['id']}) == '1'
    pay = next(item for item in db.rpc(OWNER, 'garage_pay_worklist') if item['task_id'] == completed['id'])
    assert pay['pool_kopeks'] is None and pay['suggested_pool_kopeks'] == 2001, pay
    suggested = {share['mechanic_id']: (share['basis_points'], share['kopeks']) for share in pay['suggested_shares']}
    assert suggested == {A: (5000, 1001), B: (5000, 1000)}
    expect_rejection(lambda: act(db, C, completed, 'join'))
    recovery = create(db, 'Замена механика')
    vehicle_action(db, A, order(db, A, recovery), 'take')
    act(db, A, task(db, A, recovery), 'join')
    act(db, B, task(db, B, recovery), 'join')
    activity = task(db, A, recovery)
    receipt = str(uuid4())
    payload = dict(p_task_id=activity['id'], p_action='confirm', p_expected_version=activity['version'], p_request_id=receipt)
    first = db.rpc(A, 'garage_team_action', **payload)
    assert db.rpc(A, 'garage_team_action', **payload) == first
    waiting = task(db, B, recovery)
    assert waiting['status'] != 'completed' and waiting['roster_locked']
    expect_rejection(lambda: act(db, C, waiting, 'join'))
    expect_rejection(lambda: act(db, B, waiting, 'leave', p_note='Ухожу'))
    act(db, OWNER, waiting, 'replace', p_mechanic_id=B, p_replacement_id=C, p_note='Замена по графику')
    replaced = task(db, C, recovery)
    assert replaced['status'] != 'completed'
    expect_rejection(lambda: act(db, B, replaced, 'confirm'))
    if replaced['my_status'] == 'assigned':
        act(db, C, replaced, 'start')
    act(db, C, task(db, C, recovery), 'confirm')
    assert task(db, OWNER, recovery)['status'] == 'completed'
    private_order = {
        'vehicle': 'Закрытое назначение', 'vehicle_group_code': 'VG02', 'source': 'owner',
        'instructions': '', 'priority': 'normal', 'planned_date': None, 'due_date': None,
    }
    db.rpc(OWNER, 'garage_save_team_order', p_mode='new', p_id=None, p_expected_version=None,
           p_order=private_order, p_tasks=[{'work_code': 'W01', 'options': {}, 'assigned_to': A, 'mechanic_ids': [A, B]}],
           p_request_id=str(uuid4()))
    assert order(db, C, private_order['vehicle']) is None
    personal = task(db, B, private_order['vehicle'])
    assert {m['mechanic_id'] for m in personal['participants']} == {A, B}
    expect_rejection(lambda: act(db, C, personal, 'join'))
    print('Passed PostgreSQL team concurrency, privacy, roster, retry and historical migration checks.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sql-only', action='store_true')
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    try:
        with Database() as database:
            database.setup()
            for suite in ('vehicle-workflow.sql', 'task-pricing.sql', 'gift-pricing.sql', 'undo-work.sql', 'pay-amounts.sql'):
                database.sql((ROOT / 'tests' / suite).read_text())
            database.sql("""
                insert into garage_price_lists (id,name,source_sha256,status)
                  values ('bd7979a4-bffd-4527-b99f-621e8346cfc4','Acceptance price list',repeat('9',64),'active');
                insert into garage_price_matrix (price_list_id,vehicle_group_code,work_code,net_amount)
                  select 'bd7979a4-bffd-4527-b99f-621e8346cfc4'::uuid,'VG02',work_code,net_amount
                    from (values ('W01',20.01),('W08',11.11),('W09',7.77)) rate(work_code,net_amount);
            """)
            exercise_database(database)
            check_handoff_race(database)
            check_inline_work(database)
            check_undo_handoff_race(database)
            if not args.sql_only:
                from team_browser import exercise_browser
                from owner_browser import exercise_owner_order
                from price_browser import exercise_owner_pricing
                from order_pay_browser import exercise_order_pay
                exercise_browser(database, args.directory, args.chromium, OWNER, A, B, C)
                exercise_owner_order(database, args.directory, args.chromium, OWNER, A, B)
                database.sql("insert into garage_pay.gift_offer(gift_work_code, qualifying_count) values ('W09', 2);")
                exercise_owner_pricing(database, args.directory, args.chromium, OWNER, A, B)
                exercise_order_pay(database, args.directory, args.chromium, OWNER, A, B)
    except subprocess.CalledProcessError as failure:
        raise SystemExit(failure.stderr or str(failure)) from failure
