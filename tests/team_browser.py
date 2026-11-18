"""Cross-session browser checks; SQL assertions use the same disposable database as the browsers."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright
from order_browser_helpers import open_visit


def exercise_browser(db, directory, chromium, owner, mechanic_a, mechanic_b, colleague):
    spec = spec_from_file_location('garage_team_smoke', Path(__file__).with_name('browser-smoke.py'))
    smoke = module_from_spec(spec)
    spec.loader.exec_module(smoke)
    label = 'Совместная работа на автомобиле'
    db.rpc(owner, 'garage_create_order', p_vehicle=label, p_vehicle_group_code='VG02', p_source='manager',
           p_tasks=[{'work_code': code} for code in ('W01', 'W09')], p_request_id=str(uuid4()))
    record = next(row for row in db.rpc(owner, 'garage_list_orders') if row['vehicle'] == label)
    task_id = next(t['id'] for t in record['tasks'] if t['work_code'] == 'W01')
    extra_task = next(t for t in record['tasks'] if t['work_code'] == 'W09')
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

    def open_task(page, selected=task_id):
        page.locator(f'[data-task-id="{selected}"]').get_by_role('button').first.click()

    def confirm(page):
        page.get_by_role('button', name='Подтвердить свою работу', exact=True).click()
        page.get_by_role('button', name='Подтвердить выполнение', exact=True).click()

    def wait_for_action(page):
        expect(page.get_by_text('Ваше выполнение подтверждено.', exact=True)).to_be_visible()

    def current():
        return next(row for row in db.rpc(owner, 'garage_list_orders') if row['id'] == record['id'])

    def handoff(page, note):
        page.get_by_role('button', name='Передать владельцу', exact=True).click()
        form = page.locator('form.vehicle-handoff')
        comment = form.get_by_label('Комментарий владельцу')
        comment.fill(note)
        confirm_handoff = form.get_by_role('button', name='Передать владельцу', exact=True)
        confirm_handoff.click()
        success = page.get_by_text('Автомобиль передан владельцу на проверку.', exact=True)
        review = page.get_by_role('button', name='Я проверил изменения', exact=True)
        expect(success.or_(review)).to_be_visible()
        if review.is_visible():
            expect(comment).to_have_value(note)
            review.click()
            confirm_handoff.click()
        expect(success).to_be_visible()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chromium, headless=True, args=['--no-sandbox'])
            try:
                a = new_page(browser, mechanic_a, 'Механик А', 'mechanic', 'manager-orders')
                b = new_page(browser, mechanic_b, 'Механик Б', 'mechanic', 'manager-orders')
                open_visit(a, record['id'], take=True)
                open_task(a)
                a.get_by_role('button', name='Начать работу', exact=True).click()
                b.reload()
                open_visit(b, record['id'])
                open_task(b)
                b.get_by_role('button', name='Присоединиться', exact=True).click()
                expect(b.get_by_role('button', name='Подтвердить свою работу', exact=True)).to_be_visible()
                a.goto(f'{base}/index.html#shift')
                a.reload()
                open_visit(a, record['id'])
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
                assert next(t for t in current()['tasks'] if t['id'] == task_id)['status'] != 'completed'
                assert db.sql("select count(*) from garage_task_completions where task_id=:'task';", {'task': task_id}) == '0'
                other = new_page(browser, colleague, 'Механик В', 'mechanic', 'manager-orders')
                open_visit(other, record['id'])
                open_task(other)
                expect(other.get_by_text('Механик Б', exact=True)).to_be_visible()
                expect(other.get_by_role('button', name='Присоединиться', exact=True)).to_have_count(0)
                expect(other.get_by_text('Командная заметка из браузера', exact=True)).to_have_count(0)
                b.goto(f'{base}/index.html#shift')
                b.reload()
                open_visit(b, record['id'])
                open_task(b)
                confirm(b)
                wait_for_action(b)
                assert next(t for t in current()['tasks'] if t['id'] == task_id)['status'] == 'completed'
                assert db.sql("select count(*) from garage_task_completions where task_id=:'task';", {'task': task_id}) == '1'
                for page in (a, b):
                    page.goto(f'{base}/index.html#history')
                    open_visit(page, record['id'])
                    expect(page.locator(f'[data-task-id="{task_id}"]')).to_be_visible()
                    assert not page.evaluate('__garageCalls.some(c => c.name?.startsWith("garage_pay_"))')
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                a.goto(f'{base}/index.html#shift/{record["id"]}')
                handoff(a, 'Проверить вторую услугу до выдачи')
                pay = new_page(browser, owner, 'Test Owner', 'admin', 'orders/' + record['id'])
                review = pay.get_by_role('region', name='Передача автомобиля', exact=True)
                expect(review.get_by_text('Проверить вторую услугу до выдачи', exact=True)).to_be_visible()
                expect(review.get_by_role('listitem').filter(has_text=extra_task['work_name'])).to_be_visible()
                workflow = current()['vehicle_workflow']
                assert workflow['state'] == 'review' and workflow['unfinished_count'] == 1
                assert not workflow['can_close']
                review.get_by_label('Комментарий к решению', exact=True).fill('Закончить вторую услугу')
                review.get_by_role('button', name='Вернуть в работу', exact=True).click()
                expect(review.get_by_role('button', name='Вернуть в работу', exact=True)).to_have_count(0)
                a.reload()
                open_task(a, extra_task['id'])
                a.get_by_role('button', name='Начать работу', exact=True).click()
                confirm(a)
                wait_for_action(a)
                a.get_by_role('button', name='← К автомобилю', exact=True).click()
                handoff(a, 'Все услуги проверены')
                pay.reload()
                expect(review.get_by_text('Все услуги проверены', exact=True)).to_be_visible()
                review.get_by_role('button', name='Принять и закрыть заказ', exact=True).click()
                expect(review.get_by_role('button', name='Принять и закрыть заказ', exact=True)).to_have_count(0)
                assert current()['status'] == 'closed'
                pay.locator(f'section.task-row[data-task-id="{task_id}"]').get_by_role('link', name='Оплата механикам').click()
                expect(pay).to_have_url(f'{base}/index.html#pay/{task_id}')
                card = pay.locator(f'.pay-card[data-task-id="{task_id}"]')
                expect(card.get_by_label('Сумма для распределения, BYN')).to_have_value('20,01')
                card.get_by_role('button', name='Сохранить распределение', exact=True).click()
                expect(pay.get_by_text('Распределение сохранено.', exact=True)).to_be_visible()
                pay.get_by_role('link', name='Все работы', exact=True).click()
                pay.get_by_role('combobox', name='Показать', exact=True).select_option('allocated')
                expect(card).to_be_visible()
                saved = next(item for item in db.rpc(owner, 'garage_pay_worklist') if item['task_id'] == task_id)
                assert saved['pool_kopeks'] == 2001 and saved['version'] == 1
                assert {share['kopeks'] for share in saved['shares']} == {1000, 1001}
                assert saved['equal_split']
                assert len(db.rpc(owner, 'garage_pay_history', p_task_id=task_id)) == 1
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    for _, errors, requests in sessions:
        assert not errors and not requests, (errors, requests)
    print('Passed four independent browser sessions covering team work, safe colleague visibility, draft recovery and Owner pay.')
