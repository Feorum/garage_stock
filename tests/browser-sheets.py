#!/usr/bin/env python3
"""Exercise Owner existing-sheet connections with synthetic data only."""

import argparse
import importlib.util
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('garage_smoke', ROOT / 'tests/browser-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
SOURCE_ID = '33333333-3333-4333-8333-333333333333'
SHEET_ID = '1SyntheticManagerSheet000000000000000001'
TAB_ID = 123456789


def source(**overrides):
    return {
        'id': SOURCE_ID, 'source_id': SOURCE_ID, 'name': 'Synthetic existing Manager orders',
        'spreadsheet_id': SHEET_ID, 'sheet_gid': TAB_ID, 'mode': 'pull', 'reader_only': True, 'active': True, 'version': 1,
        'last_success_at': None, 'last_polled_at': None, 'last_error_code': None,
        'review_count': 0, 'summary': {}, 'created_at': '2026-11-13T10:00:00Z', **overrides,
    }


def calls(page, name):
    return page.evaluate('(name) => (__garageCalls || []).filter(c => c.method === "rpc" && c.name === name)', name)


def finish(context, errors, live):
    assert not errors, errors
    assert not live, live
    context.close()


def open_sheets(browser, base, fixture=None, width=1440):
    context, page, errors, live = smoke.new_page(browser, fixture or {}, {'width': width, 'height': 1000})
    page.goto(base + '/index.html#sheets')
    smoke.ready(page, 'Test Owner')
    expect(page.get_by_role('heading', name='Подключения таблиц', exact=True)).to_be_visible()
    expect(page.get_by_role('button', name='Подключить рабочую копию', exact=True)).to_be_visible()
    return context, page, errors, live


def fill_connection(page, name='Synthetic existing feed', sheet=None):
    page.get_by_label('Название подключения', exact=True).fill(name)
    page.get_by_label('Ссылка или идентификатор таблицы', exact=True).fill(sheet or f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid={TAB_ID}')


def setup_secret(page):
    field = page.get_by_label('Секретный ключ', exact=True)
    expect(field).to_be_visible()
    value = field.input_value()
    assert re.fullmatch(r'[A-Za-z0-9_-]{43}', value)
    expect(field).to_have_attribute('type', 'password')
    return value


def no_persisted_secret(page, secret):
    stored = page.evaluate('JSON.stringify({local: {...localStorage}, session: {...sessionStorage}, cookie: document.cookie})')
    assert secret not in stored
    cached = page.evaluate('''async () => {
      const bodies = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) bodies.push(await (await cache.match(request)).text());
      }
      return bodies.join('\\n');
    }''')
    assert secret not in cached


def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    server, base = smoke.serve(args.directory.resolve())
    passed = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        try:
            context, page, errors, live = open_sheets(browser, base)
            page.get_by_role('button', name='Подключить рабочую копию', exact=True).click()
            assert page.get_by_label('Название подключения', exact=True).evaluate('(input) => input.validationMessage') == 'Заполните это поле.'
            fill_connection(page)
            assert page.get_by_label('Идентификатор листа заказов', exact=True).evaluate('(input) => input.validity.valid')
            assert not calls(page, 'garage_connect_sheet_pull')
            passed.append('Russian browser validation clears after automatic tab ID filling')
            fill_connection(page, sheet=f'https://example.invalid/spreadsheets/d/{SHEET_ID}/edit#gid={TAB_ID}')
            page.get_by_label('Идентификатор листа заказов', exact=True).fill(str(TAB_ID))
            page.get_by_role('button', name='Подключить рабочую копию', exact=True).click()
            expect(page.get_by_text('Укажите название, корректную ссылку или идентификатор таблицы Google и идентификатор листа заказов.', exact=True)).to_be_visible()
            assert not calls(page, 'garage_connect_sheet_pull')
            fill_connection(page)
            expect(page.get_by_label('Идентификатор листа заказов', exact=True)).to_have_value(str(TAB_ID))
            page.get_by_role('button', name='Подключить рабочую копию', exact=True).click()
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            expect(page.get_by_text('Синхронизация выполнена', exact=True)).to_have_count(0)
            submitted = calls(page, 'garage_connect_sheet_pull')
            assert submitted == [{
                'method': 'rpc', 'name': 'garage_connect_sheet_pull',
                'args': {'p_name': 'Synthetic existing feed', 'p_spreadsheet_id': SHEET_ID, 'p_sheet_gid': TAB_ID},
            }]
            assert not any(key in json.dumps(submitted) for key in ['secret', 'token'])
            body = page.locator('body').inner_text()
            assert 'Секретный ключ' not in body
            assert 'исходная таблица не изменяется' in body.lower()
            assert not calls(page, 'garage_register_sheet')
            expect(page.get_by_role('link', name='Открыть рабочую копию', exact=True)).to_have_attribute(
                'href', f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid={TAB_ID}')
            passed.append('working copy link and tab connect without exposing credentials or modifying the original')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base)
            fill_connection(page, sheet=SHEET_ID)
            page.get_by_label('Идентификатор листа заказов', exact=True).fill('2147483648')
            page.get_by_role('button', name='Подключить рабочую копию', exact=True).click()
            expect(page.get_by_text('Проверьте подключение', exact=True)).to_be_visible()
            assert not calls(page, 'garage_connect_sheet_pull')
            page.get_by_label('Идентификатор листа заказов', exact=True).fill('0')
            page.get_by_role('button', name='Подключить рабочую копию', exact=True).click()
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            assert calls(page, 'garage_connect_sheet_pull')[0]['args']['p_sheet_gid'] == 0
            passed.append('raw spreadsheet IDs and tab zero are supported; invalid tab IDs never reach the server')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {'rpcDelays': {'garage_connect_sheet_pull': 450}})
            fill_connection(page)
            connect = page.get_by_role('button', name='Подключить рабочую копию', exact=True)
            connect.click()
            expect(connect).to_be_disabled()
            page.locator('form.sheet-registration').evaluate('form => { form.requestSubmit(); form.requestSubmit(); }')
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            assert len(calls(page, 'garage_connect_sheet_pull')) == 1
            passed.append('in-flight connection cannot create competing requests')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {'loseSheetRegisterResponseOnce': True})
            fill_connection(page)
            connect = page.get_by_role('button', name='Подключить рабочую копию', exact=True)
            connect.click()
            expect(page.get_by_text('Подключение не подтверждено', exact=True)).to_be_visible()
            connect.click()
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            submitted = calls(page, 'garage_connect_sheet_pull')
            assert len(submitted) == 2 and submitted[0]['args'] == submitted[1]['args']
            assert page.evaluate('__garageSheetState.sources.length') == 1
            passed.append('lost connection acknowledgement retries idempotently with the same sheet and tab')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {
                'rpcDelays': {'garage_sheet_pull_sources': 650}, 'freezeSheetListSnapshot': True,
            })
            fill_connection(page)
            page.get_by_role('button', name='Подключить рабочую копию', exact=True).click()
            expect(page.locator('[data-source-id]')).to_have_count(1)
            page.wait_for_timeout(800)
            expect(page.locator('[data-source-id]')).to_have_count(1)
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            passed.append('stale source list cannot erase a newer connection')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {'sheetSources': [source()]})
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            page.get_by_role('button', name='Приостановить импорт', exact=True).click()
            expect(page.locator('[data-source-id]').get_by_text('Импорт приостановлен', exact=True)).to_be_visible()
            page.get_by_role('button', name='Возобновить импорт', exact=True).click()
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            changes = calls(page, 'garage_set_sheet_active')
            assert [entry['args']['p_expected_version'] for entry in changes] == [1, 2]
            expect(page.get_by_role('link', name='Открыть рабочую копию', exact=True)).to_have_attribute(
                'href', f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid={TAB_ID}')
            passed.append('pause/resume preserves tab metadata and does not invent synchronization')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {
                'sheetSources': [source(last_success_at='2026-11-13T11:00:00Z', review_count=2, summary={'awaiting_stability': 1, 'feedback_confirmed': 2, 'feedback_pending': 1})],
                'sheetReviews': {SOURCE_ID: [
                    {'row_number': 23, 'vehicle': 'Synthetic vehicle <img src=x onerror=alert(1)>', 'planned_date': '2026-11-13',
                     'reason_codes': ['TINT_PERCENTAGE_REQUIRED', 'UNRECOGNIZED_SCOPE_FRAGMENT']},
                    {'row_number': 24, 'vehicle': 'Synthetic model', 'reason_codes': ['INTERNAL_PAYLOAD_DO_NOT_DISPLAY']},
                ]},
            })
            expect(page.get_by_text('Синхронизация выполнена', exact=True)).to_be_visible()
            expect(page.get_by_text('Строк на проверке у владельца: 2.', exact=True)).to_be_visible()
            expect(page.get_by_text('Результаты выполнения: подтверждено 2 · ожидает 1.', exact=True)).to_be_visible()
            expect(page.get_by_text('Ожидают повторного чтения: 1. Перед публикацией данные должны остаться неизменными при двух чтениях с интервалом не менее минуты.', exact=True)).to_be_visible()
            page.get_by_role('button', name='Проверить строки', exact=True).click()
            expect(page.get_by_role('heading', name='Строки для проверки владельцем', exact=True)).to_be_visible()
            expect(page.get_by_text('Выберите процент тонировки: 5% или 15%.', exact=True)).to_be_visible()
            assert 'INTERNAL_PAYLOAD_DO_NOT_DISPLAY' not in page.locator('body').inner_text()
            assert page.locator('.sheet-review-area img').count() == 0
            expect(page.get_by_role('link', name='Открыть исходную строку', exact=True).first).to_have_attribute(
                'href', f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid={TAB_ID}&range=A23:J23')
            assert calls(page, 'garage_sheet_pull_reviews')[0]['args'] == {'p_source_id': SOURCE_ID}
            page.get_by_role('button', name='Закрыть проверку', exact=True).click()
            expect(page.get_by_role('heading', name='Строки для проверки владельцем', exact=True)).to_have_count(0)
            passed.append('Owner sees safe review explanations and exact source-row links; cell text is escaped')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {
                'sheetSources': [source(last_success_at='2026-11-13T11:00:00Z', last_error_code='INTERNAL_PAYLOAD_DO_NOT_DISPLAY')],
            })
            expect(page.get_by_text('Требуется проверка', exact=True)).to_be_visible()
            assert 'INTERNAL_PAYLOAD_DO_NOT_DISPLAY' not in page.locator('body').inner_text()
            passed.append('failed last check uses fixed feedback without exposing server diagnostics')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {
                'rpcDelays': {'garage_connect_sheet_pull': 700}, 'allowLateRpcResponse': True,
            })
            fill_connection(page, name='Synthetic private late connection')
            page.get_by_role('button', name='Подключить рабочую копию', exact=True).click()
            page.wait_for_function('(__garageCalls || []).some(c => c.name === "garage_connect_sheet_pull")')
            page.get_by_role('button', name='Выйти', exact=True).click()
            expect(page.get_by_role('button', name='Войти', exact=True)).to_be_visible()
            page.wait_for_timeout(850)
            assert 'Synthetic private late connection' not in page.locator('body').inner_text()
            passed.append('late connection response cannot paint private data after logout')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {
                'sheetSources': [source()], 'rpcDelays': {'garage_sheet_pull_reviews': 650}, 'allowLateRpcResponse': True,
                'sheetReviews': {SOURCE_ID: [{'row_number': 12, 'vehicle': 'Synthetic late private row', 'reason_codes': ['NO_TASKS']}]},
            })
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            page.get_by_role('button', name='Проверить строки', exact=True).click()
            page.get_by_role('link', name='Заказы', exact=True).click()
            page.wait_for_timeout(800)
            expect(page.get_by_role('heading', name='Заказы', exact=True)).to_be_visible()
            assert 'Synthetic late private row' not in page.locator('body').inner_text()
            passed.append('late review response cannot repaint a different route')
            finish(context, errors, live)

            context, page, errors, live = smoke.new_page(browser, {
                'profile': {'name': 'Test Mechanic', 'role': 'mechanic'}, 'sheetSources': [source()],
            }, {'width': 390, 'height': 844})
            page.goto(base + '/index.html#sheets')
            smoke.ready(page, 'Test Mechanic')
            expect(page.get_by_role('heading', name='Назначено владельцем', exact=True)).to_be_visible()
            expect(page.get_by_role('link', name='Подключения таблиц', exact=True)).to_have_count(0)
            assert not page.evaluate('(__garageCalls || []).some(c => c.method === "rpc" && /sheet/.test(c.name))')
            passed.append('Mechanic navigation and direct hashes cannot access sheet connection or review APIs')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {'sheetSources': [source()]})
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            page.get_by_role('button', name='Настроить закрытый загрузчик', exact=True).click()
            secret = setup_secret(page)
            expect(page.get_by_text('Скопируйте файлы Code.gs, Feedback.gs и манифест из инструкции, затем добавьте функцию настройки ниже.', exact=True)).to_be_visible()
            expect(page.get_by_text('Google запрашивает разрешение на редактирование таблиц.', exact=False)).to_be_visible()
            submitted = calls(page, 'garage_prepare_sheet_reader')
            assert len(submitted) == 1 and submitted[0]['args']['p_expected_version'] == 1
            assert submitted[0]['args']['p_secret'] == secret
            assert page.get_by_label('Идентификатор таблицы', exact=True).input_value() == SHEET_ID
            assert page.get_by_label('Идентификатор листа', exact=True).input_value() == str(TAB_ID)
            assert page.get_by_label('Адрес сервера', exact=True).input_value() == 'https://example.supabase.co/functions/v1/pull-manager-sheets/source'
            expect(page.get_by_text('Синхронизация выполнена', exact=True)).to_have_count(0)
            assert secret not in page.locator('[data-source-id]').inner_text()
            no_persisted_secret(page, secret)
            page.evaluate('navigator.clipboard.writeText = async text => { globalThis.__copiedReaderSetup = text; }')
            page.get_by_role('button', name='Скопировать функцию настройки', exact=True).click()
            copied = page.evaluate('globalThis.__copiedReaderSetup')
            assert copied.startswith('function setupConnection() {\n') and '\n  install();\n}' in copied
            assert secret in copied
            assert page.evaluate('(code) => { new Function(code); return true; }', copied)
            page.get_by_role('button', name='Показать ключ', exact=True).click()
            expect(page.get_by_label('Секретный ключ', exact=True)).to_have_attribute('type', 'text')
            page.get_by_role('button', name='Скрыть ключ', exact=True).click()
            page.get_by_role('link', name='Заказы', exact=True).click()
            expect(page.get_by_label('Секретный ключ', exact=True)).to_have_count(0)
            page.get_by_role('link', name='Подключения таблиц', exact=True).click()
            expect(page.get_by_label('Секретный ключ', exact=True)).to_have_count(0)
            no_persisted_secret(page, secret)
            passed.append('private reader settings are one-time, copy-scoped, masked and cleared on navigation without browser persistence')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {'sheetSources': [source()], 'loseSheetReaderResponseOnce': True})
            page.get_by_role('button', name='Настроить закрытый загрузчик', exact=True).click()
            expect(page.get_by_text('Настройка загрузчика не подтверждена', exact=True)).to_be_visible()
            page.get_by_role('button', name='Настроить закрытый загрузчик', exact=True).click()
            secret = setup_secret(page)
            attempts = calls(page, 'garage_prepare_sheet_reader')
            assert len(attempts) == 2 and attempts[0]['args'] == attempts[1]['args']
            assert secret == attempts[0]['args']['p_secret']
            assert page.evaluate('__garageSheetState.sources[0].version') == 2
            passed.append('lost private-reader acknowledgement retries the same key and source version')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {
                'sheetSources': [source()], 'rpcDelays': {'garage_prepare_sheet_reader': 700}, 'allowLateRpcResponse': True,
            })
            expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
            page.get_by_role('button', name='Настроить закрытый загрузчик', exact=True).click()
            page.wait_for_function('(__garageCalls || []).some(c => c.name === "garage_prepare_sheet_reader")')
            secret = calls(page, 'garage_prepare_sheet_reader')[0]['args']['p_secret']
            page.get_by_role('button', name='Выйти', exact=True).click()
            expect(page.get_by_role('button', name='Войти', exact=True)).to_be_visible()
            page.wait_for_timeout(850)
            expect(page.get_by_label('Секретный ключ', exact=True)).to_have_count(0)
            assert secret not in page.locator('body').inner_text()
            no_persisted_secret(page, secret)
            passed.append('late private-reader response cannot expose its key after logout')
            finish(context, errors, live)

            for width in (320, 390):
                context, page, errors, live = open_sheets(browser, base, {'sheetSources': [source(review_count=1)], 'sheetReviews': {
                    SOURCE_ID: [{'row_number': 23, 'vehicle': 'Synthetic vehicle', 'reason_codes': ['TINT_PERCENTAGE_REQUIRED']}],
                }}, width)
                expect(page.get_by_text('Ожидается настройка загрузчика', exact=True)).to_be_visible()
                page.get_by_role('button', name='Проверить строки', exact=True).click()
                expect(page.get_by_role('heading', name='Строки для проверки владельцем', exact=True)).to_be_visible()
                page.get_by_role('button', name='Настроить закрытый загрузчик', exact=True).click()
                setup_secret(page)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Overflow at {width}px'
                page.screenshot(path=str(args.output / f'owner-existing-sheet-{width}.png'), full_page=True)
                finish(context, errors, live)
            passed.append('320px and 390px connection and private review screens fit')
        finally:
            browser.close()
            server.shutdown()
            server.server_close()
    result = {'passed': passed, 'count': len(passed), 'live_service_requests': 0}
    (args.output / 'sheets-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--output', type=Path, default=Path('/workspace/scratch/existing-sheet-smoke'))
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    run(parser.parse_args())
