"""Exercise two Owner sessions issuing cumulative act numbers on different orders."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4


def check_act_issuance(db, owner, mechanic):
    db.sql("""insert into garage_act.config(customer_name,contractor_name,contract_number,contract_date,template_chunks,last_issued_number)
        values('Client Fixture','Workshop Fixture','Q7','2026-11-01',1,'98/11') on conflict do nothing;
        insert into garage_act.template_parts(part_index,data_base64) values(0,'YWJj') on conflict do nothing;""")
    ids = []
    for month in (11, 12):
        key = str(uuid4())
        db.sql("""insert into public.garage_orders(id,vehicle,source,vin,vehicle_group_code,status,closed_at,created_by)
                  values(:'id','Racing act','manager','TEST-VIN','VG02','closed',:'closed_at',:'owner');
                  insert into public.garage_order_tasks(order_id,work_code,work_name,status,working_mechanic_id,completed_at)
                  values(:'id','W01','Fixture service','completed',:'mechanic',now());
                  select public.garage_snapshot_task(id,'VG02') from public.garage_order_tasks where order_id=:'id';""",
               {'id': key, 'owner': owner, 'mechanic': mechanic, 'closed_at': f'2026-{month}-15T09:00Z'})
        ids.append(key)
    initial = [db.rpc(owner, 'garage_act_get', p_order_id=key) for key in ids]
    prices = [{row['task_id']: row['effective_kopeks'] for row in
               db.rpc(owner, 'garage_order_financials', p_order_id=key)['tasks']} for key in ids]
    previews = [entry['suggested_number'] for entry in initial]
    serial = previews[0].split('/')[0]
    assert previews == [f'{serial}/11', f'{serial}/12']
    ready = Barrier(2)

    def issue(i):
        ready.wait(timeout=10)
        meta = initial[i]
        return db.transport(owner, 'garage_act_save', {
            'p_order_id': ids[i], 'p_number': previews[i], 'p_contract_number': meta['contract_number'],
            'p_contract_date': meta['contract_date'], 'p_act_date': meta['act_date'], 'p_expected_version': 0,
            'p_expected_order_version': 1, 'p_expected_amounts': prices[i],
        })

    with ThreadPoolExecutor(max_workers=2) as sessions:
        results = list(sessions.map(issue, (0, 1)))
    assert sum(entry['error'] is None for entry in results) == 1, results
    loser = next(i for i, entry in enumerate(results) if entry['error'])
    assert results[loser]['error']['code'] == '23505', results
    latest = db.rpc(owner, 'garage_act_get', p_order_id=ids[loser])
    assert latest['number'] is None and latest['suggested_number'] == f"{int(serial) + 1}/{previews[loser][-2:]}"
    issued = db.rpc(owner, 'garage_act_save', p_order_id=ids[loser], p_number=latest['suggested_number'],
                    p_contract_number=latest['contract_number'], p_contract_date=latest['contract_date'],
                    p_act_date=latest['act_date'], p_expected_version=0, p_expected_order_version=1,
                    p_expected_amounts=prices[loser])
    assert issued['number'] == latest['suggested_number'] and issued['version'] == 1
    assert db.rpc(owner, 'garage_act_get', p_order_id=ids[1-loser])['number'] == previews[1-loser]
    print('Passed concurrent act issuance across different months, unique cumulative serials and retry after collision.')
