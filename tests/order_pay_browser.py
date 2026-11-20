"""Verify exact payments within a multi-job Owner order at phone and desktop widths."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


def exercise_order_pay(db, directory, chromium, owner, first, second):
    spec = spec_from_file_location('order_pay_smoke', Path(__file__).with_name('browser-smoke.py'))
    smoke = module_from_spec(spec)
    spec.loader.exec_module(smoke)
    visit = db.rpc(owner, 'garage_create_order', p_vehicle='Atlas · проверка оплаты', p_vehicle_group_code='VG02',
                   p_source='manager', p_tasks=[{'work_code': code} for code in ('W01', 'W08', 'W09')],
                   p_request_id=str(uuid4()))['order_id']
    order = next(row for row in db.rpc(owner, 'garage_list_orders') if row['id'] == visit)
    jobs = {t['work_code']: t['id'] for t in order['tasks']}
    for code, amount in [('W01', 1790), ('W09', 0)]:
        db.rpc(owner, 'garage_save_task_pricing', p_task_id=jobs[code], p_expected_version=0,
               p_override_kopeks=amount, p_private_comment='', p_request_id=str(uuid4()))
    for mechanic in [first, second]:
        db.rpc(mechanic, 'garage_check_work', p_task_id=jobs['W01'], p_request_id=str(uuid4()))
    server, base = smoke.serve(directory.resolve())
    url = f'{base}/index.html#orders/{visit}'
    edit_url = f'{base}/index.html#orders/edit-{visit}'
    try:
        with sync_playwright() as pw, pw.chromium.launch(executable_path=chromium, args=['--no-sandbox']) as browser:
            for width in (320, 1440):
                ctx, page, errors, live = smoke.new_page(browser, {
                    'userId': owner, 'profile': {'id': owner, 'name': 'Владелец', 'role': 'admin', 'active': True}
                }, {'width': width, 'height': 900})
                try:
                    page.expose_function('__garageRpcFixture', lambda method, params: db.transport(owner, method, params))
                    page.goto(url)
                    expect(page.get_by_role('list', name='Работы и цены').get_by_role('listitem')).to_have_count(3)
                    expect(page.get_by_role('button', name='Распределить', exact=True)).to_have_count(0)
                    page.get_by_role('button', name='Изменить заказ', exact=True).click()
                    expect(page).to_have_url(edit_url)
                    table = page.get_by_role('table', name='Работы и цены')
                    rows = table.locator('tbody[data-task-id]')
                    expect(rows).to_have_count(3)
                    job = table.locator(f'tbody[data-task-id="{jobs["W01"]}"]')
                    gift = table.locator(f'tbody[data-task-id="{jobs["W09"]}"]')
                    for row, catalogue, customer in [(job, '20,01', '17,90'), (gift, '7,77', '0,00')]:
                        expect(row.locator('[data-column=catalogue]')).to_contain_text(catalogue)
                        expect(row.locator('[data-column=customer]')).to_contain_text(customer)
                    bounds = [job.locator(f'[data-column={column}]').bounding_box() for column in ['catalogue', 'customer', 'payout']]
                    assert all(b for b in bounds) and bounds[0]['x'] < bounds[1]['x'] < bounds[2]['x'], bounds
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    expect(gift.get_by_role('button', name='Распределить', exact=True)).to_have_count(0)
                    if width == 320:
                        job.get_by_role('button', name='Распределить', exact=True).click()
                        job.get_by_label('Андрей, BYN', exact=True).fill('12,51')
                        job.get_by_label('Миша, BYN', exact=True).fill('4,03')
                        expect(job.get_by_label('Итого механикам')).to_contain_text('16,54')
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                        job.get_by_role('button', name='Сохранить распределение', exact=True).click()
                        expect(job.get_by_role('button', name='Изменить распределение', exact=True)).to_be_visible()
                        expect(page).to_have_url(edit_url)
                        page.reload()
                    expect(job.locator('[data-column=payout]')).to_contain_text('16,54')
                    job.get_by_role('button', name='Изменить распределение', exact=True).click()
                    expect(job.get_by_label('Андрей, BYN', exact=True)).to_have_value('12,51')
                    expect(job.get_by_label('Миша, BYN', exact=True)).to_have_value('4,03')
                    assert not re.search(r'\d\s*%', job.inner_text())
                    expect(page).to_have_url(edit_url)
                    assert not page.evaluate("__garageCalls.some(c => c.name === 'garage_pay_worklist')")
                    page.get_by_role('button', name='К заказу', exact=True).click()
                    expect(page).to_have_url(url)
                    expect(page.get_by_role('button', name='Изменить распределение', exact=True)).to_have_count(0)
                    assert not errors and not live, (errors, live)
                finally:
                    ctx.close()
    finally:
        server.shutdown()
        server.server_close()
    saved = db.rpc(owner, 'garage_pay_history', p_task_id=jobs['W01'])
    assert len(saved) == 1 and saved[0]['pool_kopeks'] == 1654
    assert {s['mechanic_id']: s['kopeks'] for s in saved[0]['shares']} == {first: 1251, second: 403}
    print('Passed single-screen BYN entry, aligned job prices, gifts and exact persisted amounts on phone and desktop.')
