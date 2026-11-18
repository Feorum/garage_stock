#!/usr/bin/env python3
"""Exercise the Owner-only payout screen with synthetic local RPC replies."""
import argparse
from copy import deepcopy
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import re

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location('pay_smoke', ROOT / 'tests/browser-smoke.py')
smoke = module_from_spec(spec)
spec.loader.exec_module(smoke)

CANDIDATES = [
    {'mechanic_id': 'a', 'name': 'Артём Савин', 'former': False},
    {'mechanic_id': 'b', 'name': 'Виктор Левин', 'former': False},
    {'mechanic_id': 'c', 'name': 'Олег Власов', 'former': True},
]


class PayFixture:
    def __init__(self):
        self.item = {'task_id': 'team', 'version': 0, 'order_number': 'G-00072', 'vehicle': 'Škoda Kodiaq',
                     'work_name': 'Оклейка капота', 'options': {}, 'completed_at': '2026-11-17T22:20:00Z',
                     'pool_kopeks': None, 'shares': [], 'candidates': deepcopy(CANDIDATES)}
        self.solo = {**self.item, 'task_id': 'solo', 'order_number': 'G-00073', 'vehicle': 'Volkswagen Passat',
                     'work_name': 'Тонировка', 'options': {'tint_percent': 15}, 'candidates': deepcopy(CANDIDATES[:1])}
        self.revisions = []
        self.saves = []
        self.fail_once = False
        self.conflict_once = False

    def save(self, item, pool, shares, reason):
        item['version'] += 1
        item['pool_kopeks'] = pool
        item['shares'] = [{**next(person for person in item['candidates'] if person['mechanic_id'] == share['mechanic_id']),
                           **share, 'kopeks': pool * share['basis_points'] // 10000} for share in shares]
        self.revisions.insert(0, {'version': item['version'], 'pool_kopeks': pool, 'shares': deepcopy(item['shares']),
                                  'actor_name': 'Владелец', 'saved_at': '2026-11-18T08:00:00Z', 'reason': reason})

    def rpc(self, name, args):
        if name == 'garage_pay_worklist':
            return {'data': [self.item, self.solo], 'error': None}
        if name == 'garage_pay_history':
            return {'data': self.revisions, 'error': None}
        if name == 'garage_pay_save':
            self.saves.append(deepcopy(args))
            item = self.item if args['p_task_id'] == 'team' else self.solo
            if self.fail_once:
                self.fail_once = False
                return {'data': None, 'error': {'message': 'Synthetic network failure'}}
            if self.conflict_once:
                self.conflict_once = False
                self.save(item, 8000, args['p_shares'], 'Параллельное изменение')
                return {'data': None, 'error': {'code': '40001', 'message': 'Synthetic conflict'}}
            assert item['version'] == args['p_expected_version']
            self.save(item, args['p_pool_kopeks'], args['p_shares'], args['p_reason'])
            return {'data': item['version'], 'error': None}
        return {'data': [], 'error': None}


def run(directory, output, chromium):
    output.mkdir(parents=True, exist_ok=True)
    server, base = smoke.serve(directory.resolve())
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chromium, args=['--no-sandbox'])
            try:
                fixture = PayFixture()
                context, page, errors, live = smoke.new_page(browser, {'profile': {'name': 'Владелец', 'role': 'admin'}})
                page.expose_function('__garageRpcFixture', fixture.rpc)
                page.goto(base + '/index.html#pay')
                card = page.locator('.pay-card[data-task-id="team"]')
                begin = card.get_by_role('button', name='Распределить', exact=True)
                expect(begin).to_be_visible()
                expect(card).to_contain_text('18.11.2026')
                begin.click()
                pool = card.get_by_label('Сумма для распределения, BYN')
                expect(pool).to_be_focused()
                pool.fill('250,00')
                card.get_by_label('Доля · Артём Савин, %').fill('60')
                card.get_by_label('Доля · Виктор Левин, %').fill('35')
                save = card.get_by_role('button', name='Сохранить распределение')
                save.click()
                expect(card.get_by_role('status')).to_contain_text('100%')
                assert not fixture.saves
                card.get_by_label('Включить прежнего участника').check()
                card.get_by_label('Доля · Олег Власов, %').fill('5')
                reason = card.get_by_label('Причина распределения')
                expect(reason).to_have_attribute('required', '')
                reason.fill('Участие в подготовке до передачи работы')
                page.screenshot(path=str(output / 'pay-desktop.png'), full_page=True)
                fixture.fail_once = True
                save.click()
                expect(card.get_by_role('status')).to_contain_text('не подтверждено')
                expect(pool).to_have_value('250,00')
                save.click()
                expect(page.get_by_text('Распределение сохранено.', exact=True)).to_be_visible()
                assert len(fixture.saves) == 2 and fixture.saves[0] == fixture.saves[1]
                assert fixture.saves[-1]['p_pool_kopeks'] == 25000
                assert [s['basis_points'] for s in fixture.saves[-1]['p_shares']] == [6000, 3500, 500]
                view = page.get_by_role('combobox', name='Показать', exact=True)
                expect(view).to_be_focused()
                view.select_option('allocated')
                card.get_by_role('button', name='История изменений').click()
                expect(card.locator('.pay-revisions')).to_contain_text('Участие в подготовке')
                card.get_by_role('button', name='Изменить распределение').click()
                pool.fill('0')
                card.get_by_label('Подтверждаю сумму').check()
                card.get_by_label('Причина распределения').fill('Без оплаты по решению владельца')
                fixture.conflict_once = True
                save.click()
                expect(card.locator('.pay-conflict')).to_contain_text('Сохранённая версия 2')
                expect(pool).to_have_value('0')
                card.get_by_role('button', name='Продолжить с моими значениями').click()
                save.click()
                expect(card.get_by_role('button', name='Изменить распределение')).to_be_visible()
                assert fixture.saves[-1]['p_zero_confirmed'] is True and fixture.item['pool_kopeks'] == 0
                assert fixture.saves[-1]['p_expected_version'] == 2
                assert fixture.saves[-1]['p_request_id'] != fixture.saves[-2]['p_request_id']
                view.select_option('pending')
                page.set_viewport_size({'width': 390, 'height': 844})
                solo = page.locator('.pay-card[data-task-id="solo"]')
                solo.get_by_role('button', name='Распределить').click()
                expect(solo.get_by_label('Доля · Артём Савин, %')).to_have_value('100')
                expect(solo.get_by_label('Сумма для распределения, BYN')).to_be_focused()
                page.screenshot(path=str(output / 'pay-phone.png'), full_page=True)
                for width in (320, 390, 768):
                    page.set_viewport_size({'width': width, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
                solo.get_by_role('button', name='Закрыть', exact=True).click()
                expect(solo.get_by_role('button', name='Распределить')).to_be_focused()
                smoke.sign_out(page)
                expect(page.locator('.pay-workspace')).to_have_count(0)
                assert not errors and not live, (errors, live)
                context.close()

                context, page, errors, live = smoke.new_page(browser, {'profile': {'name': 'Механик', 'role': 'mechanic'}})
                page.goto(base + '/index.html#pay')
                expect(page.get_by_role('navigation', name='Кабинет механика')).to_be_visible()
                expect(page.locator('.pay-workspace')).to_have_count(0)
                assert not page.evaluate('__garageCalls.some(call => call.name?.startsWith("garage_pay_"))')
                expect(page.get_by_text(re.compile(r'BYN'))).to_have_count(0)
                assert not errors and not live, (errors, live)
                context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Passed pay editing, rosters, percentages, ambiguous retry, conflict, zero pool, audit, mobile, focus and role isolation.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--output', type=Path, default=Path('/tmp/garage-browser-pay'))
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    run(args.directory, args.output, args.chromium)
