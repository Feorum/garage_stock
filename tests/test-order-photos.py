"""Verify photo Storage policies against real order access in disposable PostgreSQL."""
from pathlib import Path
from runpy import run_path
from subprocess import CalledProcessError
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
workflow = run_path(str(ROOT / 'tests/test-team-workflow.py'))
OWNER, A, B, C = [workflow[name] for name in ('OWNER', 'A', 'B', 'C')]
MIGRATION = '20261126145852_order_photos.sql'

# The Storage service owns these relations in hosted Supabase. Only the fields used by
# our bucket and policies are needed to exercise PostgreSQL RLS in the isolated fixture.
STORAGE = """
create schema storage;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(bucket_id text references storage.buckets(id), name text, primary key(bucket_id,name));
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated,anon;
grant select,insert,update,delete on storage.objects to authenticated,anon;
"""


def actor(db, subject, query, **params):
    return db.sql("begin;\n" + workflow['ROLE'] + "\n" + query + "\ncommit;", {'subject':subject, **params})


def insert(db, subject, name):
    actor(db, subject, "insert into storage.objects values ('garage-order-photos', :'name');", name=name)


def denied(call):
    try:
        call()
    except CalledProcessError as error:
        assert '42501' in error.stderr, error.stderr
    else:
        raise AssertionError('Expected the upload to be denied')


def visible(db, subject, order_id):
    return actor(db, subject, "select count(*) from storage.objects where name like :'id' || '/%';", id=order_id)


def run(db):
    db.sql(workflow['BOOTSTRAP'] + (ROOT / 'schema.sql').read_text() + workflow['GRANTS'] + STORAGE)
    for uid, name in workflow['PEOPLE'].items():
        db.sql("insert into auth.users values (:'id', :'email', jsonb_build_object('name', :'name'));",
               {'id':uid, 'email':uid + '@example.invalid', 'name':name})
    db.sql("update profiles set role='admin' where id=:'id';", {'id':OWNER})
    for migration in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
        if migration.name <= MIGRATION:
            db.sql(migration.read_text())
    bucket = db.sql("select not public and file_size_limit=20971520 and not ('image/svg+xml'=any(allowed_mime_types)) "
                    "from storage.buckets where id='garage-order-photos';")
    assert bucket == 't'
    visit = {'vehicle':'Фото X50', 'vehicle_group_code':'VG02', 'source':'owner', 'priority':'normal'}
    for _ in range(2):
        db.rpc(OWNER, 'garage_save_team_order', p_mode='new', p_id=None, p_expected_version=None,
               p_order=visit, p_tasks=[{'work_code':'W01','assigned_to':A,'mechanic_ids':[A,B]}], p_request_id=str(uuid4()))
    orders = [o for o in db.rpc(OWNER,'garage_list_orders') if o['vehicle'] == visit['vehicle']]
    first, second = [o['id'] for o in orders]
    path = first + '/' + str(uuid4()) + '.jpg'
    insert(db, A, path)
    assert visible(db, B, first) == visible(db, OWNER, first) == '1'
    assert visible(db, B, second) == visible(db, C, first) == '0'
    denied(lambda: insert(db, C, first + '/' + str(uuid4()) + '.jpg'))
    denied(lambda: insert(db, B, first + '/other/file.jpg'))
    denied(lambda: insert(db, A, first + '/' + str(uuid4()) + '.svg'))
    assert db.sql("begin; set local role anon; select count(*) from storage.objects; rollback;") == '0'

    db.rpc(A,'garage_check_work',p_task_id=orders[0]['tasks'][0]['id'],p_request_id=str(uuid4()))
    def current():
        return next(o for o in db.rpc(OWNER,'garage_list_orders') if o['id']==first)
    db.rpc(A,'garage_submit_work',p_order_id=first,p_expected_version=current()['version'],p_request_id=str(uuid4()),p_note='')
    assert current()['vehicle_workflow']['state'] == 'review'
    insert(db, B, first + '/' + str(uuid4()) + '.png')
    insert(db, OWNER, first + '/' + str(uuid4()) + '.jpg')
    assert visible(db, A, first) == '3'
    db.rpc(OWNER,'garage_vehicle_action',p_order_id=first,p_action='close',p_expected_version=current()['version'],
           p_request_id=str(uuid4()),p_note='')
    assert visible(db, B, first) == visible(db, OWNER, first) == '3'
    denied(lambda: insert(db, B, first + '/' + str(uuid4()) + '.jpg'))
    denied(lambda: insert(db, OWNER, first + '/' + str(uuid4()) + '.jpg'))
    insert(db, OWNER, second + '/' + str(uuid4()) + '.jpg')
    assert visible(db, B, second) == '1'
    actor(db, OWNER, "select garage_order_action(:'id','cancel',:'version'::int,gen_random_uuid(),'Повторный визит отменён');",
          id=second, version=orders[1]['version'])
    db.sql("update profiles set active=false where id=:'id';", {'id':B})
    assert visible(db, B, first) == '0'


if __name__ == '__main__':
    with workflow['Database']() as database:
        run(database)
    print('Passed per-order photo Storage access, repeated visits, review upload and read-only closure.')
