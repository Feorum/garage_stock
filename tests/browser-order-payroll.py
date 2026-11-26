"""Exercise the Owner's order payroll and dated rate controls using local test data."""
import argparse
from copy import deepcopy
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import re

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location('garage_smoke', ROOT / 'tests/browser-smoke.py')
smoke = module_from_spec(spec)
spec.loader.exec_module(smoke)


class Fixture:
    def __init__(self):
        self.staff = [{'id': 'a', 'name': 'Андрей'}, {'id': 'm', 'name': 'Миша'}]
        self.order = {'id': 'visit', 'vehicle': 'BELGEE X50', 'vehicle_group_code': 'VG02', 'order_number': 'G-123',
                      'status': 'published', 'source': 'owner', 'priority': 'normal', 'version': 1,
                      'tasks': [{'id': 'task', 'work_code': 'W01', 'work_name': 'Оклейка капота', 'version': 1,
                                 'status': 'completed', 'options': {}, 'participants': []}]}
        self.rates = [{'mechanic_id': 'm', 'name': 'Миша', 'effective_date': '2026-11-01', 'rate_bp': 1500}]
        self.pay = {'applicable': True, 'version': 0, 'token': '0', 'closed': True, 'history': [],
                    'missing_prices': [], 'missing_rates': [], 'prep_ids': [], 'heat_ids': [],
                    'basis_kopeks': 90000, 'cap_kopeks': 22500, 'total_kopeks': 20100, 'excess_kopeks': 0,
                    'automatic_reserve_kopeks': 4500, 'reserve_kopeks': 4500, 'override_reserve_kopeks': None,
                    'automatic_additional_kopeks': 2400, 'additional_kopeks': 2400, 'override_additional_kopeks': None,
                    'people': [{'mechanic_id': 'a', 'name': 'Андрей', 'automatic_kopeks': 20100,
                                'kopeks': 20100, 'override_kopeks': None}],
                    'lines': [{'task_id': 'task', 'work_date': '2026-11-30', 'basis_kopeks': 90000,
                               'people': [{'mechanic_id': 'a', 'name': 'Андрей', 'rate_bp': 2500}]}]}
        self.saves = []
        self.rate_saves = []

    def rpc(self, method, params):
        replies = {'garage_list_orders': [self.order], 'garage_manager_intakes': [], 'garage_custom_orders': [], 'garage_staff': self.staff,
                   'garage_owner_gift_offer': None, 'garage_mechanic_rates': self.rates, 'garage_order_payroll': self.pay,
                   'garage_order_financials': {'status': 'priced', 'effective_total_kopeks': 112500, 'tasks': []}}
        if method == 'garage_save_order_payroll':
            assert params['p_expected_token'] == self.pay['token'] and params['p_request_id']
            self.saves.append(deepcopy(params))
            person = self.pay['people'][0]
            person['override_kopeks'] = next((p['kopeks'] for p in params['p_amounts'] if p['mechanic_id'] == 'a'), None)
            person['kopeks'] = person['automatic_kopeks'] if person['override_kopeks'] is None else person['override_kopeks']
            self.pay.update(prep_ids=params['p_prep_ids'], heat_ids=params['p_heat_ids'], total_kopeks=person['kopeks'],
                            excess_kopeks=max(0, person['kopeks'] - 22500))
            for field, default in [('reserve', 4500), ('additional', max(0, 22500 - person['kopeks']))]:
                override = params['p_' + field + '_kopeks']
                self.pay.update({field + '_kopeks': default if override is None else override,
                                 'override_' + field + '_kopeks': override, 'automatic_' + field + '_kopeks': default})
            self.pay['version'] += 1
            self.pay['token'] = str(self.pay['version'])
            return {'data': self.pay, 'error': None}
        if method == 'garage_save_mechanic_rate':
            self.rate_saves.append(deepcopy(params))
            self.rates.append({'mechanic_id': 'm', 'name': 'Миша', 'effective_date': params['p_effective_date'],
                               'rate_bp': params['p_rate_bp']})
            return {'data': params['p_rate_bp'], 'error': None}
        return {'data': replies.get(method), 'error': None}


def check_wrapping_steps(browser, base):
    for mixed in (False, True):
        fixture = Fixture()
        wrapping = fixture.order['tasks'][0]
        tint = {**wrapping, 'id': 'tint', 'work_code': 'W19', 'work_name': 'Тонировка задней полусферы'}
        fixture.order['tasks'] = [tint, wrapping] if mixed else [tint]
        fixture.pay['lines'] = [{**fixture.pay['lines'][0], 'task_id': task['id']} for task in fixture.order['tasks']]
        # The tint-only case also exercises an earlier RPC response without wrapping_steps.
        if mixed:
            fixture.pay['wrapping_steps'] = True
        context, page, errors, live = smoke.new_page(browser, {})
        try:
            page.expose_function('__garageRpcFixture', fixture.rpc)
            page.goto(base + '/index.html#orders/visit')
            detail = page.get_by_role('dialog', name='Карточка заказа')
            labels = ('Подготовка', 'Загрев')
            for tab in ('Обзор', 'Цены'):
                detail.get_by_role('button', name=tab, exact=True).click()
                for text in labels:
                    expect(detail.get_by_text(text, exact=True)).to_have_count(0)
            detail.get_by_role('button', name='Оплата механиков', exact=True).click()
            section = detail.locator('.order-payroll')
            expect(section.get_by_text('Всего исполнителям', exact=True)).to_be_visible()
            edit_steps = section.get_by_role('button', name='Выбрать исполнителей подготовки и загрева')
            if mixed:
                edit_steps.click()
                for text in labels:
                    group = section.get_by_role('group', name=text + ' · 3%')
                    expect(group.get_by_role('checkbox', name='Миша')).to_be_visible()
            else:
                expect(edit_steps).to_have_count(0)
                for text in labels:
                    expect(section.get_by_text(text, exact=True)).to_have_count(0)
            assert not errors and not live, (errors, live)
        finally:
            context.close()


