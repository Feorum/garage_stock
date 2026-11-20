"""Verify Owner price editing and Mechanic isolation against the disposable PostgreSQL database."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


def exercise_gift_offer(page, db, base, owner, mechanic):
    panel = page.get_by_role('region', name='Подробности заказа', exact=True)
    dialog = page.get_by_role('dialog', name='Предложить работу в подарок', exact=True)
    vehicle = 'Автомобиль для проверки подарка'
    def show_new_offer(name):
        page.goto(f'{base}/index.html#orders')
        page.get_by_role('link', name='Управление заказами', exact=True).click()
        page.get_by_role('button', name='Новый заказ', exact=True).click()
        page.get_by_label('Автомобиль', exact=True).fill(name)
        page.get_by_role('combobox', name='Группа автомобилей', exact=True).select_option('VG02')
        page.get_by_role('combobox', name='Назначить механика', exact=True).select_option(mechanic)
        page.locator('#new-work-W01').check()
        expect(dialog).to_have_count(0)
        page.locator('#new-work-W08').check()
        expect(dialog).to_be_visible()

    def lookup(name):
        return next(o for o in db.rpc(owner, 'garage_list_orders') if o['vehicle'] == name)

    def accept():
        dialog.get_by_role('button', name='Добавить подарок', exact=True).click()
        expect(dialog).to_have_count(0)
        expect(page.locator('#new-work-W09')).to_be_checked()
        gift = page.locator('.quote-items li').filter(has_text='Зона над лобовым')
        expect(gift.locator('span')).to_have_text(re.compile(r'^0,00\s*BYN$'))
        expect(page.locator('.financial-summary')).not_to_contain_text(re.compile(r'НДС|\bVAT\b', re.I))
        expect(page.locator('[data-price-kind="effective"]')).to_contain_text('31,12')
        page.locator('#team-W09').get_by_role('checkbox', name='Андрей', exact=True).check()

    show_new_offer(vehicle)
    dialog.get_by_role('button', name='Без подарка', exact=True).click()
    expect(page.locator('#new-work-W09')).not_to_be_checked()
    page.get_by_role('button', name='Отправить заказ', exact=True).click()
    expect(panel.get_by_role('heading', name=vehicle, exact=True)).to_be_visible()
    assert {t['work_code'] for t in lookup(vehicle)['tasks']} == {'W01', 'W08'}
    panel.get_by_role('button', name='Выбрать подарок для клиента', exact=True).click()
    accept()
    page.get_by_role('button', name='Сохранить изменения', exact=True).click()
    expect(panel.get_by_role('heading', name=vehicle, exact=True)).to_be_visible()
    order = lookup(vehicle)
    assert len(order['tasks']) == 3
    gift = next(t for t in order['tasks'] if t['work_code'] == 'W09')
    assert [m['mechanic_id'] for m in gift['participants']] == [mechanic]
    def gift_price():
        details = db.rpc(owner, 'garage_order_financials', p_order_id=order['id'])
        assert details['effective_total_kopeks'] == 3112 and details['net_amount'] == 38.89, details
        return next(t for t in details['tasks'] if t['task_id'] == gift['id'])
    price = gift_price()
    assert price['catalogue_kopeks'] == 777 and price['override_kopeks'] == price['effective_gross_kopeks'] == 0
    db.rpc(mechanic, 'garage_check_work', p_task_id=gift['id'], p_request_id=str(uuid4()))
    price = gift_price()
    assert price['effective_kopeks'] == 0 and price['payout']['pool_kopeks'] is None
    assert price['payout']['suggested_pool_kopeks'] == 777
    assert [(s['mechanic_id'], s['kopeks']) for s in price['payout']['suggested_shares']] == [(mechanic, 777)]

    # New orders take the same atomic gift path without an existing order ID.
    next_vehicle = 'Новый заказ с подарком'
    show_new_offer(next_vehicle)
    accept()
    page.get_by_role('button', name='Отправить заказ', exact=True).click()
    expect(panel.get_by_role('heading', name=next_vehicle, exact=True)).to_be_visible()
    created = lookup(next_vehicle)
    assert len(created['tasks']) == 3
    amounts = db.rpc(owner, 'garage_order_financials', p_order_id=created['id'])
    gifted = next(t for t in amounts['tasks'] if t['work_code'] == 'W09')
    assert gifted['effective_kopeks'] == 0 and gifted['catalogue_kopeks'] == 777


def exercise_owner_pricing(db, directory, chromium, owner, first, second):
    spec = spec_from_file_location('price_smoke', Path(__file__).with_name('browser-smoke.py'))
    smoke = module_from_spec(spec)
    spec.loader.exec_module(smoke)
    visit = db.rpc(owner, 'garage_create_order', p_vehicle='Тестовый автомобиль для расчёта',
                   p_vehicle_group_code='VG02', p_source='manager',
                   p_tasks=[{'work_code': 'W01'}], p_request_id=str(uuid4()))
    order_id = visit['order_id']
    record = next(row for row in db.rpc(owner, 'garage_list_orders') if row['id'] == order_id)
    task_id = record['tasks'][0]['id']
    note = 'Проверить согласованную скидку перед выдачей'
    server, base = smoke.serve(directory.resolve())

    def new_page(browser, actor, role):
        context, page, errors, requests = smoke.new_page(browser, {
            'userId': actor, 'profile': {'id': actor, 'name': 'Тест', 'role': role, 'active': True}
        }, {'width': 390, 'height': 844})
        page.expose_function('__garageRpcFixture', lambda method, params: db.transport(actor, method, params))
        return context, page, errors, requests

    try:
        with sync_playwright() as pw:
            with pw.chromium.launch(executable_path=chromium, args=['--no-sandbox']) as browser:
                context, page, errors, requests = new_page(browser, owner, 'admin')
                page.goto(f'{base}/index.html#orders/{order_id}')
                row = page.locator(f'tbody[data-task-id="{task_id}"]')
                expect(row).to_contain_text(re.compile(r'20[,.]01'))
                expect(row.locator('td[data-column="customer"] .job-amount')).to_have_text(re.compile(r'20,01\s*BYN'))
                expect(page.locator('.financial-summary dd')).to_have_text(re.compile(r'20,01\s*BYN'))
                expect(page.locator('main')).not_to_contain_text(re.compile(r'НДС|\bVAT\b', re.I))
                edit = row.get_by_role('button', name='Изменить стоимость', exact=True)
                edit.click()
                amount = row.get_by_label('Стоимость работы, BYN', exact=True)
                memo = row.get_by_label('Личный комментарий владельца', exact=True)
                save = row.get_by_role('button', name='Сохранить стоимость', exact=True)
                amount.fill('0')
                memo.fill(note)
                save.click()
                expect(edit).to_have_attribute('aria-expanded', 'false')
                expect(row.locator('td[data-column="customer"] .job-amount')).to_have_text(re.compile(r'^0,00\s*BYN$'))
                expect(page.locator('.financial-summary dd')).to_have_text(re.compile(r'^0,00\s*BYN$'))
                saved = db.rpc(owner, 'garage_order_financials', p_order_id=order_id)
                assert saved['effective_total_kopeks'] == saved['effective_tax_kopeks'] == saved['effective_gross_kopeks'] == 0, saved
                assert saved['net_amount'] == 20.01 and saved['gross_amount'] == 24.01, saved
                page.reload()
                edit.click()
                expect(memo).to_have_value(note)
                amount.fill('')
                save.click()
                expect(edit).to_have_attribute('aria-expanded', 'false')
                restored = db.rpc(owner, 'garage_order_financials', p_order_id=order_id)
                assert restored['effective_total_kopeks'] == 2001 and restored['effective_gross_kopeks'] == 2401, restored
                expect(row.locator('td[data-column="customer"] .job-amount')).to_have_text(re.compile(r'20,01\s*BYN'))
                exercise_gift_offer(page, db, base, owner, first)
                assert not errors and not requests, (errors, requests)
                context.close()

                for person in (first, second):
                    context, page, errors, requests = new_page(browser, person, 'mechanic')
                    for fragment in (f'shift/{order_id}', f'orders/{order_id}', f'pay/{task_id}'):
                        page.goto(f'{base}/index.html#{fragment}')
                        expect(page.get_by_role('navigation', name='Кабинет механика')).to_be_visible()
                        expect(page.get_by_text(note, exact=True)).to_have_count(0)
                        expect(page.get_by_role('button', name='Изменить стоимость')).to_have_count(0)
                        expect(page.locator('body')).not_to_contain_text(re.compile(r'\bBYN\b|20[,.]01|24[,.]01'))
                    names = page.evaluate('(__garageCalls || []).map(call => call.name).filter(Boolean)')
                    assert not any(name.startswith(('garage_pay_', 'garage_quote_', 'garage_save_task_pricing'))
                                   or name in ('garage_order_financials','garage_owner_review_prices') for name in names), names
                    assert not errors and not requests, (errors, requests)
                    context.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Passed automatic Owner pricing, a deliberate zero, private memo persistence, '
          'catalogue restoration, optional gift acceptance and decline, payout independence and role-guarded financial routes.')
