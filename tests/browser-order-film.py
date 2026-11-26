"""Check owner film entry, per-work allocation and the downloadable JSONL in the built application."""
import argparse
import base64
from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
import re

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location('film_browser_smoke', ROOT / 'tests/browser-smoke.py')
smoke = module_from_spec(spec)
spec.loader.exec_module(smoke)


class FilmFixture:
    def __init__(self):
        self.order = {'id': 'film-order', 'vehicle': 'Тестовый S50', 'vehicle_group_code': 'VG02',
                      'order_number': 'G-101', 'status': 'published', 'source': 'manager',
                      'version': 1, 'priority': 'normal', 'tasks': []}
        self.state = {'version': 0, 'price_token': 'initial-price', 'mode': 'order',
                      'order_price_kopeks': 90000, 'amount_kopeks': None, 'lines': []}
        for task_id, code, name, price in [('hood', 'W01', 'Капот', 60000), ('mirrors', 'W13', 'Зеркала', 30000)]:
            self.order['tasks'].append({'id': task_id, 'work_code': code, 'work_name': name, 'options': {},
                                        'status': 'completed', 'version': 1, 'participants': []})
            self.state['lines'].append({'task_id': task_id, 'name': name, 'price_kopeks': price, 'amount_kopeks': None})
        self.reads = 0
        self.saves = []
        self.file_reads = []
        # Exercise the same range contract as a real history larger than a response chunk.
        self.history = '{"note":"предыдущая запись"}\n'.encode() * 7000
        self.conflict_once = False

    def rpc(self, name, args):
        replies = {'garage_list_orders': [self.order], 'garage_manager_intakes': [], 'garage_staff': [],
                   'garage_custom_orders': [], 'garage_owner_gift_offer': None,
                   'garage_order_financials': {'status': 'priced', 'tasks': []}}
        if name == 'garage_order_film':
            assert args['p_order_id'] == self.order['id']
            self.reads += 1
            data = self.state
        elif name == 'garage_save_order_film':
            assert args['p_order_id'] == self.order['id'] and args['p_request_id']
            assert args['p_expected_version'] == self.state['version'] and args['p_price_token'] == self.state['price_token']
            if self.conflict_once:
                self.conflict_once = False
                self.state['price_token'] = 'revised-price'
                return {'data': None, 'error': {'code': '40001', 'message': 'stale price'}}
            self.saves.append(args)
            self.state.update(version=self.state['version'] + 1, mode=args['p_mode'], amount_kopeks=args['p_amount_kopeks'])
            for line in self.state['lines']:
                line['amount_kopeks'] = args['p_works'].get(line['task_id'])
            self.history += (json.dumps({'mode': args['p_mode'], 'amount': args['p_amount_kopeks'], 'works': args['p_works']}) + '\n').encode()
            data = self.state
        elif name == 'garage_film_file':
            start, count = args['p_offset'], args['p_length']
            self.file_reads.append((start, count))
            chunk = self.history[start:start + count]
            data = {'size': len(self.history), 'data': base64.b64encode(chunk).decode('ascii')}
        else:
            data = replies.get(name)
        return {'data': data, 'error': None}


def exercise(browser, base):
    fixture = FilmFixture()
    context, page, errors, live = smoke.new_page(browser, {}, viewport={'width': 390, 'height': 844})
    try:
        page.expose_function('__garageRpcFixture', fixture.rpc)
        page.goto(base + '/index.html#orders/film-order')
        page.get_by_role('button', name='Цены', exact=True).click()
        film = page.locator('details').filter(has=page.locator('summary', has_text='Расход на плёнку'))
        summary = film.locator('summary', has_text='Расход на плёнку')
        expect(summary).to_be_visible()
        assert fixture.reads == 0
        summary.click()
        mode = film.get_by_label('Учитывать расход')
        order_amount = film.get_by_label('Плёнка на заказ, BYN')
        save = film.get_by_role('button', name='Сохранить расход')
        expect(mode).to_have_value('order')
        expect(order_amount).to_have_value('')
        order_amount.fill('9,001')
        save.click()
        expect(film.get_by_role('alert')).to_contain_text('до двух знаков')
        assert not fixture.saves
        order_amount.fill('90')
        expect(film.locator('output')).to_have_text(re.compile(r'10\s*%'))
        save.click()
        expect(order_amount).to_have_value('90,00')
        assert fixture.saves[-1]['p_amount_kopeks'] == 9000 and fixture.saves[-1]['p_works'] == {}
        mode.select_option('works')
        hood, mirrors = (film.get_by_label(f'Плёнка · {work}, BYN') for work in ('Капот', 'Зеркала'))
        hood.fill('30.75')
        expect(film.locator('output').first).to_have_text(re.compile(r'5,13\s*%'))
        expect(mirrors).to_have_value('')
        save.click()
        expect(hood).to_have_value('30,75')
        expect(page.get_by_text('Расход на плёнку сохранён.', exact=True)).to_be_visible()
        assert fixture.saves[-1]['p_amount_kopeks'] is None and fixture.saves[-1]['p_works'] == {'hood': 3075}
        mirrors.fill('0')
        expect(film.locator('output').last).to_have_text(re.compile(r'0\s*%'))
        fixture.conflict_once = True
        save.click()
        confirm = film.get_by_role('button', name='Подтвердить актуальные данные')
        expect(confirm).to_be_visible()
        expect(save).to_be_disabled()
        expect(mirrors).to_have_value('0')
        confirm.click()
        save.click()
        expect(mirrors).to_have_value('0,00')
        assert fixture.saves[-1]['p_works'] == {'hood': 3075, 'mirrors': 0}
        assert fixture.saves[-1]['p_price_token'] == 'revised-price'
        assert not fixture.file_reads
        page.reload()
        page.get_by_role('button', name='Цены', exact=True).click()
        summary.click()
        expect(mode).to_have_value('works')
        expect(hood).to_have_value('30,75')
        expect(mirrors).to_have_value('0,00')
        with page.expect_download() as result:
            film.get_by_role('button', name='Скачать историю расходов').click()
        file = result.value
        assert file.suggested_filename == 'film-patterns.jsonl'
        assert file.path().read_bytes() == fixture.history
        assert len(fixture.file_reads) >= 2 and fixture.file_reads[1][0] == fixture.file_reads[0][1]
        assert not errors and not live, (errors, live)
    finally:
        context.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    options = parser.parse_args()
    server, base = smoke.serve(options.directory.resolve())
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=options.chromium, args=['--no-sandbox'])
            try:
                exercise(browser, base)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Passed order and per-work film costs, price conflicts and chunked JSONL download.')
