"""Verify exact payments within a multi-job Owner order at phone and desktop widths."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
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
                    page.get_by_role('button', name='Цены', exact=True).click()
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
                    job.get_by_role('link', name='К выплатам заказа').click()
                    expect(page).to_have_url(url + '/payroll')
                    payroll = page.locator('.order-payroll')
                    for name, value in [('Андрей', '12,51'), ('Миша', '4,03')]:
                        edit = payroll.get_by_role('button', name='Изменить сумму · ' + name, exact=True)
                        edit.click()
                        field = payroll.get_by_label(name + ', BYN', exact=True)
                        if width == 320:
                            field.fill(value)
                            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                            payroll.get_by_role('button', name='Сохранить расчёт', exact=True).click()
                            expect(edit).to_contain_text(value)
                        else:
                            expect(field).to_have_value(value)
                            payroll.get_by_role('button', name='Отмена', exact=True).click()
                    expect(payroll.get_by_text('Всего исполнителям', exact=True).locator('..')).to_contain_text('16,54')
                    page.reload()
                    expect(payroll.get_by_text('Всего исполнителям', exact=True).locator('..')).to_contain_text('16,54')
                    assert not page.evaluate("__garageCalls.some(c => c.name === 'garage_pay_worklist')")
                    assert not errors and not live, (errors, live)
                finally:
                    ctx.close()
    finally:
        server.shutdown()
        server.server_close()
    saved = db.rpc(owner, 'garage_order_payroll', p_order_id=visit)
    assert len(saved['history']) == 2 and saved['total_kopeks'] == 1654
    assert {p['mechanic_id']: p['kopeks'] for p in saved['people']} == {first: 1251, second: 403}
    assert db.rpc(owner, 'garage_pay_history', p_task_id=jobs['W01']) == []
    print('Passed order payroll, aligned job prices, gifts and exact persisted amounts on phone and desktop.')