def run(browser, base):
    fixture = Fixture()
    context, page, errors, live = smoke.new_page(browser, {'profile': {'role': 'admin', 'name': 'Виталий'}},
                                                 viewport={'width': 390, 'height': 844})
    try:
        page.expose_function('__garageRpcFixture', fixture.rpc)
        page.goto(base + '/index.html#orders/visit')
        section = page.locator('.order-payroll')
        page.get_by_role('button', name='Оплата механиков', exact=True).click()
        expect(section.get_by_text('Всего в премиальный фонд').locator('..')).to_contain_text(re.compile(r'69,00\sBYN'))
        section.get_by_role('button', name='Изменить сумму · Андрей').click()
        section.get_by_label('Андрей, BYN').fill('235,00')
        expect(section.get_by_text(re.compile(r'После сохранения выплаты превысят потолок на 10,00'))).to_be_visible()
        section.get_by_role('button', name='Сохранить расчёт').click()
        expect(section.get_by_text(re.compile(r'Выплаты выше потолка на 10,00'))).to_be_visible()
        assert fixture.saves[-1]['p_amounts'] == [{'mechanic_id': 'a', 'kopeks': 23500}]
        section.get_by_role('button', name='Изменить сумму · Андрей').click()
        section.get_by_role('button', name='По расчёту').click()
        expect(section.get_by_role('button', name='Изменить сумму · Андрей')).to_contain_text('201,00')
        section.get_by_role('button', name='Изменить сумму · доп прем').click()
        section.get_by_label('доп прем, BYN').fill('19,31')
        section.get_by_role('button', name='Сохранить расчёт').click()
        expect(section.get_by_role('button', name='Изменить сумму · доп прем')).to_contain_text('19,31')
        section.get_by_role('button', name='Выбрать исполнителей подготовки и загрева').click()
        section.get_by_role('group', name='Подготовка · 3%').get_by_label('Миша').check()
        section.get_by_role('button', name='Сохранить расчёт').click()
        expect(section.locator('.payroll-roles')).to_contain_text('Миша')
        assert fixture.saves[-1]['p_prep_ids'] == ['m'] and fixture.saves[-1]['p_heat_ids'] == []
        assert fixture.saves[-1]['p_additional_kopeks'] == 1931
        section.get_by_text('Ставки механиков', exact=True).click()
        expect(section.locator('.payroll-rates')).to_be_visible()
        section.get_by_role('combobox').select_option('m')
        section.get_by_label('Действует с').fill('2026-12-01')
        expect(section.get_by_label('Ставка, %')).to_have_value('15,00')
        section.get_by_label('Ставка, %').fill('20')
        section.get_by_role('button', name='Сохранить ставку').click()
        expect(section.get_by_text('С 01.12.2026 · 20%')).to_be_visible()
        assert fixture.rate_saves[-1]['p_rate_bp'] == 2000 and fixture.rate_saves[-1]['p_expected_rate_bp'] is None
        section.get_by_role('button', name='Изменить сумму · Андрей').click()
        section.get_by_label('Андрей, BYN').fill('123')
        fixture.pay['token'] = 'updated-elsewhere'
        page.evaluate("window.dispatchEvent(new CustomEvent('garage-order-finance-updated', {detail:'visit'}))")
        expect(section.get_by_text(re.compile('Расчёт изменился'))).to_be_visible()
        expect(section.get_by_label('Андрей, BYN')).to_have_value('123')
        expect(section.get_by_role('button', name='Сохранить расчёт')).to_be_disabled()
        section.get_by_role('button', name='Отмена', exact=True).click()
        fixture.pay = {'applicable': False, 'historical': True}
        page.reload()
        page.get_by_role('button', name='Оплата механиков', exact=True).click()
        expect(section.get_by_role('link', name='Распределение по работам')).to_be_visible()
        expect(section.get_by_role('button', name='Сохранить расчёт')).to_have_count(0)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors and not live, (errors, live)
    finally:
        context.close()


if __name__ == '__main__':
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--directory', type=Path, default=ROOT / 'dist')
    args.add_argument('--chromium', default=None)
    options = args.parse_args()
    server, base = smoke.serve(options.directory.resolve())
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=options.chromium, args=['--no-sandbox'])
            try:
                run(browser, base)
                check_wrapping_steps(browser, base)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Passed Owner order payroll, dated rates, manual overrides, mobile layout and conflict checks.')
