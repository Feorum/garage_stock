#!/usr/bin/env python3
"""Exercise the order UI with synthetic records and no live Supabase requests."""

import argparse
import importlib.util
import json
from pathlib import Path

from playwright.sync_api import sync_playwright, expect
from order_browser_helpers import navigate_section, open_visit


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('garage_browser_smoke', ROOT / 'tests/browser-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
ME = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'


def task(number, work='W01', assigned=ME, status='pending', worker=None):
    return {
        'id': f'bbbbbbbb-bbbb-4bbb-8bbb-{number:012d}',
        'work_code': work,
        'work_name': {'W01': 'капот полностью', 'W02': 'Бампер', 'W13': 'Зеркала'}[work],
        'status': status, 'assigned_to': assigned,
        'assigned_name': ('Test Mechanic' if assigned == ME else 'Other Mechanic') if assigned else None,
        'working_mechanic_id': worker, 'working_name': 'Test Mechanic' if worker == ME else None,
        'blocker_reason': '', 'version': 1, 'completed_at': None, 'options': {},
    }


def order(number, source='owner', tasks=None):
    return {
        'id': f'aaaaaaaa-aaaa-4aaa-8aaa-{number:012d}',
        'order_number': f'SYNTHETIC-{number:03d}',
        'vehicle': f'Synthetic vehicle {number}', 'vin': '', 'colour': 'Grey',
        'vehicle_group_code': 'VG02', 'vehicle_group_name': 'e7 new / S50',
        'source': source, 'status': 'published', 'instructions': 'Synthetic operational instructions',
        'planned_date': None, 'due_date': None, 'priority': 'normal', 'manager_label': 'Synthetic manager' if source == 'manager' else '',
        'version': 1, 'created_at': '2026-11-12T10:00:00Z',
        'tasks': tasks if tasks is not None else [task(number)],
    }


def rpc_calls(page, name):
    return page.evaluate('(name) => (__garageCalls || []).filter(call => call.method === "rpc" && call.name === name)', name)


def safe_mechanic(page):
    assert not rpc_calls(page, 'garage_staff')
    assert not rpc_calls(page, 'garage_order_financials')
    assert not rpc_calls(page, 'garage_owner_review_prices')
    assert not rpc_calls(page, 'garage_manager_intakes')
    assert not rpc_calls(page, 'garage_quote_order')
    assert not rpc_calls(page, 'garage_save_task_pricing')
    body = page.locator('body').inner_text()
    for forbidden in ('BYN', 'EUR', 'НДС', '€', 'Посмотреть стоимость'):
        assert forbidden not in body, forbidden
    assert not page.evaluate('(__garageCalls || []).some(call => ["insert", "delete", "upsert"].includes(call.method))')


def finish_context(context, errors, live):
    assert not errors, errors
    assert not live, live
    context.close()


def fill_order(page, vehicle='Synthetic new vehicle', source='owner'):
    page.get_by_role('link', name='Новый заказ', exact=True).click()
    page.get_by_role('combobox', name='Модель автомобиля', exact=True).select_option('manual')
    page.get_by_label('Автомобиль', exact=True).fill(vehicle)
    page.get_by_role('combobox', name='Группа автомобилей', exact=True).select_option('VG02')
    page.get_by_role('combobox', name='Источник заказа', exact=True).select_option(source)
    if source == 'owner':
        page.get_by_role('combobox', name='Назначить механика', exact=True).select_option(ME)
    else:
        page.get_by_label('Менеджер (необязательно)', exact=True).fill('Synthetic manager')
    page.get_by_role('checkbox', name='капот полностью', exact=True).check()


def check_preloaded_workspace(browser, base):
    visit = order(81)
    context, page, errors, live = smoke.new_page(browser, {'orders': [visit]})
    page.goto(base + '/index.html#shift/attention')
    expect(page).to_have_url(base + '/index.html#orders')
    row = page.locator(f'.od-order a[href="#orders/{visit["id"]}"]')
    expect(row).to_be_visible()
    sources = ['garage_list_orders', 'garage_manager_intakes', 'garage_custom_orders', 'garage_owner_review_prices',
               'garage_mechanic_rates', 'garage_pay_worklist', 'garage_sheet_pull_sources', 'garage_ledger_imports',
               'garage_staff', 'garage_owner_gift_offer', 'garage_owner_preferences']
    page.wait_for_function('names => names.every(n => __garageCalls.some(c => c.name === n))', arg=sources)
    counts = {name: len(rpc_calls(page, name)) for name in sources}
    nav = page.get_by_role('navigation', name='Кабинет владельца')
    for name in ['Главная', 'На проверке', 'Механики', 'Отчёты и история', 'Все заказы']:
        nav.get_by_role('link', name=name, exact=True).click()
        expect(page.get_by_role('heading', name=name, exact=True, level=1)).to_be_visible()
    assert {name: len(rpc_calls(page, name)) for name in sources} == counts
    expect(page.get_by_role('link', name='Смена и заявки')).to_have_count(0)
    row.click()
    delete = page.get_by_role('dialog').get_by_role('button', name='Удалить заказ', exact=True)
    page.once('dialog', lambda confirm: confirm.dismiss())
    delete.click()
    assert not rpc_calls(page, 'garage_permanently_delete_order')
    assert not rpc_calls(page, 'garage_delete_order')
    page.once('dialog', lambda confirm: confirm.accept())
    delete.click()
    expect(page).to_have_url(base + '/index.html#orders')
    expect(row).to_have_count(0)
    assert len(rpc_calls(page, 'garage_permanently_delete_order')) == 1
    assert not rpc_calls(page, 'garage_delete_order')
    page.evaluate("location.hash = '#orders/tools'")
    expect(page).to_have_url(base + '/index.html#orders')
    expect(page.get_by_role('heading', name='Все заказы', level=1)).to_be_visible()
    finish_context(context, errors, live)


def check_drawer_return(browser, base):
    completed = task(86, status='completed', worker=ME)
    completed['completed_at'] = '2026-11-18T09:00:00Z'
    visit = order(86, tasks=[completed])
    context, page, errors, live = smoke.new_page(browser, {'orders': [visit]})
    report_url = base + '/index.html#reports/activity'
    page.goto(report_url)
    since = page.get_by_label('С даты', exact=True)
    since.fill('2026-11-18')
    row = page.get_by_role('button', name='Открыть заказ · ' + visit['vehicle'])
    row.click()
    dialog = page.get_by_role('dialog', name='Карточка заказа')
    expect(dialog.get_by_role('heading', name=visit['vehicle'], exact=True)).to_be_visible()

    # Back and Forward travel actual entries. Closing a nested editor returns in one step.
    page.go_back()
    expect(page).to_have_url(report_url)
    expect(since).to_have_value('2026-11-18')
    expect(row).to_be_focused()
    page.go_forward()
    dialog.get_by_role('button', name='Изменить заказ', exact=True).click()
    expect(dialog.get_by_role('heading', name='Изменить заказ')).to_be_visible()
    dialog.get_by_role('button', name='Закрыть карточку заказа').click()
    expect(page).to_have_url(report_url)
    expect(since).to_have_value('2026-11-18')
    expect(row).to_be_focused()

    # Reloading the detail starts a new workspace and has no mounted opener.
    row.click()
    expect(dialog).to_be_visible()
    page.reload()
    expect(dialog.get_by_role('heading', name=visit['vehicle'], exact=True)).to_be_visible()
    page.keyboard.press('Escape')
    expect(page).to_have_url(base + '/index.html#orders')
    expect(page.get_by_role('heading', name='Все заказы', exact=True)).to_be_visible()
    finish_context(context, errors, live)


def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    server, base = smoke.serve(args.directory.resolve())
    passed = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        try:
            check_preloaded_workspace(browser, base)
            passed.append('Owner navigation reuses preloaded data and archived URLs lead to the journal with permanent deletion')
            check_drawer_return(browser, base)
            passed.append('Closing an order restores the filtered report and opener, with a journal fallback after reload')
            context, page, errors, live = smoke.new_page(browser, {})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            page.get_by_role('link', name='Новый заказ', exact=True).click()
            model = page.get_by_role('combobox', name='Модель автомобиля', exact=True)
            model.select_option('BELGEE X50+')
            model.select_option('GEELY MONJARO (матовый)')
            expect(page.get_by_label('Группа автомобилей', exact=True)).to_have_count(0)
            page.get_by_role('combobox', name='Назначить механика', exact=True).select_option(ME)
            page.get_by_role('checkbox', name='капот полностью', exact=True).check()
            page.get_by_role('button', name='Отправить заказ', exact=True).click()
            expect(page.get_by_role('heading', name='GEELY MONJARO (матовый)', exact=True)).to_be_visible()
            payload = rpc_calls(page, 'garage_save_team_order')[0]['args']['p_order']
            assert (payload['vehicle'], payload['vehicle_group_code']) == ('GEELY MONJARO (матовый)', 'VG12')
            finish_context(context, errors, live)
            passed.append('model picker preserves make and finish and resolves the price group automatically')

            # The form offers the approved matrix and requires assignment for direct orders.
            context, page, errors, live = smoke.new_page(browser, {})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            page.get_by_role('link', name='Новый заказ', exact=True).click()
            page.get_by_role('combobox', name='Модель автомобиля', exact=True).select_option('manual')
            page.get_by_label('Автомобиль', exact=True).fill('Synthetic assigned vehicle')
            page.get_by_role('combobox', name='Группа автомобилей', exact=True).select_option('VG01')
            unavailable = page.get_by_role('checkbox', name='крылья целиком (2шт)', exact=True)
            assert unavailable.count() == 0 or unavailable.is_disabled()
            page.get_by_role('combobox', name='Группа автомобилей', exact=True).select_option('VG02')
            page.get_by_role('checkbox', name='крылья целиком (2шт)', exact=True).check()
            page.get_by_role('combobox', name='Группа автомобилей', exact=True).select_option('VG01')
            page.get_by_role('checkbox', name='капот полностью', exact=True).check()
            page.get_by_role('button', name='Отправить заказ', exact=True).click()
            assert not rpc_calls(page, 'garage_save_team_order'), 'Unassigned direct work must not be sent.'
            page.get_by_role('combobox', name='Назначить механика', exact=True).select_option(ME)
            page.get_by_label('Плановая дата (необязательно)', exact=True).fill('2026-11-14')
            page.get_by_label('Срок выполнения (необязательно)', exact=True).fill('2026-11-15')
            page.evaluate('window.scrollTo(0, 0)')
            page.screenshot(path=str(args.output / 'owner-create-order.png'), full_page=True)
            page.get_by_role('button', name='Отправить заказ', exact=True).click()
            expect(page.get_by_role('heading', name='Synthetic assigned vehicle', exact=True)).to_be_visible()
            calls = rpc_calls(page, 'garage_save_team_order')
            assert len(calls) == 1
            assert calls[0]['args']['p_order']['source'] == 'owner'
            assert calls[0]['args']['p_order']['planned_date'] == '2026-11-14'
            assert calls[0]['args']['p_order']['due_date'] == '2026-11-15'
            assert all(item['assigned_to'] == ME for item in calls[0]['args']['p_tasks'])
            assert all(item['work_code'] != 'W05' for item in calls[0]['args']['p_tasks'])
            passed.append('Owner creates assigned work with closed model/work choices')
            finish_context(context, errors, live)

            context, page, errors, live = smoke.new_page(browser, {'rpcDelays': {'garage_save_team_order': 400}})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            fill_order(page, 'Synthetic tinted vehicle')
            page.get_by_role('checkbox', name='тонировка задней полусферы (5%,15%)', exact=True).check()
            tint = page.get_by_role('combobox', name='Светопропускание', exact=True)
            expect(tint).to_be_visible()
            assert tint.locator('option').count() == 3
            page.get_by_role('button', name='Отправить заказ', exact=True).click()
            assert not rpc_calls(page, 'garage_save_team_order')
            tint.select_option('15')
            send = page.get_by_role('button', name='Отправить заказ', exact=True)
            send.click()
            expect(send).to_be_disabled()
            expect(page.get_by_role('heading', name='Synthetic tinted vehicle', exact=True)).to_be_visible()
            calls = rpc_calls(page, 'garage_save_team_order')
            assert len(calls) == 1
            tint_task = next(item for item in calls[0]['args']['p_tasks'] if item['work_code'] == 'W19')
            assert tint_task['options'] == {'tint_percent': 15}
            passed.append('tinting requires an approved option and pending submission is disabled')
            finish_context(context, errors, live)

            # An acknowledgement lost after commit must not create a second vehicle order.
            context, page, errors, live = smoke.new_page(browser, {'loseCreateResponseOnce': True})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            fill_order(page, 'Synthetic retry vehicle')
            page.get_by_role('button', name='Отправить заказ', exact=True).click()
            expect(page.get_by_role('button', name='Отправить заказ', exact=True)).to_be_enabled()
            page.get_by_role('button', name='Отправить заказ', exact=True).click()
            expect(page.get_by_role('heading', name='Synthetic retry vehicle', exact=True)).to_be_visible()
            calls = rpc_calls(page, 'garage_save_team_order')
            assert len(calls) == 2
            assert calls[0]['args']['p_request_id'] == calls[1]['args']['p_request_id']
            assert page.evaluate('__garageOrderState.orders.length') == 1
            passed.append('ambiguous create retry reuses request identity and creates one order')
            finish_context(context, errors, live)

            # Manager-origin work is shared, with no forced assignee.
            context, page, errors, live = smoke.new_page(browser, {})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            fill_order(page, 'Synthetic manager vehicle', 'manager')
            page.get_by_role('button', name='Отправить заказ', exact=True).click()
            expect(page.get_by_role('heading', name='Synthetic manager vehicle', exact=True)).to_be_visible()
            submitted = rpc_calls(page, 'garage_save_team_order')[0]['args']
            assert submitted['p_order']['source'] == 'manager'
            assert all(not item.get('assigned_to') for item in submitted['p_tasks'])
            passed.append('Manager-origin order is published without mandatory assignment')
            finish_context(context, errors, live)

            completed = task(10, assigned=ME, status='completed', worker=ME)
            completed['completed_at'] = '2026-11-12T09:00:00Z'
            pending = task(11, 'W02')
            owner_order = order(10, tasks=[completed, pending])
            owner_order['vehicle_workflow'] = {'state': 'active', 'holder_id': ME}
            context, page, errors, live = smoke.new_page(browser, {'orders': [owner_order]})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            page.locator(f'[data-order-id="{owner_order["id"]}"]').click()
            page.get_by_role('button', name='Изменить заказ', exact=True).click()
            card = page.locator(f'tbody[data-task-id="{pending["id"]}"]')
            card.get_by_role('button', name='Команда и заметки', exact=True).click()
            card.get_by_role('button', name='Переназначить', exact=True).click()
            card.get_by_role('combobox', name='Новый механик', exact=True).select_option(OTHER)
            card.get_by_label('Причина', exact=True).fill('Synthetic reassignment reason')
            card.get_by_role('button', name='Подтвердить переназначение', exact=True).click()
            expect(card.get_by_text('Other Mechanic · Назначено', exact=True)).to_be_visible()
            card.get_by_role('button', name='Отменить работу', exact=True).click()
            card.get_by_label('Причина', exact=True).fill('Synthetic scope reduction')
            card.get_by_role('button', name='Подтвердить отмену', exact=True).click()
            expect(card.get_by_text('Отменено', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Принять и закрыть заказ', exact=True)).to_have_count(0)
            assert page.evaluate('__garageOrderState.orders[0].tasks[0].status') == 'completed'
            finish_context(context, errors, live)
            # The Owner can close this visit only after a mechanic has handed it back.
            owner_order['tasks'][1]['status'] = 'cancelled'
            owner_order['vehicle_workflow'] = {'state': 'review', 'holder_id': ME,
                'handoff_tasks': [{key: t[key] for key in ('id', 'work_name', 'status')} for t in owner_order['tasks']]}
            context, page, errors, live = smoke.new_page(browser, {'orders': [owner_order]})
            page.goto(base + '/index.html#orders/' + owner_order['id'])
            page.get_by_role('button', name='Принять и закрыть заказ', exact=True).click()
            page.wait_for_function("__garageOrderState.orders[0].status === 'closed'")
            page.get_by_role('button', name='К списку заказов', exact=True).click()
            expect(page.get_by_role('region', name='Подробности заказа')).to_have_count(0)
            page.get_by_role('combobox', name='Статус заказа', exact=True).select_option('closed')
            closed_row = page.locator(f'[data-order-id="{owner_order["id"]}"]')
            expect(closed_row.get_by_text('Закрыт', exact=True)).to_be_visible()
            assert page.evaluate('__garageOrderState.orders[0].status') == 'closed'
            assert page.evaluate('__garageOrderState.orders[0].tasks[0].status') == 'completed'
            passed.append('Owner reassigns, cancels remaining scope and closes without deleting completed work')
            finish_context(context, errors, live)

            # Direct assignments are private and cannot be dropped into the shared queue.
            assigned = order(1)
            other = order(2, tasks=[task(2, assigned=OTHER)])
            shared = order(3, 'manager', [task(3, 'W13', assigned=None)])
            context, page, errors, live = smoke.new_page(browser, {
                'profile': {'name': 'Test Mechanic', 'role': 'mechanic'}, 'orders': [assigned, other, shared],
                'rpcDelays': {'garage_list_orders': 150},
            }, {'width': 390, 'height': 844})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Mechanic')
            expect(page.get_by_text('Synthetic vehicle 1', exact=True)).to_be_visible()
            expect(page.get_by_text('Synthetic vehicle 2', exact=True)).to_have_count(0)
            private_card = open_visit(page, assigned['id'])
            row = private_card.locator(f'[data-task-id="{assigned["tasks"][0]["id"]}"]')
            row.get_by_role('checkbox').click()
            expect(row.locator(f'[data-mechanic-id="{ME}"]')).to_be_visible()
            expect(page.get_by_text('Synthetic vehicle 2', exact=True)).to_have_count(0)
            page.screenshot(path=str(args.output / 'mechanic-active-order.png'), full_page=True)
            safe_mechanic(page)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            passed.append('mechanic marks an assigned private service inline without seeing other private orders or finances')
            page.get_by_role('link', name='Заказы менеджеров', exact=True).click()
            shared_card = open_visit(page, shared['id'])
            row = shared_card.locator(f'[data-task-id="{shared["tasks"][0]["id"]}"]')
            row.get_by_role('checkbox').click()
            expect(row.locator(f'[data-mechanic-id="{ME}"]')).to_be_visible()
            assert [entry['args']['p_task_id'] for entry in rpc_calls(page, 'garage_check_work')] == [
                assigned['tasks'][0]['id'], shared['tasks'][0]['id']]
            assert not rpc_calls(page, 'garage_vehicle_action') and not rpc_calls(page, 'garage_team_action')
            safe_mechanic(page)
            passed.append('shared Manager work can be checked without a reservation or membership request')
            finish_context(context, errors, live)

            # A late order response cannot paint private data over a different section or logout.
            context, page, errors, live = smoke.new_page(browser, {
                'orders': [order(9)], 'rpcDelays': {'garage_list_orders': 600},
            })
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            page.wait_for_function("(__garageCalls || []).some(call => call.name === 'garage_list_orders')")
            page.get_by_role('link', name='Отчёты и история', exact=True).click()
            page.get_by_role('link', name='Подключения таблиц', exact=True).click()
            expect(page.get_by_role('heading', name='Подключения таблиц', exact=True)).to_be_visible()
            page.wait_for_timeout(750)
            expect(page.get_by_role('heading', name='Подключения таблиц', exact=True)).to_be_visible()
            expect(page.get_by_text('Synthetic vehicle 9', exact=True)).to_have_count(0)
            navigate_section(page, 'Все заказы')
            smoke.sign_out(page)
            expect(page.get_by_role('button', name='Войти', exact=True)).to_be_visible()
            page.wait_for_timeout(750)
            expect(page.get_by_role('button', name='Войти', exact=True)).to_be_visible()
            expect(page.get_by_text('Synthetic vehicle 9', exact=True)).to_have_count(0)
            passed.append('late order loads are disposed after route change and logout')
            finish_context(context, errors, live)

            # The completion instant at 21:00 UTC belongs to the next calendar day in Minsk.
            earlier = task(41, assigned=ME, status='completed', worker=ME)
            earlier['completed_at'] = '2026-11-12T20:59:59Z'
            together = task(42, assigned=ME, status='completed', worker=ME)
            together['completed_at'] = '2026-11-12T21:00:00Z'
            together['participants'] = [{'mechanic_id': participant, 'name': name, 'status': 'confirmed'}
                                        for participant, name in [(ME, 'Test Mechanic'), (OTHER, 'Other Mechanic')]]
            blocked = task(43, assigned=ME, status='blocked', worker=ME)
            context, page, errors, live = smoke.new_page(browser, {'orders': [
                order(41, tasks=[earlier]), order(42, tasks=[together]), order(43, tasks=[blocked])
            ]})
            page.goto(base + '/index.html#reports')
            page.get_by_role('link', name='Отчёт по работам', exact=True).click()
            page.get_by_label('С даты', exact=True).fill('2026-11-13')
            page.get_by_label('По дату', exact=True).fill('2026-11-13')
            expect(page.get_by_text('1 за выбранный период', exact=True)).to_be_visible()
            expect(page.get_by_text('Test Mechanic · участий: 1', exact=True)).to_be_visible()
            expect(page.get_by_text('Other Mechanic · участий: 1', exact=True)).to_be_visible()
            expect(page.get_by_text('Незавершённых работ: 1 · с приостановкой: 1', exact=True)).to_be_visible()
            page.get_by_label('С даты', exact=True).fill('2026-11-14')
            expect(page.get_by_role('alert')).to_contain_text('Дата начала должна быть раньше даты окончания')
            expect(page.get_by_text('Незавершённых работ: 1 · с приостановкой: 1', exact=True)).to_be_visible()
            page.get_by_label('С даты', exact=True).fill('2026-11-13')
            page.get_by_role('combobox', name='Механик', exact=True).select_option(OTHER)
            expect(page.get_by_text('Test Mechanic · участий: 1', exact=True)).to_have_count(0)
            expect(page.get_by_text('Незавершённых работ: 0 · с приостановкой: 0', exact=True)).to_be_visible()
            page.get_by_role('button', name='Открыть заказ · Synthetic vehicle 42', exact=True).click()
            expect(page.get_by_role('heading', name='Synthetic vehicle 42', exact=True)).to_be_visible()
            passed.append('Minsk period reports count team work once, show participant credit, and separate current backlog')
            finish_context(context, errors, live)

            # A failed staff fetch must have a working recovery path for order creation.
            context, page, errors, live = smoke.new_page(browser, {
                'rpcErrors': {'garage_staff': 'Temporary staff lookup failure'},
            })
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            page.get_by_role('link', name='Новый заказ', exact=True).click()
            staff_error = page.get_by_role('status').filter(has_text='Не удалось загрузить механиков.')
            expect(staff_error).to_be_visible()
            # Mount and Realtime subscription can each refresh the roster.
            failed_reads = len(rpc_calls(page, 'garage_staff'))
            page.evaluate('delete __garageTest.rpcErrors.garage_staff')
            staff_error.get_by_role('button', name='Повторить загрузку механиков').click()
            expect(staff_error).to_have_count(0)
            expect(page.get_by_role('combobox', name='Назначить механика', exact=True)).to_be_visible()
            assert len(rpc_calls(page, 'garage_staff')) > failed_reads
            passed.append('transient staff lookup failure can recover without a page reload')
            finish_context(context, errors, live)
        finally:
            browser.close()
            server.shutdown()
            server.server_close()
    result = {'passed': passed, 'count': len(passed), 'live_database_requests': 0}
    (args.output / 'orders-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--output', type=Path, default=Path('/workspace/scratch/orders-smoke'))
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    run(parser.parse_args())
