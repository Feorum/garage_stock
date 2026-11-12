#!/usr/bin/env python3
"""Exercise the order UI with synthetic records and no live Supabase requests."""

import argparse
import importlib.util
import json
from pathlib import Path

from playwright.sync_api import sync_playwright, expect


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


def task_card(page, task_id):
    return page.locator(f'[data-task-id="{task_id}"]')


def safe_mechanic(page):
    assert not rpc_calls(page, 'garage_staff')
    assert not rpc_calls(page, 'garage_order_financials')
    body = page.locator('body').inner_text()
    for forbidden in ('BYN', 'EUR', 'VAT', '€', 'View Owner amounts'):
        assert forbidden not in body, forbidden
    assert not page.evaluate('(__garageCalls || []).some(call => ["insert", "delete", "upsert"].includes(call.method))')


def finish_context(context, errors, live):
    assert not errors, errors
    assert not live, live
    context.close()


def fill_order(page, vehicle='Synthetic new vehicle', source='owner'):
    page.get_by_role('button', name='New order', exact=True).click()
    page.get_by_label('Vehicle', exact=True).fill(vehicle)
    page.get_by_label('Vehicle group', exact=True).select_option('VG02')
    page.get_by_label('Order source', exact=True).select_option(source)
    if source == 'owner':
        page.get_by_label('Assign mechanic', exact=True).select_option(ME)
    else:
        page.get_by_label('Manager label (optional)', exact=True).fill('Synthetic manager')
    page.get_by_role('checkbox', name='капот полностью', exact=True).check()


