#!/usr/bin/env python3
"""Exercise Owner sheet setup with synthetic records and no live service calls."""

import argparse
import importlib.util
import json
from pathlib import Path
import re

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('garage_smoke', ROOT / 'tests/browser-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
SOURCE_ID = '33333333-3333-4333-8333-333333333333'
SHEET_ID = '1SyntheticManagerSheet000000000000000001'


def source(**overrides):
    return {
        'id': SOURCE_ID, 'source_id': SOURCE_ID, 'name': 'Synthetic Manager workbook',
        'spreadsheet_id': SHEET_ID, 'active': True, 'version': 1,
        'last_success_at': None, 'last_error_at': None, 'last_error_code': None,
        'last_error': None, 'created_at': '2026-11-12T10:00:00Z', **overrides,
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
    expect(page.get_by_role('heading', name='Sheet connections', exact=True)).to_be_visible()
    expect(page.get_by_role('button', name='Register spreadsheet', exact=True)).to_be_visible()
    return context, page, errors, live


def fill_connection(page, name='Synthetic Manager feed', sheet=None):
    page.get_by_label('Connection name', exact=True).fill(name)
    page.get_by_label('Spreadsheet link or ID', exact=True).fill(sheet or f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit')


def setup_secret(page):
    field = page.get_by_label('INTEGRATION_SECRET', exact=True)
    expect(field).to_be_visible()
    value = field.input_value()
    assert re.fullmatch(r'[A-Za-z0-9_-]{43}', value), 'Expected a generated 32-byte base64url setup key.'
    expect(field).to_have_attribute('type', 'password')
    return value


def no_persisted_secret(page, secret):
    stored = page.evaluate('JSON.stringify({local: {...localStorage}, session: {...sessionStorage}, cookie: document.cookie})')
    assert secret not in stored, 'The one-time setup key entered browser storage.'
    cached = page.evaluate('''async () => {
      const bodies = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) bodies.push(await (await cache.match(request)).text());
      }
      return bodies.join('\\n');
    }''')
    assert secret not in cached, 'The one-time setup key entered Cache Storage.'


def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    server, base = smoke.serve(args.directory.resolve())
    passed = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        try:
            # Registration is not evidence of a running Google worker.
            context, page, errors, live = open_sheets(browser, base)
            fill_connection(page, sheet=f'https://example.invalid/spreadsheets/d/{SHEET_ID}/edit')
            page.get_by_role('button', name='Register spreadsheet', exact=True).click()
            expect(page.get_by_text('Enter a name and a valid Google Sheets link or spreadsheet ID.', exact=True)).to_be_visible()
            assert not calls(page, 'garage_register_sheet')
            page.get_by_label('Spreadsheet link or ID', exact=True).fill(SHEET_ID)
            page.get_by_role('button', name='Register spreadsheet', exact=True).click()
            expect(page.get_by_text('Waiting for first sync', exact=True)).to_be_visible()
            expect(page.get_by_text('Has synchronized', exact=True)).to_have_count(0)
            submitted = calls(page, 'garage_register_sheet')
            assert len(submitted) == 1
            secret = setup_secret(page)
            assert submitted[0]['args']['p_secret'] == secret
            assert submitted[0]['args']['p_spreadsheet_id'] == SHEET_ID
            assert page.get_by_label('INTEGRATION_ID', exact=True).input_value() == submitted[0]['args']['p_source_id']
            assert page.get_by_label('API_URL', exact=True).input_value() == 'https://example.supabase.co/functions/v1/manager-orders'
            assert secret not in page.locator('[data-source-id]').inner_text()
            no_persisted_secret(page, secret)
            page.get_by_role('button', name='Show secret', exact=True).click()
            expect(page.get_by_label('INTEGRATION_SECRET', exact=True)).to_have_attribute('type', 'text')
            page.get_by_role('button', name='Hide secret', exact=True).click()
            page.get_by_role('button', name='Hide setup credentials', exact=True).click()
            expect(page.get_by_label('INTEGRATION_SECRET', exact=True)).to_have_count(0)
            no_persisted_secret(page, secret)
            passed.append('strict Google link parsing, one-time Owner setup and honest waiting status')
            finish(context, errors, live)

            # Double submissions and ambiguous acknowledgements preserve resource identity/key.
            context, page, errors, live = open_sheets(browser, base, {
                'rpcDelays': {'garage_register_sheet': 450},
            })
            fill_connection(page)
            register = page.get_by_role('button', name='Register spreadsheet', exact=True)
            register.click()
            expect(register).to_be_disabled()
            page.locator('form.sheet-registration').evaluate('form => { form.requestSubmit(); form.requestSubmit(); }')
            setup_secret(page)
            assert len(calls(page, 'garage_register_sheet')) == 1
            passed.append('in-flight registration cannot create competing connections')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {'loseSheetRegisterResponseOnce': True})
            fill_connection(page)
            register = page.get_by_role('button', name='Register spreadsheet', exact=True)
            register.click()
            expect(page.get_by_text('Registration not confirmed', exact=True)).to_be_visible()
            register.click()
            secret = setup_secret(page)
            submitted = calls(page, 'garage_register_sheet')
            assert len(submitted) == 2
            assert submitted[0]['args'] == submitted[1]['args']
            assert secret == submitted[0]['args']['p_secret']
            assert page.evaluate('__garageSheetState.sources.length') == 1
            passed.append('lost registration response retries the same UUID and setup key')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {
                'rpcDelays': {'garage_sheet_sources': 650}, 'freezeSheetListSnapshot': True,
            })
            fill_connection(page)
            page.get_by_role('button', name='Register spreadsheet', exact=True).click()
            setup_secret(page)
            expect(page.locator('[data-source-id]')).to_have_count(1)
            page.wait_for_timeout(800)
            expect(page.locator('[data-source-id]')).to_have_count(1)
            expect(page.get_by_text('Waiting for first sync', exact=True)).to_be_visible()
            passed.append('an older source-list snapshot cannot erase a new registration')
            finish(context, errors, live)

            # Replacement is explicit and pause/resume does not invent a sync success.
            context, page, errors, live = open_sheets(browser, base, {'sheetSources': [source()]})
            expect(page.get_by_text('Waiting for first sync', exact=True)).to_be_visible()
            expect(page.get_by_label('INTEGRATION_SECRET', exact=True)).to_have_count(0)
            page.get_by_role('button', name='Pause imports', exact=True).click()
            expect(page.locator('[data-source-id]').get_by_text('Imports paused', exact=True)).to_be_visible()
            page.get_by_role('button', name='Resume imports', exact=True).click()
            expect(page.get_by_text('Waiting for first sync', exact=True)).to_be_visible()
            page.get_by_role('button', name='Replace worker secret', exact=True).click()
            secret = setup_secret(page)
            assert len(calls(page, 'garage_rotate_sheet_secret')) == 1
            assert calls(page, 'garage_rotate_sheet_secret')[0]['args']['p_expected_version'] == 3
            assert page.evaluate('__garageSheetState.sources[0].version') == 4
            no_persisted_secret(page, secret)
            page.get_by_role('link', name='Approved works', exact=True).click()
            expect(page.get_by_label('INTEGRATION_SECRET', exact=True)).to_have_count(0)
            assert secret not in page.locator('body').inner_text()
            page.get_by_role('link', name='Sheet connections', exact=True).click()
            expect(page.get_by_label('INTEGRATION_SECRET', exact=True)).to_have_count(0)
            passed.append('explicit replacement/pause/resume and route disposal of credentials')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {
                'sheetSources': [source()], 'loseSheetRotateResponseOnce': True,
            })
            page.get_by_role('button', name='Replace worker secret', exact=True).click()
            expect(page.get_by_text('Replacement not confirmed', exact=True)).to_be_visible()
            page.get_by_role('button', name='Replace worker secret', exact=True).click()
            setup_secret(page)
            rotations = calls(page, 'garage_rotate_sheet_secret')
            assert len(rotations) == 2 and rotations[0]['args'] == rotations[1]['args']
            assert page.evaluate('__garageSheetState.sources[0].version') == 2
            passed.append('lost replacement response retries the same key and version')
            finish(context, errors, live)

            # Server errors are rendered as safe feedback, not raw payloads.
            context, page, errors, live = open_sheets(browser, base, {'sheetSources': [source(
                last_success_at='2026-11-12T11:00:00Z', last_error='INTERNAL_PAYLOAD_DO_NOT_DISPLAY',
            )]})
            expect(page.get_by_text('Has synchronized', exact=True)).to_be_visible()
            assert 'INTERNAL_PAYLOAD_DO_NOT_DISPLAY' not in page.locator('body').inner_text()
            passed.append('last successful sync is distinguished from sanitized submission errors')
            finish(context, errors, live)

            # A server response may still arrive after local logout. It must not paint private data.
            context, page, errors, live = open_sheets(browser, base, {
                'rpcDelays': {'garage_register_sheet': 700}, 'allowLateRpcResponse': True,
            })
            fill_connection(page, name='Synthetic private late connection')
            page.get_by_role('button', name='Register spreadsheet', exact=True).click()
            page.wait_for_function('(__garageCalls || []).some(c => c.name === "garage_register_sheet")')
            secret = calls(page, 'garage_register_sheet')[0]['args']['p_secret']
            page.get_by_role('button', name='Sign out', exact=True).click()
            expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
            page.wait_for_timeout(850)
            expect(page.get_by_label('INTEGRATION_SECRET', exact=True)).to_have_count(0)
            assert 'Synthetic private late connection' not in page.locator('body').inner_text()
            no_persisted_secret(page, secret)
            passed.append('late registration response cannot restore private setup after logout')
            finish(context, errors, live)

            context, page, errors, live = open_sheets(browser, base, {
                'sheetSources': [source(name='Synthetic delayed private metadata')],
                'rpcDelays': {'garage_sheet_sources': 650}, 'allowLateRpcResponse': True,
            })
            page.wait_for_function('(__garageCalls || []).some(c => c.name === "garage_sheet_sources")')
            page.get_by_role('link', name='Orders', exact=True).click()
            page.wait_for_timeout(800)
            expect(page.get_by_role('heading', name='Orders', exact=True)).to_be_visible()
            assert 'Synthetic delayed private metadata' not in page.locator('body').inner_text()
            passed.append('late source-list response cannot repaint a different route')
            finish(context, errors, live)

            context, page, errors, live = smoke.new_page(browser, {
                'profile': {'name': 'Test Mechanic', 'role': 'mechanic'},
                'sheetSources': [source()],
            }, {'width': 390, 'height': 844})
            page.goto(base + '/index.html#sheets')
            smoke.ready(page, 'Test Mechanic')
            expect(page.get_by_role('heading', name='Assigned by Owner', exact=True)).to_be_visible()
            expect(page.get_by_role('link', name='Sheet connections', exact=True)).to_have_count(0)
            expect(page.get_by_label('INTEGRATION_SECRET', exact=True)).to_have_count(0)
            assert not page.evaluate('(__garageCalls || []).some(c => c.method === "rpc" && /sheet/.test(c.name))')
            passed.append('Mechanic navigation and direct hashes cannot access connection APIs')
            finish(context, errors, live)

            for width in (320, 390):
                context, page, errors, live = open_sheets(browser, base, {'sheetSources': [source()]}, width)
                expect(page.get_by_text('Waiting for first sync', exact=True)).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Overflow at {width}px'
                expect(page.get_by_role('link', name='Sheet connections', exact=True)).to_be_visible()
                page.screenshot(path=str(args.output / f'owner-connections-{width}.png'), full_page=True)
                finish(context, errors, live)
            passed.append('320px and 390px Owner navigation and connection layout fit')
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
    parser.add_argument('--output', type=Path, default=Path('/workspace/scratch/sheets-smoke'))
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    run(parser.parse_args())
