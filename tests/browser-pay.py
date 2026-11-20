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
        self.receipts = {}
        self.fail_once = False
        self.conflict_once = False
        self.withdrawn = False

    def save(self, item, amounts, reason):
        item['version'] += 1
        pool = sum(row['kopeks'] for row in amounts)
        item['pool_kopeks'] = pool
        item['shares'] = [{**next(person for person in item['candidates'] if person['mechanic_id'] == share['mechanic_id']),
                           **share} for share in amounts]
        self.revisions.insert(0, {'task_id': item['task_id'], 'version': item['version'], 'pool_kopeks': pool, 'shares': deepcopy(item['shares']),
                                  'actor_name': 'Владелец', 'saved_at': '2026-11-18T08:00:00Z', 'reason': reason})

    def rpc(self, name, args):
        if name == 'garage_pay_worklist':
            return {'data': [self.solo] if self.withdrawn else [self.item, self.solo], 'error': None}
        if name == 'garage_pay_history':
            return {'data': [row for row in self.revisions if row['task_id'] == args['p_task_id']], 'error': None}
        if name == 'garage_pay_save_amounts':
            self.saves.append(deepcopy(args))
            item = self.item if args['p_task_id'] == 'team' else self.solo
            request = args['p_request_id']
            if request in self.receipts:
                prior, revision = self.receipts[request]
                assert prior == args
                return {'data': revision, 'error': None}
            if self.conflict_once:
                self.conflict_once = False
                self.save(item, [{'mechanic_id': p['mechanic_id'], 'kopeks': 4000}
                                 for p in item['candidates'] if not p['former']], 'Параллельное изменение')
                return {'data': None, 'error': {'code': '40001', 'message': 'Synthetic conflict'}}
            assert item['version'] == args['p_expected_version']
            self.save(item, args['p_amounts'], args['p_reason'])
            self.receipts[request] = deepcopy(args), item['version']
            if self.fail_once:
                self.fail_once = False
                return {'data': None, 'error': {'message': 'Synthetic network failure after commit'}}
            return {'data': item['version'], 'error': None}
        return {'data': [], 'error': None}


