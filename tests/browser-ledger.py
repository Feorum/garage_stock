#!/usr/bin/env python3
"""Exercise the private editable ledger with synthetic records and no live requests."""
import argparse
from copy import deepcopy
import importlib.util
import json
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('garage_smoke', ROOT / 'tests/browser-smoke.py')
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)
smoke.SDK = (ROOT / 'tests/fake-ledger.js').read_text(encoding='utf-8') + '\n' + smoke.SDK


def cell(value, kind=None, formula=None, cached=None):
    return {'value': value, 'type': kind or ('number' if isinstance(value, (int, float)) else 'string'),
            'formula': formula, 'cached': cached, 'format': ''}


def fixture(**options):
    headers = [{'column': col, 'label': label, 'type': kind} for col, label, kind in (
        ('A', 'Date', 'date'), ('B', 'Price', 'number'), ('C', 'Description', 'string'),
        ('G', 'Owner earnings', 'number'), ('H', 'Staff allocation', 'number'))]
    rows = []
    for number, price, text in ((2, 100, 'Synthetic hood film'), (3, 50, 'Synthetic rear tint')):
        cells = {'A': cell('2026-11-02', 'date'), 'B': cell(price), 'C': cell(text),
                 'G': cell(price / 2, formula=f'=B{number}*0.5', cached=price / 2)}
        if number == 3:
            cells['H'] = cell('#REF!', 'error', '=#REF!', '#REF!')
        rows.append({'id': f'row-{number}', 'source_row': number, 'section': 'ledger', 'position': number,
                     'cells': cells, 'original_cells': deepcopy(cells), 'version': 1, 'archived': False})
    total = {'B': cell(150, formula='=SUM(B2:B3)', cached=150), 'C': cell('Source formula totals')}
    rows.append({'id': 'row-5', 'source_row': 5, 'section': 'ledger_totals', 'position': 5,
                 'cells': total, 'original_cells': deepcopy(total), 'version': 1, 'archived': False})
    header = {'C': cell('Synthetic source header')}
    rows.append({'id': 'header-1', 'source_row': 1, 'section': 'source_headers', 'position': 1,
                 'cells': header, 'original_cells': deepcopy(header), 'version': 1, 'archived': False})
    sheets = []
    for month, name in ((10, 'October 2026'), (11, 'November 2026')):
        month_rows = deepcopy(rows)
        if month == 10:
            for row in month_rows:
                row['id'] = 'old-' + row['id']
        sheets.append({'id': f'sheet-{month}', 'import_id': 'workbook', 'name': name,
                       'metadata': {'source_period': {'year': 2026, 'month': month}, 'headers': headers,
                                    'sections': [{'id': 'source_headers', 'label': 'Source headers', 'addable': False},
                                                 {'id': 'ledger', 'label': 'Work entries', 'kind': 'entries'},
                                                 {'id': 'ledger_totals', 'label': 'Source totals', 'addable': False}],
                                    'warnings': ['Synthetic source calculation needs review.']},
                       'rows': month_rows})
    return {'ledger': {'imports': [{'id': 'workbook', 'name': 'Synthetic business workbook', 'revision': 1}],
                       'sheets': sheets}, **options}


def open_page(browser, base, data, viewport=None):
    context, page, errors, live = smoke.new_page(browser, data, viewport=viewport)
    page.goto(base + '/index.html#ledger')
    smoke.ready(page, data.get('profile', {}).get('name', 'Test Owner'))
    if data.get('profile', {}).get('role', 'admin') == 'admin':
        expect(page.locator('[data-ledger-row="row-2"]')).to_be_visible()
        expect(page.locator('.ledger-workspace')).to_have_attribute('aria-busy', 'false')
    return context, page, errors, live


def entry(page, row='row-2'):
    return page.locator(f'[data-ledger-row="{row}"]')


def expand(page, row='row-2'):
    record = entry(page, row)
    if record.get_attribute('open') is None:
        record.locator(':scope > summary').click()
    return record


def edit(page, row='row-2'):
    expand(page, row).get_by_role('button', name='Edit entry', exact=True).click()
    return page.locator('.ledger-form')


def save(page, reason='Synthetic correction'):
    page.get_by_label('Reason for this change', exact=True).fill(reason)
    page.locator('.ledger-form').get_by_role('button', name='Save changes', exact=True).click()


def stored(page, column='B', row='row-2'):
    return page.evaluate('([column,id]) => __garageLedgerState.sheets.find(s => s.id === "sheet-11").rows.find(r => r.id === id).cells[column]', [column, row])


def finished(context, errors, live):
    assert not errors, errors
    assert not live, live
    context.close()


