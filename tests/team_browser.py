"""Cross-session browser checks; SQL assertions use the same disposable database as the browsers."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


def exercise_browser(db, directory, chromium, owner, mechanic_a, mechanic_b, colleague):
    spec = spec_from_file_location('garage_team_smoke', Path(__file__).with_name('browser-smoke.py'))
    smoke = module_from_spec(spec)
    spec.loader.exec_module(smoke)
    label = 'Совместная работа на автомобиле'
    db.rpc(owner, 'garage_create_order', p_vehicle=label, p_vehicle_group_code='VG02', p_source='manager',
           p_tasks=[{'work_code': 'W01'}], p_request_id=str(uuid4()))
    record = next(row for row in db.rpc(owner, 'garage_list_orders') if row['vehicle'] == label)
    task_id = record['tasks'][0]['id']
    server, base = smoke.serve(directory.resolve())
    sessions = []

    def new_page(browser, subject, name, role, route):
        context, page, errors, live = smoke.new_page(
            browser, {'userId': subject, 'profile': {'id': subject, 'name': name, 'role': role, 'active': True}},
            {'width': 390 if role == 'mechanic' else 1440, 'height': 844},
        )
        sessions.append((context, errors, live))
        page.expose_function('__garageRpcFixture', lambda method, params: db.transport(subject, method, params))
        page.goto(f'{base}/index.html#{route}')
        return page

    def open_task(page):
        page.locator(f'[data-task-id="{task_id}"]').get_by_role('button').first.click()

    def confirm(page):
        page.get_by_role('button', name='Подтвердить свою работу', exact=True).click()
        page.get_by_role('button', name='Подтвердить выполнение', exact=True).click()

    def wait_for_action(page):
        expect(page.get_by_text('Ваше выполнение подтверждено.', exact=True)).to_be_visible()

    def current():
        return next(row['tasks'][0] for row in db.rpc(owner, 'garage_list_orders') if row['id'] == record['id'])

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chromium, headless=True, args=['--no-sandbox'])
            try:
                a = new_page(browser, mechanic_a, 'Механик А', 'mechanic', 'manager-orders')
                b = new_page(browser, mechanic_b, 'Механик Б', 'mechanic', 'manager-orders')
                open_task(a)
                a.get_by_role('button', name='Начать работу', exact=True).click()
                b.reload()
                open_task(b)
                b.get_by_role('button', name='Присоединиться', exact=True).click()
                expect(b.get_by_role('button', name='Подтвердить свою работу', exact=True)).to_be_visible()
                a.goto(f'{base}/index.html#shift')
                a.reload()
                open_task(a)
                a.get_by_role('button', name='Приостановить', exact=True).click()
                blocker = a.get_by_role('textbox', name='Причина', exact=True)
                blocker.fill('Ждём выдачу материала')
                b.get_by_role('button', name='Оставить заметку', exact=True).click()
                b.get_by_role('textbox', name='Текст заметки', exact=True).fill('Командная заметка из браузера')
                b.get_by_role('button', name='Сохранить заметку', exact=True).click()
                expect(b.get_by_text('Заметка сохранена.', exact=True)).to_be_visible()
                a.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
                expect(blocker).to_have_value('Ждём выдачу материала')
                expect(a.get_by_role('button', name='Я проверил изменения', exact=True)).to_be_visible()
                a.get_by_role('button', name='Отмена', exact=True).click()
                confirm(a)
                wait_for_action(a)
                assert current()['status'] != 'completed'
                assert db.sql("select count(*) from garage_task_completions where task_id=:'task';", {'task': task_id}) == '0'
                other = new_page(browser, colleague, 'Механик В', 'mechanic', 'manager-orders')
                open_task(other)
                expect(other.get_by_text('Механик Б', exact=True)).to_be_visible()
                expect(other.get_by_role('button', name='Присоединиться', exact=True)).to_have_count(0)
                expect(other.get_by_text('Командная заметка из браузера', exact=True)).to_have_count(0)
                b.goto(f'{base}/index.html#shift')
                b.reload()
                open_task(b)
                confirm(b)
                wait_for_action(b)
                assert current()['status'] == 'completed'
                assert db.sql("select count(*) from garage_task_completions where task_id=:'task';", {'task': task_id}) == '1'
                for page in (a, b):
                    page.goto(f'{base}/index.html#history')
                    expect(page.locator(f'[data-task-id="{task_id}"]')).to_be_visible()
                    assert not page.evaluate('__garageCalls.some(c => c.name?.startsWith("garage_pay_"))')
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                pay = new_page(browser, owner, 'Test Owner', 'admin', 'pay')
                card = pay.locator(f'.pay-card[data-task-id="{task_id}"]')
                card.get_by_role('button', name='Распределить', exact=True).click()
                card.get_by_label('Сумма для распределения, BYN').fill('20,01')
                card.get_by_label('Доля · Механик А, %').fill('50')
                card.get_by_label('Доля · Механик Б, %').fill('50')
                card.get_by_role('button', name='Сохранить распределение', exact=True).click()
                expect(pay.get_by_text('Распределение сохранено.', exact=True)).to_be_visible()
                pay.get_by_role('combobox', name='Показать', exact=True).select_option('allocated')
                expect(card).to_be_visible()
                saved = next(item for item in db.rpc(owner, 'garage_pay_worklist') if item['task_id'] == task_id)
                assert saved['pool_kopeks'] == 2001 and saved['version'] == 1
                assert len(db.rpc(owner, 'garage_pay_history', p_task_id=task_id)) == 1
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    for _, errors, requests in sessions:
        assert not errors and not requests, (errors, requests)
    print('Passed four independent browser sessions covering team work, safe colleague visibility, draft recovery and Owner pay.')