def check_equal_preview(browser, base):
    """Read stored kopeks and distribute indivisible remainders predictably."""
    fixture = PayFixture()
    people = [dict(person, former=False) for person in CANDIDATES]
    fixture.item.update({
        'candidates': people,
        'catalogue_kopeks': 1_000_001, 'effective_kopeks': 0, 'override_kopeks': 0,
        'private_version': 1, 'private_comment': 'Проверено',
        'suggested_pool_kopeks': 1_000_001,
        'suggested_shares': [dict(person, basis_points=bps, kopeks=cents) for person, bps, cents in
                             zip(people, [3334, 3333, 3333], [333334, 333334, 333333])],
    })
    context, page, errors, live = smoke.new_page(browser, {
        'profile': {'name': 'Владелец', 'role': 'admin'}, 'payWorklist': [fixture.item]})
    try:
        page.goto(base + '/index.html#pay/team')
        expect(page.locator('.pay-card')).to_have_count(1)
        editor = page.locator('.pay-editor')
        fields = [editor.get_by_label(p['name'] + ', BYN') for p in people]
        for field, amount in zip(fields, ['3333,34', '3333,34', '3333,33']):
            expect(field).to_have_value(amount)
        total = editor.get_by_label('Итого механикам')
        expect(total).to_have_text(re.compile(r'10\s000,01\sBYN'))
        for field, amount in zip(fields, ['0.01', '999.99', '0']):
            field.fill(amount)
        expect(total).to_have_text(re.compile(r'1\s?000,00\sBYN'))
        editor.get_by_role('button', name='Разделить поровну').click()
        for field, amount in zip(fields, ['333,34', '333,33', '333,33']):
            expect(field).to_have_value(amount)
        expect(total).to_have_text(re.compile(r'1\s?000,00\sBYN'))
        for field, amount in zip(fields, ['0,01', '999,99', '0']):
            field.fill(amount)
        save = editor.get_by_role('button', name='Сохранить распределение')
        save.click()
        expect(editor).to_have_count(0)
        saved = page.evaluate("__garageCalls.find(call => call.name === 'garage_pay_save_amounts').args")
        assert [row['kopeks'] for row in saved['p_amounts']] == [1, 99999, 0]
        assert 'p_pool_kopeks' not in saved
        page.get_by_role('button', name='История изменений').click()
        expect(page.locator('.pay-revisions')).to_contain_text(re.compile(r'Артём Савин · 0,01\sBYN'))
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def check_roster_refresh(browser, base):
    """Finishing work changes the active people without incrementing a payout version."""
    fixture = PayFixture()
    context, page, errors, live = smoke.new_page(browser, {'profile': {'name': 'Владелец', 'role': 'admin'}})
    try:
        page.expose_function('__garageRpcFixture', fixture.rpc)
        page.goto(base + '/index.html#pay/team')
        editor = page.locator('.pay-editor')
        first = editor.get_by_label('Артём Савин, BYN')
        first.fill('17,01')
        editor.get_by_label('Виктор Левин, BYN').fill('12,99')
        fixture.item['candidates'] = [CANDIDATES[0], {**CANDIDATES[2], 'former': False}]
        page.get_by_role('button', name='Обновить', exact=True).click()
        expect(editor.get_by_role('button', name='Сохранить распределение')).to_be_disabled()
        expect(first).to_have_value('17,01')
        expect(editor.get_by_label('Последняя сохранённая версия')).to_contain_text('Олег Власов')
        editor.get_by_role('button', name='Продолжить с моими значениями').click()
        expect(first).to_have_value('17,01')
        expect(editor.get_by_label('Виктор Левин, BYN')).to_have_count(0)
        expect(editor.get_by_label('Олег Власов, BYN')).to_have_value('')
        editor.get_by_role('button', name='Разделить поровну').click()
        expect(first).to_have_value('8,51')
        expect(editor.get_by_label('Олег Власов, BYN')).to_have_value('8,50')
        editor.get_by_role('button', name='Сохранить распределение').click()
        expect(editor).to_have_count(0)
        assert fixture.saves[-1]['p_amounts'] == [{'mechanic_id': 'a', 'kopeks': 851}, {'mechanic_id': 'c', 'kopeks': 850}]
        page.get_by_role('button', name='Изменить распределение').click()
        first.fill('19,50')
        fixture.withdrawn = True
        page.get_by_role('button', name='Обновить', exact=True).click()
        expect(editor.get_by_label('Последняя сохранённая версия')).to_contain_text('больше недоступна')
        expect(first).to_have_value('19,50')
        expect(editor.get_by_role('button', name='Сохранить распределение')).to_be_disabled()
        editor.get_by_role('button', name='Закрыть', exact=True).click()
        expect(page.locator('.pay-card')).to_have_count(0)
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def run(directory, output, chromium):
    output.mkdir(parents=True, exist_ok=True)
    server, base = smoke.serve(directory.resolve())
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chromium, args=['--no-sandbox'])
            try:
                check_equal_preview(browser, base)
                check_roster_refresh(browser, base)
                fixture = PayFixture()
                context, page, errors, live = smoke.new_page(browser, {'profile': {'name': 'Владелец', 'role': 'admin'}})
                page.expose_function('__garageRpcFixture', fixture.rpc)
                page.goto(base + '/index.html#pay')
                card = page.locator('.pay-card[data-task-id="team"]')
                begin = card.get_by_role('button', name='Распределить', exact=True)
                expect(begin).to_be_visible()
                expect(card).to_contain_text('18.11.2026')
                begin.click()
                fields = [card.get_by_label(p['name'] + ', BYN', exact=True) for p in CANDIDATES]
                expect(fields[0]).to_be_focused()
                expect(fields[1]).to_have_value('')
                fields[0].fill('150,00')
                save = card.get_by_role('button', name='Сохранить распределение')
                save.click()
                expect(fields[1]).to_be_focused()
                assert not fixture.saves
                fields[1].fill('87,50')
                card.get_by_label('Включить прежнего участника').check()
                fields[2].fill('12,50')
                expect(card.get_by_label('Итого механикам')).to_have_text(re.compile(r'250,00\sBYN'))
                reason = card.get_by_label('Причина распределения')
                expect(reason).to_have_attribute('required', '')
                reason.fill('Участие в подготовке до передачи работы')
                page.screenshot(path=str(output / 'pay-desktop.png'), full_page=True)
                fixture.fail_once = True
                save.click()
                expect(card.get_by_role('alert')).to_contain_text('не подтверждено')
                expect(fields[0]).to_have_value('150,00')
                save.click()
                expect(page.get_by_text('Распределение сохранено.', exact=True)).to_be_visible()
                assert len(fixture.saves) == 2 and fixture.saves[0] == fixture.saves[1]
                assert fixture.item['pool_kopeks'] == 25000
                assert [s['kopeks'] for s in fixture.saves[-1]['p_amounts']] == [15000, 8750, 1250]
                assert len(fixture.revisions) == 1
                view = page.get_by_role('combobox', name='Показать', exact=True)
                expect(view).to_be_focused()
                view.select_option('allocated')
                card.get_by_role('button', name='История изменений').click()
                expect(card.locator('.pay-revisions')).to_contain_text('Участие в подготовке')
                expect(card.locator('.pay-revisions')).to_contain_text(re.compile(r'Олег Власов · 12,50\sBYN'))
                fixture.item['candidates'] = fixture.item['candidates'][:2]
                page.get_by_role('button', name='Обновить', exact=True).click()
                card.get_by_role('button', name='Изменить распределение').click()
                expect(fields[1]).to_have_value('87,50')
                expect(card.locator('.pay-editor')).to_contain_text(re.compile(r'Олег Власов · 12,50\sBYN'))
                card.get_by_label('Сохранить новое распределение без этих механиков').check()
                fields[0].fill('0')
                fields[1].fill('0')
                card.get_by_label('Подтверждаю сумму').check()
                card.get_by_label('Причина распределения').fill('Без оплаты по решению владельца')
                fixture.conflict_once = True
                save.click()
                expect(card.get_by_label('Последняя сохранённая версия')).to_contain_text('Сохранённая версия 2')
                expect(fields[0]).to_have_value('0')
                card.get_by_role('button', name='Продолжить с моими значениями').click()
                card.get_by_label('Подтверждаю сумму').check()
                save.click()
                expect(card.get_by_role('button', name='Изменить распределение')).to_be_visible()
                assert fixture.saves[-1]['p_zero_confirmed'] is True and fixture.item['pool_kopeks'] == 0
                assert fixture.saves[-1]['p_expected_version'] == 2
                assert fixture.saves[-1]['p_request_id'] != fixture.saves[-2]['p_request_id']
                view.select_option('pending')
                page.set_viewport_size({'width': 390, 'height': 844})
                solo = page.locator('.pay-card[data-task-id="solo"]')
                solo.get_by_role('button', name='Распределить').click()
                expect(solo.get_by_label('Артём Савин, BYN')).to_have_value('')
                expect(solo.get_by_label('Артём Савин, BYN')).to_be_focused()
                solo.get_by_label('Артём Савин, BYN').fill('10,50')
                expect(solo.get_by_label('Итого механикам')).to_have_text(re.compile(r'10,50\sBYN'))
                expect(solo.get_by_role('button', name='Разделить поровну')).to_have_count(0)
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
    print('Passed exact BYN amounts, equal split, changed rosters, lost receipt, conflict recovery, zero pay, history, mobile, focus and role isolation.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--output', type=Path, default=Path('/tmp/garage-browser-pay'))
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    run(args.directory, args.output, args.chromium)
