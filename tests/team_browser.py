"""Cross-session browser checks; SQL assertions use the same disposable database as the browsers."""
import asyncio
from threading import Barrier
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
    competing = Barrier(2)
    first_checks = set()

    def new_page(browser, subject, name, role, route):
        context, page, errors, live = smoke.new_page(
            browser, {'userId': subject, 'profile': {'id': subject, 'name': name, 'role': role, 'active': True},
                      'appMetadata': {'mechanic_color': {mechanic_a:'red', mechanic_b:'blue'}.get(subject)}},
            {'width': 390 if role == 'mechanic' else 1440, 'height': 844},
        )
        sessions.append((context, errors, live))
        async def transport(method, params):
            if method == 'garage_check_work' and params['p_task_id'] == task_id and subject not in first_checks:
                first_checks.add(subject)
                await asyncio.to_thread(competing.wait, 12)
            return await asyncio.to_thread(db.transport, subject, method, params)
        page.expose_function('__garageRpcFixture', transport)
        page.goto(f'{base}/index.html#{route}')
        return page

    def publish(page, recipient):
        # Stand in for Supabase Realtime delivery using only the notification this account can SELECT.
        revision = db.sql(r"""begin; set local role authenticated;
            select set_config('request.jwt.claim.sub', :'actor', true) as subject \gset
            select revision from garage_board_updates where recipient_id=:'actor'; commit;""", {'actor':recipient})
        assert revision and int(revision) > 0, revision
        page.evaluate('row => __garageBoardSignal(row)', {'recipient_id':recipient, 'revision':int(revision)})

    def work(page, key=task_id):
        return page.locator(f'[data-vehicle-id="{record["id"]}"] [data-task-id="{key}"]')

    def current():
        return next(row for row in db.rpc(owner, 'garage_list_orders') if row['id'] == record['id'])

    def handoff(page, note, *, complete=False):
        page.get_by_role('button', name='Передать владельцу', exact=True).click()
        form = page.locator('form.vehicle-handoff')
        expect(form.get_by_role('heading', name='Передача владельцу', exact=True)).to_be_focused()
        for task in record['tasks']:
            item = form.get_by_text(task['work_name'], exact=True)
            if complete or task['id'] != task_id:
                expect(item).to_be_visible()
            else:
                expect(item).to_be_hidden()
        comment = form.get_by_label('Комментарий владельцу')
        comment.fill(note)
        confirm_handoff = form.get_by_role('button', name='Передать владельцу', exact=True)
        confirm_handoff.click()
        confirm_state = db.rpc(owner, 'garage_list_orders')
        if next(item for item in confirm_state if item['id'] == record['id'])['vehicle_workflow']['state'] != 'review':
            review = form.get_by_role('button', name='Я проверил изменения', exact=True)
            if review.is_visible():
                expect(comment).to_have_value(note)
                review.click()
                confirm_handoff.click()
        expect(form).to_be_hidden()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chromium, headless=True, args=['--no-sandbox'])
            try:
                a = new_page(browser, mechanic_a, 'Андрей', 'mechanic', 'manager-orders')
                b = new_page(browser, mechanic_b, 'Миша', 'mechanic', 'manager-orders')
                other = new_page(browser, colleague, 'Механик В', 'mechanic', 'manager-orders')
                for page in (a, b, other):
                    open_visit(page, record['id'])
                    expect(work(page).get_by_role('checkbox')).to_be_enabled()
                # Both real RPC requests reach PostgreSQL together from the two independent accounts.
                work(a).get_by_role('checkbox').click()
                work(b).get_by_role('checkbox').click()
                expect(work(a).locator(f'[data-mechanic-id="{mechanic_a}"]')).to_be_visible()
                expect(work(b).locator(f'[data-mechanic-id="{mechanic_b}"]')).to_be_visible()
                for page, recipient in ((a, mechanic_a), (b, mechanic_b), (other, colleague)):
                    publish(page, recipient)
                    for person, name, color in ((mechanic_a,'Андрей','rgb(255, 147, 157)'), (mechanic_b,'Миша','rgb(138, 196, 255)')):
                        marker = work(page).locator(f'[data-mechanic-id="{person}"]')
                        expect(marker).to_be_visible(timeout=2000)
                        assert name in marker.evaluate("el => [el.textContent,el.getAttribute('aria-label'),el.title].join(' ')")
                        assert marker.evaluate("el => getComputedStyle(el, '::before').backgroundColor") == color
                        if recipient == person:
                            identity = page.locator(f'header [data-mechanic-id="{person}"]')
                            expect(identity).to_have_text(name)
                            assert identity.evaluate("el => getComputedStyle(el, '::before').backgroundColor") == color
                    assert not page.evaluate("__garageCalls.some(c => ['garage_team_action','garage_vehicle_action','garage_pay_worklist','garage_order_financials','garage_owner_review_prices'].includes(c.name))")
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert db.sql("select count(*) from garage_task_completions where task_id=:'id';", {'id':task_id}) == '1'
                assert len([row for row in db.rpc(owner,'garage_pay_worklist') if row['task_id'] == task_id]) == 1
                assert {p['mechanic_id'] for p in next(t for t in current()['tasks'] if t['id'] == task_id)['participants']} == {mechanic_a,mechanic_b}
                handoff(a, 'Проверить вторую услугу до выдачи')
                pay = new_page(browser, owner, 'Test Owner', 'admin', 'orders/' + record['id'])
                review = pay.get_by_role('region', name='Передача автомобиля', exact=True)
                expect(review.get_by_text('Проверить вторую услугу до выдачи', exact=True)).to_be_visible()
                expect(review.get_by_role('listitem').filter(has_text=extra_task['work_name'])).to_be_visible()
                workflow = current()['vehicle_workflow']
                assert workflow['state'] == 'review' and workflow['unfinished_count'] == 1
                assert not workflow['can_close']
                review.get_by_label('Механику при возврате (необязательно)', exact=True).fill('Закончить вторую услугу')
                review.get_by_role('button', name='Вернуть в работу', exact=True).click()
                expect(review.get_by_role('button', name='Вернуть в работу', exact=True)).to_have_count(0)
                publish(a, mechanic_a)
                open_visit(a, record['id'])
                work(a, extra_task['id']).get_by_role('checkbox').click()
                expect(work(a,extra_task['id']).locator(f'[data-mechanic-id="{mechanic_a}"]')).to_be_visible()
                handoff(a, 'Все услуги проверены', complete=True)
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
    print('Passed four independent browser sessions covering concurrent red/blue checkmarks, scoped live updates, partial/full handoff, return, closure and one Owner pay split.')
