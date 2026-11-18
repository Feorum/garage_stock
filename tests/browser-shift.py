"""Exercise vehicle claims, handoff, task detail drafts, focus and team visibility with the local SDK fixture."""
import argparse
import importlib.util
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('garage_browser_smoke', ROOT / 'tests/browser-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def fixture():
    actor = '11111111-1111-4111-8111-111111111111'
    members = [{'mechanic_id': actor, 'name': 'Иван', 'status': 'working'}]
    locked_members = [{'mechanic_id': 'a', 'name': 'Анна', 'status': 'confirmed'},
                      {'mechanic_id': 'b', 'name': 'Олег', 'status': 'working'}]

    def order(source, key, team):
        return {'id': key, 'order_number': 'GS-' + key, 'vehicle': 'Тестовый автомобиль ' + key,
                'source': source, 'priority': 'normal', 'status': 'published', 'version': 1,
                'tasks': [{'id': 'task-' + key, 'work_name': 'Оклейка капота', 'work_code': 'W01',
                           'version': 1, 'participants': team, 'status': 'in_progress'}]}

    private = order('owner', '11', members)
    shared = order('manager', '12', locked_members)
    shared['tasks'][0]['notes'] = [{'id': 'private', 'note': 'Закрытый комментарий бригады'}]
    visits = [order('manager', key, []) for key in ('13', '14')]
    for visit in visits:
        visit.update(vehicle='Повторный автомобиль', vin='WVWZZZ1JZXW000001')
        visit['tasks'][0].update(status='pending', work_name='Проверка кромки')
    visits[0]['tasks'].append({'id': 'task-completed', 'work_name': 'Подготовка поверхности',
                               'version': 2, 'status': 'completed',
                               'participants': [{'mechanic_id': actor, 'name': 'Иван', 'status': 'confirmed'}]})
    return {'userId': actor, 'profile': {'id': actor, 'name': 'Иван', 'role': 'mechanic'},
            'orders': [private, shared, *visits]}


def check_vehicle_retry(browser, base):
    data = fixture()
    data['rpcErrors'] = {'garage_vehicle_action': {'message': 'Network response was lost.', 'code': 'NETWORK'}}
    context, page, errors, live = smoke.new_page(browser, data)
    try:
        page.goto(base + '/index.html#shift')
        take = page.locator('[data-vehicle-id="14"]').get_by_role('button', name='Взять автомобиль')
        take.click()
        expect(take).to_be_disabled()
        page.get_by_role('button', name='Проверить отправку').click()
        expect(page.locator('[data-vehicle-detail="14"]')).to_be_visible()
        commands = page.evaluate("__garageCalls.filter(item => item.name === 'garage_vehicle_action').map(item => item.args)")
        assert len(commands) == 2 and commands[0] == commands[1], commands
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def check_owner_queue(browser, base):
    data = fixture()
    data['profile']['role'] = 'admin'
    partial, complete = data['orders'][-2:]
    for visit in (partial, complete):
        visit['vehicle_workflow'] = {'state': 'review', 'holder_id': 'b'}
    complete['tasks'][0]['status'] = 'completed'
    context, page, errors, live = smoke.new_page(browser, data)
    try:
        page.goto(base + '/index.html#shift')
        page.get_by_role('button', name='Переданы владельцу', exact=False).click()
        expect(page.locator('.shift-board .shift-list > li')).to_have_count(2)
        page.get_by_role('button', name='К закрытию', exact=False).click()
        expect(page.locator('.shift-board .shift-list > li')).to_have_count(1)
        page.locator('[data-shift-target="14"]').click()
        expect(page).to_have_url(base + '/index.html#orders/14')
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def run(directory, chromium):
    server, base = smoke.serve(directory.resolve())
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chromium, args=['--no-sandbox'])
            try:
                context, page, errors, live = smoke.new_page(browser, fixture(), {'width': 390, 'height': 844})
                page.goto(base + '/index.html#shift')
                visit = page.locator('[data-shift-target="11"]')
                visit.click()
                trigger = page.locator('[data-task-id="task-11"] button')
                trigger.focus()
                page.keyboard.press('Enter')
                primary = page.get_by_role('button', name='Подтвердить свою работу', exact=True)
                expect(page.get_by_role('heading', name='Оклейка капота', exact=True)).to_be_focused()
                expect(primary).to_be_in_viewport(ratio=1)
                assert primary.bounding_box()['height'] >= 44
                page.get_by_role('button', name='Оставить заметку', exact=True).click()
                text = page.get_by_label('Текст заметки', exact=True)
                expect(text).to_be_focused()
                text.fill('Проверить кромку перед выдачей')
                context.set_offline(True)
                expect(page.get_by_role('button', name='Сохранить заметку')).to_be_disabled()
                page.evaluate('__garageOrderState.orders[0].tasks[0].version++')
                context.set_offline(False)
                expect(text).to_have_value('Проверить кромку перед выдачей')
                page.get_by_role('button', name='Я проверил изменения').click()
                page.get_by_role('button', name='Сохранить заметку').click()
                expect(page.locator('.shift-notes')).to_contain_text('Проверить кромку перед выдачей')
                page.get_by_role('button', name='← К автомобилю').click()
                expect(trigger).to_be_focused()
                page.get_by_role('button', name='← К списку').click()
                expect(visit).to_be_focused()
                page.get_by_role('link', name='Общая очередь').click()
                expect(page.get_by_role('heading', name='Уже в работе')).to_be_visible()
                page.locator('[data-shift-target="12"]').click()
                row = page.locator('[data-task-id="task-12"] button')
                expect(row).to_contain_text('Анна, Олег')
                row.click()
                expect(page.get_by_role('heading', name='Команда')).to_be_visible()
                expect(page.get_by_role('heading', name='Заметки команды')).to_have_count(0)
                expect(page.get_by_text('Закрытый комментарий бригады')).to_have_count(0)
                expect(page.get_by_role('button', name='Присоединиться')).to_have_count(0)
                page.get_by_role('button', name='← К автомобилю').click()
                expect(page.get_by_role('button', name='Передать владельцу', exact=True)).to_have_count(0)
                page.get_by_role('button', name='← К списку').click()
                visits = page.locator('.vehicle-index-row').filter(has_text='Повторный автомобиль')
                expect(visits).to_have_count(2)
                page.evaluate("location.hash = 'manager-orders/task-13'")
                expect(page.get_by_text('Возьмите автомобиль в работу', exact=False)).to_be_visible()
                expect(page.get_by_role('button', name='Начать работу', exact=True)).to_have_count(0)
                page.get_by_role('button', name='← К автомобилю').click()
                page.get_by_role('button', name='← К списку').click()
                take = page.locator('[data-vehicle-id="13"]').get_by_role('button', name='Взять автомобиль', exact=True)
                context.set_offline(True)
                expect(take).to_be_disabled()
                context.set_offline(False)
                expect(take).to_be_enabled()
                take.click()
                detail = page.locator('[data-vehicle-detail="13"]')
                expect(detail.get_by_role('button', name='Передать владельцу', exact=True)).to_be_in_viewport(ratio=1)
                expect(detail.locator('[data-task-id]')).to_have_count(2)
                detail.get_by_role('button', name='Передать владельцу', exact=True).click()
                handoff = detail.locator('form')
                expect(handoff.locator('section').filter(has_text='Выполнено')).to_contain_text('Подготовка поверхности')
                expect(handoff.locator('section').filter(has_text='Осталось выполнить')).to_contain_text('Проверка кромки')
                note = handoff.get_by_label('Комментарий владельцу', exact=False)
                note.fill('Перед выдачей проверить кромку')
                page.evaluate("__garageOrderState.orders.find(order => order.id === '13').version++")
                page.get_by_role('button', name='Обновить', exact=True).click()
                expect(note).to_have_value('Перед выдачей проверить кромку')
                expect(handoff.get_by_role('button', name='Подтвердить передачу')).to_be_disabled()
                handoff.get_by_role('button', name='Я проверил изменения').click()
                handoff.get_by_role('button', name='Подтвердить передачу').click()
                expect(detail.locator('.vehicle-receipt')).to_contain_text('Перед выдачей проверить кромку')
                expect(detail.locator('.vehicle-receipt')).to_contain_text('Осталось выполнить · 1')
                expect(detail.get_by_role('button', name='Передать владельцу', exact=True)).to_have_count(0)
                detail.locator('[data-task-id="task-13"] button').click()
                expect(page.get_by_text('Автомобиль передан владельцу на проверку.', exact=True).last).to_be_visible()
                expect(page.get_by_role('button', name='Начать работу', exact=True)).to_have_count(0)
                page.get_by_role('button', name='← К автомобилю').click()
                for width in (320, 390, 768, 1440):
                    page.set_viewport_size({'width': width, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
                page.get_by_role('button', name='← К списку').click()
                expect(page.locator('[data-vehicle-id="14"]').get_by_role('button', name='Взять автомобиль')).to_be_enabled()
                names = page.evaluate("__garageCalls.filter(item => item.method === 'rpc').map(item => item.name)")
                assert set(names) == {'garage_list_orders', 'garage_team_action', 'garage_vehicle_action'}, names
                assert len([name for name in names if name == 'garage_vehicle_action']) == 2
                context.close()
                assert not errors and not live, (errors, live)
                check_vehicle_retry(browser, base)
                check_owner_queue(browser, base)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Passed visit-level claims, independent repeat visits, partial handoff, offline drafts, keyboard focus and team-only note checks.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    run(args.directory, args.chromium)
