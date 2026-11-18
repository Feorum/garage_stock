#!/usr/bin/env python3
"""Owner interpretation, editing, compact ordering and price privacy with synthetic data."""
import argparse
import importlib.util
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from order_browser_helpers import task_card

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('garage_owner_editor_smoke', ROOT / 'tests/browser-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
ME = '11111111-1111-4111-8111-111111111111'
SOURCE = '33333333-3333-4333-8333-333333333333'
INTAKE = '44444444-4444-4444-8444-444444444444'

def task(code='W01', status='pending', number=1):
    return {'id': f'bbbbbbbb-bbbb-4bbb-8bbb-{number:012d}', 'work_code': code,
            'work_name': {'W01': 'капот полностью', 'W09': 'Зона над лобовым', 'W19': 'тонировка задней полусферы (5%,15%)'}[code],
            'options': {'tint_percent': 15} if code == 'W19' else {}, 'instructions': 'Keep recorded instruction',
            'status': status, 'assigned_to': None, 'assigned_name': None,
            'working_mechanic_id': ME if status != 'pending' else None, 'working_name': 'Test Mechanic' if status != 'pending' else None,
            'version': 1, 'completed_at': None, 'blocker_reason': ''}

def order(row, number=1, tasks=None, source=True):
    return {'id': f'aaaaaaaa-aaaa-4aaa-8aaa-{number:012d}', 'order_number': f'SYNTHETIC-{number:03d}',
            'vehicle': f'Synthetic vehicle {row}', 'vin': 'TEST0000000000001', 'colour': 'Grey',
            'vehicle_group_code': 'VG02', 'vehicle_group_name': 'e7 new / S50', 'source': 'manager',
            'source_id': SOURCE if source else None, 'source_name': 'Synthetic Manager table' if source else None,
            'source_row_number': row if source else None, 'manager_label': 'Synthetic manager',
            'planned_date': '2026-11-15', 'due_date': None, 'priority': 'normal', 'status': 'published',
            'instructions': 'Указания по работе', 'version': 1, 'created_at': '2026-11-15T10:00:00Z',
            'tasks': tasks or [task(number=number)]}

def intake(row=169):
    raw = {'date': '15.11.2026', 'manager_label': 'Synthetic manager', 'vehicle': 'S50',
           'vin': 'TEST0000000000009', 'colour': 'Grey', 'wrapping': 'Free-written custom request',
           'tint': '', 'completion': 'FALSE', 'notes': 'Private synthetic reference BYN 900'}
    return {'id': INTAKE, 'version': 1, 'source_id': SOURCE, 'source_name': 'Synthetic Manager table',
            'row_numbers': [row], 'source_key': 'synthetic-private-key', 'status': 'pending',
            'original': raw, 'latest': raw, 'suggested_order': {'vehicle': 'S50', 'vin': raw['vin'],
             'colour': 'Grey', 'vehicle_group_code': 'VG02', 'planned_date': '2026-11-15',
             'manager_label': 'Synthetic manager', 'instructions': ''}, 'suggested_tasks': [],
            'issues': ['NO_APPROVED_TASKS'], 'order_id': None, 'owner_managed': False, 'source_changed': False}

def calls(page, name):
    return page.evaluate('(name) => (__garageCalls || []).filter(c => c.name === name)', name)

def expand(page, selector):
    page.locator(selector).click()
    panel = page.get_by_role('region', name='Подробности заказа', exact=True)
    expect(panel).to_be_visible()
    return panel

def finish(context, errors, live):
    assert not errors, errors
    assert not live, live
    context.close()

def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    server, base = smoke.serve(args.directory.resolve())
    passed, layouts = [], []
    capture_script = args.capture_script.read_text(encoding='utf-8') if args.capture_script else None
    def capture(page, width, state):
        if not capture_script:
            return
        snapshot = page.evaluate(capture_script)
        snapshot['name'] = f'owner-orders-{width}-{state}'
        (args.output / f'spacing-{width}-{state}.json').write_text(json.dumps(snapshot,indent=2),encoding='utf-8')
        page.screenshot(path=str(args.output / f'owner-orders-{width}-{state}.png'),full_page=True)
        if width == 1440:
            (args.output / f'owner-orders-{state}.html').write_text(page.content(),encoding='utf-8')
        visible_copy = page.evaluate('''() => ({
          headings:[...document.querySelectorAll('h1,h2,h3,legend')].filter(n=>n.checkVisibility()).map(n=>n.innerText),
          actions:[...document.querySelectorAll('button,a,summary')].filter(n=>n.checkVisibility()).map(n=>n.innerText),
          body:document.body.innerText
        })''')
        (args.output / f'visible-copy-{width}-{state}.json').write_text(json.dumps(visible_copy,indent=2),encoding='utf-8')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        try:
            fixture = {'orders': [order(177, 2), order(0, 3, source=False), order(168, 1)], 'managerIntakes': [intake()]}
            if args.before_directory:
                before_server, before_base = smoke.serve(args.before_directory.resolve())
                try:
                    for width in [390, 1440]:
                        context, page, errors, live = smoke.new_page(browser, fixture, {'width':width,'height':1000})
                        page.goto(before_base + '/index.html')
                        smoke.ready(page, 'Test Owner')
                        expect(page.locator('[data-order-id]')).to_have_count(3)
                        page.screenshot(path=str(args.output / f'before-orders-{width}.png'),full_page=True)
                        finish(context, errors, live)
                finally:
                    before_server.shutdown(); before_server.server_close()
            for width in [390, 1440, 1728]:
                context, page, errors, live = smoke.new_page(browser, fixture, {'width': width, 'height': 1000})
                page.goto(base + '/index.html#orders')
                smoke.ready(page, 'Test Owner')
                expect(page.locator('.compact-order')).to_have_count(4)
                sequence = page.locator('.compact-order').evaluate_all('(rows) => rows.map(row => row.dataset.intakeId || row.dataset.orderId)')
                assert sequence == [fixture['orders'][2]['id'], INTAKE, fixture['orders'][0]['id'], fixture['orders'][1]['id']], sequence
                expect(page.locator('.owner-order-pane')).to_have_count(0)
                expect(page.get_by_role('link', name='Утверждённые работы', exact=True)).to_have_count(0)
                measurement = page.locator('.order-index-row').first.evaluate('(node) => ({height:node.getBoundingClientRect().height,width:node.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth})')
                assert measurement['height'] >= 44 and not measurement['overflow'], measurement
                layouts.append({'viewport': width, **measurement})
                page.screenshot(path=str(args.output / f'compact-orders-{width}.png'), full_page=True)
                capture(page,width,'closed')
                intake_row = page.locator(f'[data-intake-id="{INTAKE}"]')
                intake_row.focus()
                page.keyboard.press('Enter')
                expect(page).to_have_url(base + '/index.html#orders/' + INTAKE)
                expect(page.locator('.owner-order-pane')).to_be_visible()
                capture(page,width,'expanded')
                page.locator('.owner-order-pane').get_by_role('button',name='Изменить заказ',exact=True).click()
                page.evaluate('window.scrollTo(0,0)')
                capture(page,width,'editor')
                page.get_by_role('button',name='Закрыть форму',exact=True).click()
                page.get_by_role('button',name='К списку заказов',exact=True).click()
                page.get_by_role('combobox', name='Статус заказа', exact=True).select_option('review')
                expect(page.locator('.compact-order')).to_have_count(1)
                finish(context, errors, live)
            passed.append('draft and published requests share source-row order at 390,1440,1728; disclosure is keyboard accessible')

            context, page, errors, live = smoke.new_page(browser, {'managerIntakes': [intake()]})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            draft = expand(page, f'[data-intake-id="{INTAKE}"]')
            draft.get_by_role('button', name='Изменить заказ', exact=True).click()
            form = page.locator('.new-order-form')
            expect(page.get_by_label('Автомобиль', exact=True)).to_have_value('S50')
            expect(page.get_by_role('combobox', name='Группа автомобилей', exact=True)).to_have_value('VG02')
            expect(page.get_by_label('Указания (необязательно)', exact=True)).to_have_value('')
            form.get_by_text('Исходная заявка менеджера · только владельцу', exact=True).click()
            expect(form.get_by_text('Free-written custom request', exact=True)).to_be_visible()
            expect(form.get_by_text('Private synthetic reference BYN 900', exact=True)).to_be_visible()
            for code in ['W01', 'W09', 'W19']:
                page.locator(f'#new-work-{code}').check()
            page.get_by_role('combobox', name='Светопропускание', exact=True).select_option('15')
            expect(form.get_by_text('360,00 BYN', exact=True)).to_be_visible()
            page.get_by_label('Указания (необязательно)', exact=True).fill('Only approved operational instructions')
            page.get_by_role('button', name='Опубликовать заказ', exact=True).click()
            expect(page.locator('[data-intake-id]')).to_have_count(0)
            expect(page.locator('[data-order-id]')).to_have_count(1)
            sent = calls(page, 'garage_save_team_order')
            assert len(sent) == 1 and sent[0]['args']['p_expected_version'] == 1
            assert [item['work_code'] for item in sent[0]['args']['p_tasks']] == ['W01', 'W09', 'W19']
            assert sent[0]['args']['p_order']['instructions'] == 'Only approved operational instructions'
            assert 'BYN' not in json.dumps(sent[0]['args'])
            assert all(not item['assigned_to'] for item in sent[0]['args']['p_tasks'])
            passed.append('free-written Manager request is interpreted through the same multi-work form, with private server quote and explicit publication')
            finish(context, errors, live)

            protected = task('W19', 'in_progress', 7)
            # Active Manager work has a worker and no mandatory assignee.
            existing = order(172, 7, [protected, task(number=8)])
            linked = intake(172)
            linked.update({'order_id': existing['id'], 'status': 'owner_managed', 'owner_managed': True, 'source_changed': True})
            context, page, errors, live = smoke.new_page(browser, {'orders': [existing], 'managerIntakes': [linked],
                'rpcDelays': {'garage_save_team_order': 150}})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            card = expand(page, '[data-order-id]')
            expect(card.get_by_text('Текст таблицы изменился после проверки владельцем. Выбранные работы сохранены.', exact=True)).to_be_visible()
            card.get_by_role('button', name='Изменить заказ', exact=True).click()
            expect(page.get_by_role('combobox', name='Группа автомобилей', exact=True)).to_be_disabled()
            expect(page.locator('#new-work-W19')).to_be_checked()
            expect(page.locator('#new-work-W19')).to_be_disabled()
            expect(page.get_by_role('combobox', name='Светопропускание', exact=True)).to_have_value('15')
            expect(page.get_by_role('combobox', name='Светопропускание', exact=True)).to_be_disabled()
            page.locator('#new-work-W09').check()
            page.get_by_label('Цвет (необязательно)', exact=True).fill('Blue')
            page.get_by_role('button', name='Сохранить изменения', exact=True).click()
            expect(page.get_by_text('Заказ обновлён. Выбранные работы сохранятся при последующих изменениях таблицы.', exact=True)).to_be_visible()
            expect(page.locator('.new-order-form')).to_have_count(0)
            sent = calls(page, 'garage_save_team_order')[0]['args']
            kept = next(item for item in sent['p_tasks'] if item['work_code'] == 'W19')
            assert kept['id'] == protected['id'] and kept['options'] == {'tint_percent': 15}
            assert kept['instructions'] == protected['instructions']
            assert kept['assigned_to'] is None and kept['mechanic_ids'] == []
            assert any(item['work_code'] == 'W09' and 'id' not in item for item in sent['p_tasks'])
            assert calls(page, 'garage_quote_order')[-1]['args']['p_order_id'] == existing['id']
            assert page.evaluate('__garageOrderState.orders[0].colour') == 'Blue'
            passed.append('existing Owner edit preserves active task IDs/options/instructions and quotes against recorded order snapshots')
            finish(context, errors, live)

            context, page, errors, live = smoke.new_page(browser, {'orders': [order(180)]})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            expand(page, '[data-order-id]').get_by_role('button', name='Изменить заказ', exact=True).click()
            page.get_by_label('Автомобиль', exact=True).fill('Keep my draft edits')
            page.evaluate('__garageOrderState.orders[0].version++; __garageOrderState.orders[0].colour = "External correction"')
            page.get_by_role('button', name='Сохранить изменения', exact=True).click()
            expect(page.get_by_role('button', name='Применить к актуальной версии', exact=True)).to_be_visible()
            expect(page.get_by_label('Автомобиль', exact=True)).to_have_value('Keep my draft edits')
            page.get_by_role('button', name='Применить к актуальной версии', exact=True).click()
            page.get_by_role('button', name='Сохранить изменения', exact=True).click()
            expect(page.locator('.new-order-form')).to_have_count(0)
            saved = page.evaluate('__garageOrderState.orders[0]')
            assert saved['vehicle'] == 'Keep my draft edits' and saved['colour'] == 'External correction'
            passed.append('stale Owner edit preserves draft and merges independent field edits against current version')
            finish(context, errors, live)

            context, page, errors, live = smoke.new_page(browser, {'rpcDelays': {'garage_quote_order': 500}})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            page.get_by_role('button', name='Новый заказ', exact=True).click()
            page.get_by_role('combobox', name='Группа автомобилей', exact=True).select_option('VG02')
            page.locator('#new-work-W01').check()
            page.locator('#new-work-W09').check()
            expect(page.locator('.order-price-preview').get_by_text('240,00 BYN', exact=True)).to_be_visible()
            page.locator('#new-work-W02').check()
            page.get_by_role('link', name='Подключения таблиц', exact=True).click()
            page.wait_for_timeout(650)
            expect(page.get_by_role('heading', name='Подключения таблиц', exact=True)).to_be_visible()
            expect(page.locator('.order-price-preview')).to_have_count(0)
            assert 'BYN' not in page.locator('body').inner_text()
            passed.append('quote updates keep the latest selection and cannot restore private amounts after navigation')
            finish(context, errors, live)

            context, page, errors, live = smoke.new_page(browser, {'rpcErrors': {'garage_quote_order': {'times':1,'message':'Temporary calculation failure'}}})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            page.get_by_role('button', name='Новый заказ', exact=True).click()
            page.get_by_label('Автомобиль', exact=True).fill('Keep choices after quote failure')
            page.get_by_role('combobox', name='Группа автомобилей', exact=True).select_option('VG02')
            page.locator('#new-work-W01').check()
            page.get_by_role('button', name='Повторить расчёт', exact=True).click()
            expect(page.locator('.order-price-preview').get_by_text('120,00 BYN', exact=True)).to_be_visible()
            expect(page.locator('#new-work-W01')).to_be_checked()
            expect(page.get_by_label('Автомобиль', exact=True)).to_have_value('Keep choices after quote failure')
            passed.append('failed server quote can retry without losing work choices or entered fields')
            finish(context, errors, live)

            duplicated = intake()
            duplicated['row_numbers'] = [169,170]
            duplicated['source_changed'] = True
            duplicated['original_observations'] = [{'row_number':169,'raw':{**duplicated['original'],'notes':'Original first occurrence'}},
                                                   {'row_number':170,'raw':{**duplicated['original'],'notes':'Original second occurrence'}}]
            duplicated['observations'] = [{'row_number':169,'raw':{**duplicated['original'],'notes':'Latest first occurrence'}},
                                         {'row_number':170,'raw':{**duplicated['original'],'notes':'Latest second occurrence'}}]
            context, page, errors, live = smoke.new_page(browser, {'managerIntakes':[duplicated]})
            page.goto(base + '/index.html#orders')
            smoke.ready(page, 'Test Owner')
            card = expand(page, f'[data-intake-id="{INTAKE}"]')
            card.get_by_text('Исходная заявка менеджера · только владельцу',exact=True).click()
            for text in ['Original first occurrence','Original second occurrence','Latest first occurrence','Latest second occurrence']:
                expect(card.get_by_text(text,exact=True)).to_be_visible()
            expect(card.get_by_text('Не отмечено как выполненное (нет)',exact=True)).to_have_count(4)
            passed.append('all duplicate source observations remain visible in the Owner-only original and latest reference')
            finish(context, errors, live)

            context, page, errors, live = smoke.new_page(browser, {'profile': {'name': 'Test Mechanic', 'role': 'mechanic'}, 'managerIntakes': [intake()], 'orders': [order(168)]}, {'width':390,'height':844})
            page.goto(base + '/index.html#manager-orders')
            smoke.ready(page, 'Test Mechanic')
            expect(page.locator('[data-task-id]')).to_have_count(1)
            assert not calls(page, 'garage_manager_intakes') and not calls(page, 'garage_quote_order')
            assert 'Free-written custom request' not in page.locator('body').inner_text()
            expect(page.get_by_role('button', name='Изменить заказ', exact=True)).to_have_count(0)
            passed.append('mechanics never fetch Manager intake text or Owner quote and cannot edit orders')
            finish(context, errors, live)

            # Correct an omission without reopening or replacing completed work.
            for lost_response in [False, True]:
                existing = order(168, tasks=[task(status='completed'), task('W19', status='completed', number=2)])
                existing['status'] = 'closed'
                original_tasks = json.loads(json.dumps(existing['tasks']))
                context, page, errors, live = smoke.new_page(browser, {'orders': [existing], 'loseCompletionResponseOnce': lost_response})
                page.goto(base + '/index.html#orders')
                smoke.ready(page, 'Test Owner')
                page.get_by_role('combobox', name='Статус заказа', exact=True).select_option('all')
                card = expand(page, f'[data-order-id="{existing["id"]}"]')
                card.get_by_role('button', name='Добавить пропущенную выполненную работу', exact=True).click()
                expect(page.locator('.completion-form')).to_be_visible()
                expect(page.locator('#completion-work option[value="W01"]')).to_have_js_property('disabled', True)
                expect(page.locator('#completion-work option[value="W19"]')).to_have_js_property('disabled', True)
                page.get_by_role('combobox', name='Пропущенная работа из каталога', exact=True).select_option('W10')
                page.get_by_role('combobox', name='Исполнитель', exact=True).select_option(ME)
                page.get_by_label('Дата и время выполнения', exact=True).fill('2026-11-12T13:45')
                page.get_by_label('Причина исправления', exact=True).fill('Owner confirmed omitted completed A-pillar work.')
                expect(page.locator('.completion-form').get_by_text('120,00 BYN', exact=True)).to_be_visible()
                if not lost_response:
                    page.screenshot(path=str(args.output / 'owner-omitted-completion-desktop.png'), full_page=True)
                    page.set_viewport_size({'width': 390, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                    page.screenshot(path=str(args.output / 'owner-omitted-completion-mobile.png'), full_page=True)
                save = page.get_by_role('button', name='Записать выполненную работу', exact=True)
                save.click()
                if lost_response:
                    expect(page.locator('.completion-form').get_by_role('alert')).to_be_visible()
                    save.click()
                expect(page.get_by_text('Пропущенная выполненная работа добавлена. История остальных работ сохранена.', exact=True)).to_be_visible()
                expect(page.locator('.completion-form')).to_have_count(0)
                submitted = calls(page, 'garage_record_team_omission')
                assert len(submitted) == (2 if lost_response else 1)
                assert submitted[0]['args']['p_work_code'] == 'W10'
                assert submitted[0]['args']['p_mechanic_ids'] == [ME]
                assert submitted[0]['args']['p_note'] == 'Owner confirmed omitted completed A-pillar work.'
                assert not any(key in submitted[0]['args'] for key in ['price', 'net_amount', 'gross_amount'])
                if lost_response:
                    assert submitted[0]['args']['p_request_id'] == submitted[1]['args']['p_request_id']
                saved = page.evaluate('__garageOrderState.orders[0]')
                assert saved['status'] == 'closed' and len(saved['tasks']) == 3
                assert saved['tasks'][:2] == original_tasks
                assert saved['tasks'][2]['status'] == 'completed'
                passed.append('omitted completion preserves closed order/history' + (' after an idempotent lost-response retry' if lost_response else ' with explicit mechanic, time and reason'))
                finish(context, errors, live)

            # Manager comments refresh separately from the Owner's instructions.
            for role in ['admin', 'mechanic']:
                current = order(168)
                current['manager_comment'] = 'Call the Manager before starting. <b>Plain text</b>'
                current['manager_comment_updated_at'] = '2026-11-15T12:00:00Z'
                context, page, errors, live = smoke.new_page(browser, {'orders': [current],
                    'profile': {'name': 'Test Owner' if role == 'admin' else 'Test Mechanic', 'role': role}}, {'width': 390, 'height': 844})
                page.goto(base + ('/index.html#orders' if role == 'admin' else '/index.html#manager-orders'))
                smoke.ready(page, 'Test Owner' if role == 'admin' else 'Test Mechanic')
                card = (expand(page, f'[data-order-id="{current["id"]}"]') if role == 'admin'
                        else task_card(page, current['tasks'][0]['id']))
                expect(card.get_by_text(current['manager_comment'], exact=True)).to_be_visible()
                assert card.locator('.order-manager-comment b').count() == 0
                page.evaluate("__garageOrderState.orders[0].manager_comment = 'New Manager detail after Owner review'; __garageOrderState.orders[0].manager_comment_updated_at = '2026-11-15T12:15:00Z'")
                page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
                expect(card.get_by_text('New Manager detail after Owner review', exact=True)).to_be_visible()
                expect(card.get_by_text('Указания по работе', exact=True)).to_be_visible()
                page.screenshot(path=str(args.output / f'{role}-manager-comment-mobile.png'), full_page=True)
                if role == 'mechanic':
                    assert not calls(page, 'garage_staff') and not calls(page, 'garage_quote_order')
                    assert 'BYN' not in page.locator('body').inner_text()
                    expect(page.get_by_role('button', name='Добавить пропущенную выполненную работу', exact=True)).to_have_count(0)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                passed.append(f'{role} sees refreshed plain-text Manager comments without replacing Owner instructions or leaking amounts')
                finish(context, errors, live)

            current = order(168)
            current.update({'instructions': 'Outdated automatic Manager text', 'instructions_from_manager': True,
                            'manager_comment': 'Current Manager text', 'manager_comment_updated_at': '2026-11-15T12:00:00Z'})
            context, page, errors, live = smoke.new_page(browser, {'orders': [current], 'profile': {'name': 'Test Mechanic', 'role': 'mechanic'}})
            page.goto(base + '/index.html#manager-orders')
            smoke.ready(page, 'Test Mechanic')
            card = task_card(page, current['tasks'][0]['id'])
            expect(card.get_by_text('Current Manager text', exact=True)).to_be_visible()
            expect(card.get_by_text('Outdated automatic Manager text', exact=True)).to_have_count(0)
            page.evaluate("__garageOrderState.orders[0].manager_comment = ''; __garageOrderState.orders[0].manager_comment_updated_at = '2026-11-15T12:15:00Z'")
            page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            expect(card.get_by_label('Комментарий менеджера', exact=True)).to_have_count(0)
            expect(card.get_by_text('Outdated automatic Manager text', exact=True)).to_have_count(0)
            passed.append('replaced or deleted Manager comments do not resurrect earlier automatic instructions')
            finish(context, errors, live)
        finally:
            browser.close(); server.shutdown(); server.server_close()
    result = {'passed':passed,'count':len(passed),'layouts':layouts,'live_database_requests':0}
    (args.output / 'owner-editing-result.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,default=ROOT/'dist')
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--chromium',required=True)
    parser.add_argument('--before-directory',type=Path)
    parser.add_argument('--capture-script',type=Path)
    run(parser.parse_args())
