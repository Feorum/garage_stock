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
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994'
OWNER, A, B, C = [f'00000000-0000-4000-8000-{number:012d}' for number in range(1, 5)]
PEOPLE = {OWNER: 'Test Owner', A: 'Механик А', B: 'Механик Б', C: 'Механик В'}
ROLE = 'set local role authenticated; select set_config(\'request.jwt.claim.sub\', :\'subject\', true) as subject \\gset'
BOOTSTRAP = """
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key, email text not null, raw_user_meta_data jsonb not null default '{}');
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
    'garage_create_order', 'garage_task_action', 'garage_team_action', 'garage_save_team_order',
    'garage_order_financials', 'garage_record_team_omission', 'garage_quote_order',
    'garage_pay_worklist', 'garage_pay_history', 'garage_pay_save',
}
PARAM_TYPES = {
    'p_order_id': 'uuid', 'p_id': 'uuid', 'p_task_id': 'uuid', 'p_request_id': 'uuid',
    'p_mechanic_id': 'uuid', 'p_replacement_id': 'uuid', 'p_assignee': 'uuid',
    'p_order': 'jsonb', 'p_tasks': 'jsonb', 'p_options': 'jsonb', 'p_mechanic_ids': 'uuid[]',
    'p_action': 'text', 'p_mode': 'text', 'p_note': 'text', 'p_vehicle': 'text', 'p_source': 'text',
    'p_vehicle_group_code': 'text', 'p_work_code': 'text', 'p_expected_version': 'integer',
    'p_pool_kopeks': 'bigint', 'p_shares': 'jsonb', 'p_reason': 'text', 'p_zero_confirmed': 'boolean',
    'p_completed_at': 'timestamptz', 'p_instructions': 'text', 'p_due_date': 'date', 'p_priority': 'text',
    'p_vin': 'text', 'p_colour': 'text', 'p_manager_label': 'text', 'p_planned_date': 'date',
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
        self.sql("update profiles set role='admin' where id=:'owner';", {'owner': OWNER})
        migrations = sorted((ROOT / 'supabase/migrations').glob('*.sql'))
        historical = [p for p in migrations if p.name.split('_')[0] < '20261118000001']
        additions = [p for p in migrations if p not in historical]
        assert additions, 'Expected the team migration in this checkout.'
        for migration in historical:
            self.sql(migration.read_text())
        legacy = create(self, 'До перехода')
        old = task(self, OWNER, legacy)
        self.rpc(A, 'garage_task_action', p_task_id=old['id'], p_action='start', p_expected_version=1,
                 p_request_id=str(uuid4()))
        self.rpc(A, 'garage_task_action', p_task_id=old['id'], p_action='complete', p_expected_version=2,
                 p_request_id=str(uuid4()))
        old = task(self, OWNER, legacy)
        for migration in additions:
            self.sql(migration.read_text())
        recovered = task(self, OWNER, legacy)
        for name in ('id', 'status', 'completed_at', 'work_code', 'version'):
            assert recovered[name] == old[name], (name, old[name], recovered[name])
        assert [member['mechanic_id'] for member in recovered['participants']] == [A]
        assert all(item['task_id'] != old['id'] for item in self.rpc(OWNER, 'garage_pay_worklist'))

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


def exercise_database(db):
    shared = create(db, 'Параллельная работа')
    empty = task(db, A, shared)
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
    expect_rejection(lambda: act(db, C, completed, 'join'))
    recovery = create(db, 'Замена механика')
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
            exercise_database(database)
            for suite in ('pay-allocation.sql', 'owner-team-orders.sql'):
                database.sql((ROOT / 'tests' / suite).read_text())
            if not args.sql_only:
                from team_browser import exercise_browser
                from owner_browser import exercise_owner_order
                exercise_browser(database, args.directory, args.chromium, OWNER, A, B, C)
                exercise_owner_order(database, args.directory, args.chromium, OWNER, A, B)
    except subprocess.CalledProcessError as failure:
        raise SystemExit(failure.stderr or str(failure)) from failure
