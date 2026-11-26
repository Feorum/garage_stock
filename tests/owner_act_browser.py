"""Exercise the complete Word download and numbering controls with synthetic private records."""
import base64
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

from playwright.sync_api import expect


def exercise_owner_act(browser, base, smoke, make_order, make_task):
    with BytesIO() as buf:
        with ZipFile(buf, 'w') as doc:
            doc.write(Path(__file__).parent / 'fixtures' / 'act-template.xml', 'word/document.xml')
        raw = buf.getvalue()
    chunks = [base64.b64encode(raw[i:i + 60]).decode('ascii') for i in range(0, len(raw), 60)]
    tasks = [make_task('W19', 'completed', 1), make_task('W09', 'completed', 2), make_task('W01', 'cancelled', 3)]
    order = {**make_order(168, tasks=tasks), 'status': 'closed', 'vin': ''}
    second = {**make_order(169, 2, tasks=tasks), 'status': 'closed'}
    opened = make_order(170, 3)
    prices = [1251, 0]
    commercial = None
    listed = [48000, 32000]
    records, writes = {}, []
    seq = 0
    fail = 'template'

    def rpc(name, args):
        nonlocal fail, seq, commercial
        order_id = args.get('p_order_id')
        if name == 'garage_list_orders':
            value = [order, second, opened]
        elif name == 'garage_order_financials':
            value = {'status': 'priced', 'tasks': [
                {'task_id': t['id'], 'effective_kopeks': p, 'private_version': 0}
                for t, p in zip(tasks, prices)
            ]}
            if commercial is not None:
                value['commercial'] = commercial
                value['effective_total_kopeks'] = sum(prices)
                for row, amount in zip(value['tasks'], listed):
                    row['listed_kopeks'] = amount
        elif name == 'garage_save_commercial':
            assert args == {'p_order_id': second['id'], 'p_expected_version': 0,
                            'p_agreed_total_kopeks': 75000, 'p_basis': 'agreed'}
            commercial.update(agreed_total_kopeks=75000, basis='agreed', version=1,
                              basis_total_kopeks=75000, internal_total_kopeks=60000)
            prices[:] = [45000, 30000]
            value = 1
        elif name == 'garage_act_get':
            value = records.get(order_id, {
                'number': None, 'suggested_number': f'{seq + 1}/11' if seq else None,
                'customer_name': 'Тестовый заказчик', 'contractor_name': 'Тестовая мастерская',
                'contract_number': 'D-17', 'contract_date': '2026-11-01', 'act_date': '2026-11-22',
                'version': 0, 'vin': '' if order_id == order['id'] else second['vin'],
            })
        elif name == 'garage_act_template':
            if fail == 'template':
                fail = ''
                value = ['invalid!']
            else:
                value = chunks
        elif name == 'garage_act_save':
            writes.append(args.copy())
            current_order = order if order_id == order['id'] else second
            if fail == 'price':
                # Another Owner changed an agreed price after this file was generated.
                prices[0] = 1252
                fail = ''
            expected = {t['id']: p for t, p in zip(tasks, prices)}
            if commercial is not None:
                mode = args['p_expected_amounts']['mode']
                expected = {'mode': mode, 'quote': {'agreed_total_kopeks': 75000, 'allocated': expected,
                    'listed': {t['id']: p for t, p in zip(tasks, listed)}}}
            if (args['p_expected_amounts'] != expected or args['p_expected_order_version'] != current_order['version']):
                return {'error': {'code': '40001', 'message': 'Synthetic changed order or prices'}, 'data': None}
            if fail == 'number':
                seq += 1
                fail = ''
                return {'error': {'code': '23505', 'message': 'Synthetic duplicate'}, 'data': None}
            if order_id in records:
                assert records[order_id]['number'] == args['p_number']
            else:
                seq = int(args['p_number'].split('/')[0])
                value = {key[2:]: v for key, v in args.items() if key not in ('p_order_id', 'p_expected_version')}
                records[order_id] = {**value, 'suggested_number': None, 'version': 1,
                    'customer_name': 'Тестовый заказчик', 'contractor_name': 'Тестовая мастерская'}
            if commercial is not None:
                records[order_id].update(pricing_snapshot=expected['quote'], act_format=mode)
            value = records[order_id]
            if fail == 'receipt':
                fail = ''
                return {'error': {'message': 'Synthetic lost response'}, 'data': None}
        else:
            value = [] if name != 'garage_owner_gift_offer' else None
        return {'data': value, 'error': None}

    ctx, page, errors, requests = smoke.new_page(browser, {}, {'width': 320, 'height': 900})
    try:
        page.expose_function('__garageRpcFixture', rpc)
        button = page.get_by_role('button', name='Скачать акт (.docx)', exact=True)
        submit = page.get_by_role('button', name='Скачать Word', exact=True)
        number = page.get_by_label('Номер акта', exact=True)
        act_date = page.get_by_label('Дата акта', exact=True)
        def open_panel(row):
            page.goto(f'{base}/index.html#orders/{row["id"]}')
            button.click()
        def exported_text():
            with page.expect_download() as info:
                submit.click()
            assert info.value.suggested_filename.endswith('.docx')
            with ZipFile(info.value.path()) as doc:
                return ''.join(ET.fromstring(doc.read('word/document.xml')).itertext())

        page.goto(f'{base}/index.html#orders/{opened["id"]}')
        expect(page.get_by_role('heading', name=opened['vehicle'])).to_be_visible()
        expect(button).to_have_count(0)
        open_panel(order)
        expect(number).to_have_value('')
        number.fill('47')
        page.get_by_label('VIN для акта').fill('SYNTH000000000001')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        submit.click()
        expect(page.get_by_role('alert')).to_contain_text('Не удалось сформировать')
        assert not writes
        fail = 'price'
        submit.click()
        expect(page.get_by_role('alert')).to_contain_text('Проверьте обновлённые работы')
        expect(page.locator('.act-form')).to_contain_text('12,52')
        expect(number).to_have_value('47')
        expect(page.get_by_label('VIN для акта')).to_have_value('SYNTH000000000001')
        assert not records
        fail = 'receipt'
        submit.click()
        expect(page.get_by_role('alert')).to_contain_text('Сохранение реквизитов не подтверждено')
        first = exported_text()
        assert '47/11' in first and '12,52 BYN' in first and '0,00 BYN' in first
        assert tasks[0]['work_name'] in first and '15%' in first and tasks[2]['work_name'] not in first
        button.click()
        expect(number).to_have_value('47/11')
        expect(number).to_have_attribute('readonly', '')
        expect(page.get_by_label('VIN для акта')).to_have_value('SYNTH000000000001')
        act_date.fill('2026-12-01')
        expect(submit).to_be_disabled()
        act_date.fill('2026-11-22')
        assert exported_text() == first
        page.set_viewport_size({'width': 1440, 'height': 900})
        open_panel(second)
        expect(number).to_have_value('48')
        act_date.fill('2026-12-02')
        expect(page.locator('.act-serial')).to_contain_text('/12')
        fail = 'number'
        submit.click()
        expect(number).to_have_value('49')
        expect(act_date).to_have_value('2026-12-02')
        expect(page.get_by_role('alert')).to_contain_text('номер уже занят')
        assert '49/12' in exported_text()
        prices[1] = None
        page.reload()
        button.click()
        expect(page.get_by_role('alert')).to_contain_text(tasks[1]['work_name'])
        expect(submit).to_be_disabled()
        assert [w['p_number'] for w in writes] == ['47/11', '47/11', '47/11', '47/11', '48/12', '49/12']
        del records[second['id']]
        commercial = dict(agreed_total_kopeks=None, basis='catalogue', version=0, catalogue_total_kopeks=80000,
                          basis_total_kopeks=80000, internal_total_kopeks=64000)
        prices[:] = listed
        page.set_viewport_size({'width': 360, 'height': 900})
        page.reload()
        page.get_by_role('button', name='Изменить договорную сумму заказа').click()
        page.get_by_label('Договорная сумма за заказ, BYN').fill('750')
        page.get_by_label('От какой суммы считать 80%').select_option('agreed')
        page.get_by_role('button', name='Сохранить условия').click()
        expect(page.get_by_role('button', name='Изменить договорную сумму заказа')).to_contain_text('750,00')
        button.click()
        for mode, expected in [('weighted', ['450,00 BYN', '300,00 BYN']),
                               ('discount', ['480,00 BYN', '320,00 BYN', 'Скидка', '−50,00 BYN']),
                               ('names', [tasks[0]['work_name'], tasks[1]['work_name']])]:
            page.get_by_label('Отображение договорной суммы').select_option(mode)
            text = exported_text()
            assert all(item in text for item in expected) and '750 (семьсот пятьдесят)' in text
            if mode == 'names':
                assert 'BYN' not in text
            button.click()
        expect(page.get_by_label('Отображение договорной суммы')).to_have_value('names')
        assert not errors and not requests, (errors, requests)
    finally:
        ctx.close()
    ctx, page, errors, requests = smoke.new_page(browser, {'profile': {'name': 'Механик', 'role': 'mechanic'}})
    try:
        page.goto(f'{base}/index.html#orders/{order["id"]}')
        expect(page.get_by_role('navigation', name='Кабинет механика')).to_be_visible()
        expect(page.get_by_role('button', name='Скачать акт (.docx)')).to_have_count(0)
        assert not page.evaluate("(__garageCalls || []).some(c => c.name?.startsWith('garage_act_'))")
        assert not errors and not requests, (errors, requests)
    finally:
        ctx.close()
