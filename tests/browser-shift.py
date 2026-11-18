"""Exercise vehicle claims, handoff, task detail drafts, focus and team visibility with the local SDK fixture."""
import argparse
import importlib.util
from pathlib import Path
import re

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


def work_button(detail, task_id):
    return detail.locator(f'[data-task-id="{task_id}"] button').filter(has_text='Открыть работу')


def check_private_work_and_handoff(browser, base):
    data = fixture()
    visit = data['orders'][0]
    actor = data['userId']
    visit['vehicle_workflow'] = {'state': 'active', 'holder_id': actor}
    visit['tasks'] = [
        {'id': key, 'work_name': title, 'version': 1, 'status': status,
         'participants': [{'mechanic_id': worker, 'name': 'Иван' if worker == actor else 'Олег', 'status': personal}]}
        for key, title, status, worker, personal in [
            ('colleague', 'Личное назначение другого механика', 'pending', 'b', 'assigned'),
            ('cancelled', 'Отменённая услуга', 'cancelled', actor, 'assigned'),
            ('blocked', 'Подготовка кузова', 'blocked', actor, 'blocked'),
            ('assigned', 'Оклейка дверей', 'pending', actor, 'assigned'),
            ('working', 'Оклейка бампера', 'in_progress', actor, 'working'),
        ]
    ]
    cancelled = next(task for task in visit['tasks'] if task['id'] == 'cancelled')
    data['orders'].append({**visit, 'id': 'empty-work', 'order_number': 'GS-15',
                           'tasks': [{**cancelled, 'id': 'cancelled-only'}]})
    context, page, errors, live = smoke.new_page(browser, data, {'width': 390, 'height': 844})
    try:
        page.goto(base + '/index.html#shift/empty-work')
        cancelled_visit = page.locator('[data-vehicle-detail="empty-work"]')
        expect(cancelled_visit.get_by_text('Открыть работу', exact=True)).to_have_count(0)
        expect(cancelled_visit.get_by_role('button', name='Передать владельцу', exact=True)).not_to_have_class(re.compile(r'\bbutton-primary\b'))
        page.goto(base + '/index.html#assigned/11')
        detail = page.locator('[data-vehicle-detail="11"]')
        handoff = detail.get_by_role('button', name='Передать владельцу', exact=True)
        expect(detail.locator('[data-task-id]')).to_have_count(4)
        expect(detail.get_by_text('Личное назначение другого механика')).to_have_count(0)
        for key, title, begin in [('working', 'Оклейка бампера', None),
                                  ('assigned', 'Оклейка дверей', 'Начать работу'),
                                  ('blocked', 'Подготовка кузова', 'Продолжить работу')]:
            expect(detail.get_by_text('Открыть работу', exact=True)).to_have_count(1)
            expect(handoff).not_to_have_class(re.compile(r'\bbutton-primary\b'))
            button = work_button(detail, key)
            expect(button.get_by_text('Открыть работу', exact=True)).to_have_class(re.compile(r'\bbutton-primary\b'))
            before = page.evaluate('JSON.stringify(__garageOrderState.orders)')
            button.click()
            expect(page).to_have_url(base + '/index.html#assigned/' + key)
            task = page.locator(f'[data-task-detail="{key}"]')
            expect(task.get_by_role('heading', name=title, exact=True)).to_be_focused()
            assert page.evaluate('JSON.stringify(__garageOrderState.orders)') == before
            if begin:
                task.get_by_role('button', name=begin, exact=True).click()
            task.get_by_role('button', name='Подтвердить свою работу', exact=True).click()
            task.get_by_role('button', name='Подтвердить выполнение', exact=True).click()
            expect(task.get_by_text('Ваше выполнение учтено.', exact=True)).to_be_visible()
            task.get_by_role('button', name='← К автомобилю').click()
            expect(page).to_have_url(base + '/index.html#assigned/11')
            expect(detail.locator(f'[data-task-id="{key}"] button')).to_be_focused()
        expect(detail.get_by_text('Открыть работу', exact=True)).to_have_count(0)
        expect(handoff).to_have_class(re.compile(r'\bbutton-primary\b'))
        services = detail.get_by_role('heading', name='Работы по автомобилю', exact=True)
        assert handoff.bounding_box()['y'] < services.bounding_box()['y']
        page.evaluate("location.hash = 'history/11'")
        expect(detail.get_by_text('Ваше выполнение учтено', exact=True)).to_have_count(3)
        expect(handoff).not_to_have_class(re.compile(r'\bbutton-primary\b'))
        page.evaluate("location.hash = 'assigned/11'")
        expect(handoff).to_have_class(re.compile(r'\bbutton-primary\b'))
        handoff.click()
        form = detail.locator('form.vehicle-handoff')
        expect(form.get_by_role('heading', name='Выполнено · 3', exact=True)).to_be_visible()
        expect(form.get_by_role('heading', name='Осталось выполнить · 0', exact=True)).to_be_visible()
        form.get_by_role('button', name='Подтвердить передачу').click()
        receipt = detail.locator('.vehicle-receipt')
        expect(receipt).to_contain_text('Осталось выполнить · 0')
        expect(receipt).not_to_contain_text('Личное назначение другого механика')
        expect(detail.get_by_text('Открыть работу', exact=True)).to_have_count(0)
        expect(handoff).to_have_count(0)
        commands = page.evaluate("""__garageCalls.filter(c => ['garage_team_action','garage_vehicle_action'].includes(c.name))
                                   .map(c => [c.name, c.args.p_action, c.args.p_task_id || c.args.p_order_id])""")
        assert commands == [['garage_team_action', 'confirm', 'working'],
                            ['garage_team_action', 'start', 'assigned'], ['garage_team_action', 'confirm', 'assigned'],
                            ['garage_team_action', 'resume', 'blocked'], ['garage_team_action', 'confirm', 'blocked'],
                            ['garage_vehicle_action', 'handoff', '11']], commands
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
                expect(page.get_by_text('Открыть работу', exact=True)).to_have_count(0)
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
                expect(page.locator('[data-vehicle-detail="13"]').get_by_text('Открыть работу', exact=True)).to_have_count(0)
                page.get_by_role('button', name='← К списку').click()
                take = page.locator('[data-vehicle-id="13"]').get_by_role('button', name='Взять автомобиль', exact=True)
                context.set_offline(True)
                expect(take).to_be_disabled()
                context.set_offline(False)
                expect(take).to_be_enabled()
                take.click()
                detail = page.locator('[data-vehicle-detail="13"]')
                give_back = detail.get_by_role('button', name='Передать владельцу', exact=True)
                open_work = work_button(detail, 'task-13')
                expect(open_work).to_be_in_viewport(ratio=1)
                expect(give_back).to_be_in_viewport(ratio=1)
                expect(give_back).not_to_have_class(re.compile(r'\bbutton-primary\b'))
                assert open_work.bounding_box()['y'] < give_back.bounding_box()['y']
                expect(detail.locator('[data-task-id]')).to_have_count(2)
                context.set_offline(True)
                expect(give_back).to_be_disabled()
                expect(open_work).to_have_count(0)
                task_row = detail.locator('[data-task-id="task-13"] button')
                task_row.click()
                expect(page).to_have_url(base + '/index.html#manager-orders/task-13')
                expect(page.get_by_role('button', name='Начать работу', exact=True)).to_be_disabled()
                page.get_by_role('button', name='← К автомобилю').click()
                expect(task_row).to_be_focused()
                context.set_offline(False)
                expect(give_back).to_be_enabled()
                give_back.click()
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
                expect(detail.get_by_text('Открыть работу', exact=True)).to_have_count(0)
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
                check_private_work_and_handoff(browser, base)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Passed visit claims, work and handoff action priority, partial and complete handoff, offline drafts, keyboard focus and private assignments.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    run(args.directory, args.chromium)