def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    server, base = smoke.serve(args.directory.resolve())
    passed = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        try:
            # The form offers the approved matrix and requires assignment for direct orders.
            context, page, errors, live = smoke.new_page(browser, {})
            page.goto(base + '/index.html')
            smoke.ready(page, 'Test Owner')
            page.get_by_role('button', name='New order', exact=True).click()
            page.get_by_label('Vehicle', exact=True).fill('Synthetic assigned vehicle')
            page.get_by_label('Vehicle group', exact=True).select_option('VG01')
            unavailable = page.get_by_role('checkbox', name='крылья целиком (2шт)', exact=True)
            assert unavailable.count() == 0 or unavailable.is_disabled()
            page.get_by_label('Vehicle group', exact=True).select_option('VG02')
            page.get_by_role('checkbox', name='крылья целиком (2шт)', exact=True).check()
            page.get_by_label('Vehicle group', exact=True).select_option('VG01')
            page.get_by_role('checkbox', name='капот полностью', exact=True).check()
            page.get_by_role('button', name='Send order', exact=True).click()
            assert not rpc_calls(page, 'garage_create_order'), 'Unassigned direct work must not be sent.'
            page.get_by_label('Assign mechanic', exact=True).select_option(ME)
            page.get_by_label('Planned date (optional)', exact=True).fill('2026-11-14')
            page.get_by_label('Due date (optional)', exact=True).fill('2026-11-15')
            page.evaluate('window.scrollTo(0, 0)')
            page.screenshot(path=str(args.output / 'owner-create-order.png'), full_page=True)
            page.get_by_role('button', name='Send order', exact=True).click()
            expect(page.get_by_text('Synthetic assigned vehicle', exact=True)).to_be_visible()
            calls = rpc_calls(page, 'garage_create_order')
            assert len(calls) == 1
            assert calls[0]['args']['p_source'] == 'owner'
            assert calls[0]['args']['p_planned_date'] == '2026-11-14'
            assert calls[0]['args']['p_due_date'] == '2026-11-15'
            assert all(item['assigned_to'] == ME for item in calls[0]['args']['p_tasks'])
            assert all(item['work_code'] != 'W05' for item in calls[0]['args']['p_tasks'])
            passed.append('Owner creates assigned work with closed model/work choices')
            finish_context(context, errors, live)

            context, page, errors, live = smoke.new_page(browser, {'rpcDelays': {'garage_create_order': 400}})
            page.goto(base + '/index.html')
            smoke.ready(page, 'Test Owner')
            fill_order(page, 'Synthetic tinted vehicle')
            page.get_by_role('checkbox', name='тонировка задней полусферы (5%,15%)', exact=True).check()
            tint = page.get_by_label('Tint level', exact=True)
            expect(tint).to_be_visible()
            assert tint.locator('option').count() == 3
            page.get_by_role('button', name='Send order', exact=True).click()
            assert not rpc_calls(page, 'garage_create_order')
            tint.select_option('15')
            send = page.get_by_role('button', name='Send order', exact=True)
            send.click()
            expect(send).to_be_disabled()
            expect(page.get_by_text('Synthetic tinted vehicle', exact=True)).to_be_visible()
            calls = rpc_calls(page, 'garage_create_order')
            assert len(calls) == 1
            tint_task = next(item for item in calls[0]['args']['p_tasks'] if item['work_code'] == 'W19')
            assert tint_task['options'] == {'tint_percent': 15}
            passed.append('tinting requires an approved option and pending submission is disabled')
            finish_context(context, errors, live)

            # An acknowledgement lost after commit must not create a second vehicle order.
            context, page, errors, live = smoke.new_page(browser, {'loseCreateResponseOnce': True})
            page.goto(base + '/index.html')
            smoke.ready(page, 'Test Owner')
            fill_order(page, 'Synthetic retry vehicle')
            page.get_by_role('button', name='Send order', exact=True).click()
            expect(page.get_by_role('button', name='Send order', exact=True)).to_be_enabled()
            page.get_by_role('button', name='Send order', exact=True).click()
            expect(page.get_by_text('Synthetic retry vehicle', exact=True)).to_be_visible()
            calls = rpc_calls(page, 'garage_create_order')
            assert len(calls) == 2
            assert calls[0]['args']['p_request_id'] == calls[1]['args']['p_request_id']
            assert page.evaluate('__garageOrderState.orders.length') == 1
            passed.append('ambiguous create retry reuses request identity and creates one order')
            finish_context(context, errors, live)

            # Manager-origin work is shared, with no forced assignee.
            context, page, errors, live = smoke.new_page(browser, {})
            page.goto(base + '/index.html')
            smoke.ready(page, 'Test Owner')
            fill_order(page, 'Synthetic manager vehicle', 'manager')
            page.get_by_role('button', name='Send order', exact=True).click()
            expect(page.get_by_text('Synthetic manager vehicle', exact=True)).to_be_visible()
            submitted = rpc_calls(page, 'garage_create_order')[0]['args']
            assert submitted['p_source'] == 'manager'
            assert all(not item.get('assigned_to') for item in submitted['p_tasks'])
            passed.append('Manager-origin order is published without mandatory assignment')
            finish_context(context, errors, live)

            completed = task(10, assigned=ME, status='completed', worker=ME)
            completed['completed_at'] = '2026-11-12T09:00:00Z'
            pending = task(11, 'W02')
            owner_order = order(10, tasks=[completed, pending])
            context, page, errors, live = smoke.new_page(browser, {'orders': [owner_order]})
            page.goto(base + '/index.html')
            smoke.ready(page, 'Test Owner')
            card = task_card(page, pending['id'])
            card.get_by_role('button', name='Reassign', exact=True).click()
            card.get_by_label('New mechanic', exact=True).select_option(OTHER)
            card.get_by_label('Reason', exact=True).fill('Synthetic reassignment reason')
            card.get_by_role('button', name='Confirm reassignment', exact=True).click()
            expect(card.get_by_text('Assigned to Other Mechanic', exact=True)).to_be_visible()
            card.get_by_role('button', name='Cancel task', exact=True).click()
            card.get_by_label('Reason', exact=True).fill('Synthetic scope reduction')
            card.get_by_role('button', name='Confirm cancellation', exact=True).click()
            expect(card.get_by_text('Cancelled', exact=True)).to_be_visible()
            page.get_by_role('button', name='Close order', exact=True).click()
            page.get_by_label('Order status', exact=True).select_option('closed')
            expect(page.get_by_text('Synthetic vehicle 10', exact=True)).to_be_visible()
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
            }, {'width': 390, 'height': 844})
            page.goto(base + '/index.html')
            smoke.ready(page, 'Test Mechanic')
            expect(page.get_by_text('Synthetic vehicle 1', exact=True)).to_be_visible()
            expect(page.get_by_text('Synthetic vehicle 2', exact=True)).to_have_count(0)
            card = task_card(page, assigned['tasks'][0]['id'])
            card.get_by_role('button', name='Start task', exact=True).click()
            expect(card.get_by_role('button', name='Complete task', exact=True)).to_be_visible()
            expect(card.get_by_role('button', name='Return to queue', exact=True)).to_have_count(0)
            card.get_by_role('button', name='Block task', exact=True).click()
            card.get_by_label('Reason', exact=True).fill('Synthetic preparation blocker')
            card.get_by_role('button', name='Save reason', exact=True).click()
            expect(card.get_by_role('button', name='Resume task', exact=True)).to_be_visible()
            expect(card.get_by_text('Blocked: Synthetic preparation blocker', exact=True)).to_be_visible()
            card.get_by_role('button', name='Resume task', exact=True).click()
            expect(card.get_by_role('button', name='Complete task', exact=True)).to_be_visible()
            page.evaluate('window.scrollTo(0, 0)')
            page.screenshot(path=str(args.output / 'mechanic-active-order.png'), full_page=True)
            card.get_by_role('button', name='Complete task', exact=True).click()
            page.get_by_role('link', name='My work', exact=True).click()
            expect(page.get_by_text('Synthetic vehicle 1', exact=True)).to_be_visible()
            assert page.evaluate("__garageOrderState.orders[0].tasks[0].status") == 'completed'
            safe_mechanic(page)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            passed.append('assigned mechanic starts, blocks, resumes and completes without financial access')
            page.get_by_role('link', name='Manager orders', exact=True).click()
            shared_card = task_card(page, shared['tasks'][0]['id'])
            shared_card.get_by_role('button', name='Start task', exact=True).click()
            page.get_by_role('link', name='My work', exact=True).click()
            shared_card = task_card(page, shared['tasks'][0]['id'])
            expect(shared_card.get_by_role('button', name='Complete task', exact=True)).to_be_visible()
            shared_card.get_by_role('button', name='Return to queue', exact=True).click()
            shared_card.get_by_label('Reason', exact=True).fill('Synthetic shared release reason')
            shared_card.get_by_role('button', name='Confirm return', exact=True).click()
            page.get_by_role('link', name='Manager orders', exact=True).click()
            expect(task_card(page, shared['tasks'][0]['id']).get_by_role('button', name='Start task', exact=True)).to_be_visible()
            safe_mechanic(page)
            passed.append('mechanic self-claims and explicitly returns a Manager task without changing Owner assignments')
            finish_context(context, errors, live)

            # A late order response cannot paint private data over a different section or logout.
            context, page, errors, live = smoke.new_page(browser, {
                'orders': [order(9)], 'rpcDelays': {'garage_list_orders': 600},
            })
            page.goto(base + '/index.html')
            smoke.ready(page, 'Test Owner')
            page.wait_for_function("(__garageCalls || []).some(call => call.name === 'garage_list_orders')")
            page.get_by_role('link', name='Approved works', exact=True).click()
            expect(page.get_by_label('Vehicle group', exact=True)).to_be_visible()
            page.wait_for_timeout(750)
            expect(page.get_by_role('heading', name='Approved works', exact=True)).to_be_visible()
            expect(page.get_by_text('Synthetic vehicle 9', exact=True)).to_have_count(0)
            page.get_by_role('link', name='Orders', exact=True).click()
            page.get_by_role('button', name='Sign out', exact=True).click()
            expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
            page.wait_for_timeout(750)
            expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
            expect(page.get_by_text('Synthetic vehicle 9', exact=True)).to_have_count(0)
            passed.append('late order loads are disposed after route change and logout')
            finish_context(context, errors, live)

            # A failed staff fetch must have a working recovery path for order creation.
            context, page, errors, live = smoke.new_page(browser, {
                'rpcErrors': {'garage_staff': {'times': 1, 'message': 'Temporary staff lookup failure'}},
            })
            page.goto(base + '/index.html')
            smoke.ready(page, 'Test Owner')
            expect(page.get_by_role('button', name='New order', exact=True)).to_be_disabled()
            page.get_by_role('button', name='Refresh', exact=True).click()
            expect(page.get_by_role('button', name='New order', exact=True)).to_be_enabled()
            page.get_by_role('button', name='New order', exact=True).click()
            expect(page.get_by_label('Assign mechanic', exact=True)).to_be_visible()
            assert len(rpc_calls(page, 'garage_staff')) == 2
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