def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    server, base = smoke.serve(args.directory)
    passed = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True)
        try:
            context, page, errors, live = open_page(browser, base, fixture())
            expect(page.get_by_label('Worksheet / period', exact=True)).to_have_value('sheet-11')
            expect(page.get_by_label('Section', exact=True)).to_have_value('ledger')
            assert '\nnull\n' not in page.locator('.ledger-workspace').inner_text()
            expect(entry(page, 'row-3')).to_contain_text('1 unavailable')
            record = expand(page)
            record.get_by_text('Original workbook values and formulas', exact=True).click()
            expect(record.locator('.ledger-source-detail')).to_contain_text('100')
            expect(record).to_contain_text('=B2*0.5')
            form = edit(page)
            form.locator('#ledger-field-B').fill('120')
            save(page)
            expect(page.locator('.ledger-form')).to_have_count(0)
            assert stored(page)['value'] == 120
            expect(expand(page).locator('.ledger-record-body > .ledger-values').first).to_contain_text('60')
            assert page.evaluate('__garageLedgerState.sheets[1].rows[0].original_cells.B.value') == 100
            form = edit(page, 'row-3')
            form.get_by_text('Saved calculations and manual overrides', exact=True).click()
            form.locator('#ledger-override-H').check()
            form.locator('#ledger-field-H').fill('7')
            save(page, 'Verified staff allocation')
            expect(page.locator('.ledger-form')).to_have_count(0)
            assert stored(page, 'H', 'row-3')['override'] is True
            assert stored(page, 'H', 'row-3')['formula'] == '=#REF!'
            expect(entry(page, 'row-3')).to_contain_text('1 overridden')
            page.get_by_label('Section', exact=True).select_option('source_headers')
            expect(expand(page, 'header-1').get_by_role('button', name='Edit entry', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='Add entry', exact=True)).to_be_disabled()
            page.get_by_label('Section', exact=True).select_option('ledger')
            passed.append('Latest period, primary section, formula calculation, source evidence and audited override')
            page.get_by_role('button', name='Add entry', exact=True).click()
            page.locator('#ledger-field-B').fill('30')
            page.locator('#ledger-field-C').fill('Synthetic manual row')
            page.get_by_label('Reason for this change', exact=True).fill('New synthetic entry')
            page.locator('.ledger-form').get_by_role('button', name='Add entry', exact=True).click()
            expect(page.locator('.ledger-form')).to_have_count(0)
            created = page.evaluate('__garageLedgerState.sheets[1].rows.find(r => r.source_row === null)')
            assert not any(c.get('formula') for c in created['cells'].values())
            page.get_by_text('Current section column totals', exact=True).click()
            expect(page.locator('.ledger-source-detail').filter(has=page.get_by_text('Current section column totals', exact=True))).to_contain_text('200')
            page.get_by_label('Section', exact=True).select_option('ledger_totals')
            expect(entry(page, 'row-5').locator('.ledger-row-amount')).to_have_text('170')
            expect(page.get_by_role('button', name='Add entry', exact=True)).to_be_disabled()
            page.get_by_label('Section', exact=True).select_option('ledger')
            expand(page, created['id']).get_by_role('button', name='History / archive', exact=True).click()
            page.get_by_label('Reason for archive or restore', exact=True).fill('Archive duplicate')
            page.get_by_role('button', name='Archive entry', exact=True).click()
            expect(entry(page, created['id'])).to_have_count(0)
            page.get_by_label('Records', exact=True).select_option('all')
            expand(page, created['id']).get_by_role('button', name='History and restore', exact=True).click()
            page.get_by_label('Reason for archive or restore', exact=True).fill('Recover manual entry')
            page.locator('.ledger-history li').filter(has_text='New synthetic entry').get_by_role('button', name='Restore this version', exact=True).click()
            expect(page.locator('.ledger-form')).to_have_count(0)
            expect(entry(page, created['id'])).not_to_contain_text('Archived')
            page.screenshot(path=str(args.output / 'ledger-desktop.png'), full_page=True)
            passed.append('Manual entries total independently of source SUM ranges; archive and history recovery')
            finished(context, errors, live)

            context, page, errors, live = open_page(browser, base, fixture(ledgerConflictOnce=True))
            edit(page).locator('#ledger-field-B').fill('135')
            save(page)
            expect(page.get_by_role('button', name='Use my entries with the latest revision', exact=True)).to_be_visible()
            expect(page.locator('#ledger-field-B')).to_have_value('135')
            page.get_by_role('button', name='Use my entries with the latest revision', exact=True).click()
            expect(page.locator('#ledger-field-C')).to_have_value('Changed by another Owner')
            save(page, 'Merged correction')
            expect(page.locator('.ledger-form')).to_have_count(0)
            assert stored(page)['value'] == 135 and stored(page, 'C')['value'] == 'Changed by another Owner'
            passed.append('Concurrent changes require explicit review and preserve both Owners’ fields')
            finished(context, errors, live)

            context, page, errors, live = open_page(browser, base, fixture(loseLedgerResponseOnce=True))
            edit(page).locator('#ledger-field-B').fill('140')
            save(page)
            expect(page.get_by_text('Change not confirmed', exact=True)).to_be_visible()
            expect(page.locator('#ledger-field-B')).to_have_value('140')
            save(page)
            expect(page.locator('.ledger-form')).to_have_count(0)
            calls = page.evaluate('__garageCalls.filter(c => c.name === "garage_ledger_save_row")')
            assert len(calls) == 2 and calls[0]['args']['p_request_id'] == calls[1]['args']['p_request_id']
            assert page.evaluate('__garageLedgerState.sheets[1].rows[0].version') == 2
            passed.append('Lost response retains request ID and retries without duplicating a mutation')
            finished(context, errors, live)

            context, page, errors, live = open_page(browser, base, fixture(ledgerFailRefreshAfterSave=True))
            edit(page).locator('#ledger-field-B').fill('145')
            save(page)
            expect(page.get_by_text('Your change was saved. Refresh the ledger to reload current calculations.', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Add entry', exact=True)).to_be_disabled()
            expect(expand(page).locator('.ledger-record-body > .ledger-values').first).to_contain_text('Unavailable')
            page.get_by_role('button', name='Refresh ledger', exact=True).click()
            expect(page.get_by_role('button', name='Add entry', exact=True)).to_be_enabled()
            expect(expand(page).locator('.ledger-record-body > .ledger-values').first).to_contain_text('72.5')
            passed.append('Confirmed save with failed refresh flags unavailable calculations and recovers')
            finished(context, errors, live)

            data = fixture(ledgerSheetError='sheet-10')
            data['ledger']['sheets'][1]['rows'][0]['cells']['B']['value'] = None
            context, page, errors, live = open_page(browser, base, data, {'width': 390, 'height': 844})
            expect(expand(page)).to_contain_text('Price is not supplied. A blank price remains unknown.')
            page.get_by_label('Worksheet / period', exact=True).select_option('sheet-10')
            expect(page.get_by_text('Ledger unavailable', exact=True)).to_be_visible()
            expect(page.get_by_label('Worksheet / period', exact=True)).to_have_value('sheet-11')
            expect(page.get_by_role('button', name='Add entry', exact=True)).to_be_enabled()
            edit(page)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile viewport overflow'
            page.screenshot(path=str(args.output / 'ledger-mobile.png'), full_page=True)
            passed.append('Blank price review, failed worksheet rollback and compact mobile editing')
            finished(context, errors, live)

            data = fixture()
            literal = cell('#REF!', 'error')
            data['ledger']['sheets'][1]['rows'][0]['cells']['H'] = deepcopy(literal)
            data['ledger']['sheets'][1]['rows'][0]['original_cells']['H'] = deepcopy(literal)
            context, page, errors, live = open_page(browser, base, data)
            edit(page).locator('#ledger-field-B').fill('160')
            save(page)
            expect(page.locator('.ledger-form')).to_have_count(0)
            assert stored(page, 'H') == literal
            edit(page).locator('#ledger-field-H').fill('9')
            save(page, 'Replace source error with verified amount')
            expect(page.locator('.ledger-form')).to_have_count(0)
            assert stored(page, 'H')['value'] == 9 and not stored(page, 'H').get('override')
            passed.append('Literal source errors survive unrelated edits and accept verified input replacements')
            finished(context, errors, live)

            for role in ('mechanic',):
                context, page, errors, live = open_page(browser, base, fixture(profile={'name': 'Test Mechanic', 'role': role}))
                expect(page.get_by_role('link', name='Business ledger', exact=True)).to_have_count(0)
                assert not page.evaluate('__garageCalls.some(c => c.name?.startsWith("garage_ledger_"))')
                assert 'Synthetic business workbook' not in page.locator('body').inner_text()
                finished(context, errors, live)
            context, page, errors, live = open_page(browser, base, fixture())
            page.get_by_role('button', name='Sign out', exact=True).click()
            expect(page.locator('.ledger-workspace')).to_have_count(0)
            assert 'Synthetic business workbook' not in page.locator('body').inner_text()
            passed.append('Owner-only navigation/RPC guard and private ledger cleared on sign-out')
            finished(context, errors, live)
        finally:
            browser.close()
            server.shutdown()
            server.server_close()
    result = {'passed': passed, 'count': len(passed), 'live_database_requests': 0}
    (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    run(parser.parse_args())
