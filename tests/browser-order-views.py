#!/usr/bin/env python3
"""Check the owner's saved order views with synthetic orders and a fake SDK."""
import argparse
import csv
import importlib.util
from pathlib import Path
import re

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('garage_orders', ROOT / 'tests/browser-orders.py')
garage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(garage)


def run(args):
    first = garage.order(2, tasks=[garage.task(2, 'W02')])
    first.update(vehicle='Автомобиль 2', vin='VF1AAAAAA00000002', planned_date='2026-11-25')
    first['tasks'][0]['participants'] = [{'mechanic_id': garage.ME,
        'name': 'Константин Александрович Тестовый', 'status': 'assigned'}]
    second = garage.order(10, tasks=[garage.task(10, 'W13')])
    second.update(vehicle='Автомобиль 10', vin='VF1AAAAAA00000010', planned_date='2026-11-23')
    last = garage.order(3)
    last.update(vehicle='Автомобиль 3', vin='')
    custom = {'id': second['id'], 'vehicle': 'Кастомная машина', 'visit_date': '2026-11-26', 'status': 'open'}
    server, base = garage.smoke.serve(args.directory)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        try:
            prices = [{'order_id': item['id'], 'tasks': [{'task_id': item['tasks'][0]['id'], 'net_kopeks': amount}]}
                      for item, amount in [(first, 100000), (second, 900), (last, 0)]]
            context, page, errors, live = garage.smoke.new_page(browser,
                {'orders': [first, second, last], 'customOrders': [custom], 'reviewPrices': prices})
            url = base + '/index.html#orders'
            page.goto(url)
            garage.smoke.ready(page, 'Test Owner')
            journal = page.get_by_role('region', name='Список заказов', exact=True)
            tabs = journal.get_by_role('navigation', name='Вкладки заказов')
            columns = journal.get_by_role('group', name='Сортировка по столбцам')
            rows = journal.locator('.od-body [data-order-id]')
            first_row = rows.filter(has_text='Автомобиль 2')
            expect(first_row).to_contain_text('VIN....0002')
            expect(first_row).not_to_contain_text(first['vin'])
            expect(first_row).not_to_contain_text(first['order_number'])
            expect(rows.filter(has_text='Кастомная машина').locator('.od-cell-vin .od-cell-value')).to_have_text('—')

            columns.get_by_role('button', name='По прайсу', exact=True).click()
            expect(rows.nth(0)).to_contain_text('Автомобиль 3')
            expect(rows.nth(1)).to_contain_text('Автомобиль 10')
            expect(rows.nth(2)).to_contain_text('Автомобиль 2')
            expect(rows.nth(3)).to_contain_text('Кастомная машина')
            columns.get_by_role('button', name='По прайсу', exact=True).click()
            expect(rows.nth(0)).to_contain_text('Автомобиль 2')
            expect(rows.nth(3)).to_contain_text('Кастомная машина')

            journal.get_by_role('button', name='Создать вкладку').click()
            title = journal.get_by_role('textbox', name='Название вкладки')
            title.fill('Приёмка')
            journal.get_by_role('button', name='Создать', exact=True).click()
            expect(tabs.get_by_role('link', name='Приёмка')).to_have_attribute('aria-current', 'page')
            view_url = page.url
            assert re.fullmatch(re.escape(url) + r'\?view=[a-f0-9-]+', view_url)

            journal.get_by_role('button', name='Столбцы', exact=True).click()
            panel = journal.locator('#od-column-settings')
            panel.get_by_role('checkbox', name='Показывать столбец «По прайсу»', exact=True).uncheck()
            panel.get_by_role('checkbox', name='Показывать столбец «Менеджер»', exact=True).check()
            panel.get_by_role('button', name='Автомобиль · переместить вверх').press('Enter')
            expect(columns.get_by_role('button').nth(0)).to_have_text('Автомобиль')
            expect(columns.get_by_role('button').nth(1)).to_have_text('VIN')
            expect(columns.get_by_role('button', name='По прайсу')).to_have_count(0)
            expect(columns.get_by_role('button', name='Менеджер')).to_be_visible()
            expect(first_row.locator('.od-cell-amount')).to_have_count(0)
            panel.get_by_role('button', name='Переименовать вкладку').click()
            title.fill('Приёмка и осмотр')
            journal.get_by_role('button', name='Сохранить', exact=True).click()
            expect(tabs.get_by_role('link', name='Приёмка и осмотр')).to_have_attribute('aria-current', 'page')
            expect(page).to_have_url(view_url)

            columns.get_by_role('button', name='VIN', exact=True).click()
            expect(rows.nth(0)).to_contain_text('VIN....0002')
            expect(rows.nth(1)).to_contain_text('VIN....0010')
            columns.get_by_role('button', name='VIN', exact=True).click()
            expect(rows.nth(0)).to_contain_text('VIN....0010')
            expect(rows.nth(1)).to_contain_text('VIN....0002')
            expect(rows.nth(3)).to_contain_text('Автомобиль 3')

            with page.expect_download() as event:
                journal.get_by_role('button', name='Экспорт', exact=True).click()
            with event.value.path().open(encoding='utf-8-sig', newline='') as contents:
                exported = list(csv.reader(contents, delimiter=';'))
            assert exported[0][:2] == ['Автомобиль', 'VIN'] and exported[0][-1] == 'Менеджер'
            assert 'По прайсу, BYN' not in exported[0] and exported[1][:2] == ['Автомобиль 10', 'VIN....0010']

            first_row.get_by_role('link').click()
            expect(page.get_by_role('dialog', name='Карточка заказа')).to_be_visible()
            page.keyboard.press('Escape')
            expect(page).to_have_url(view_url)
            page.reload()
            expect(columns.get_by_role('button', name='VIN', exact=True)).to_have_attribute('aria-description', 'По убыванию')
            expect(columns.get_by_role('button').nth(0)).to_have_text('Автомобиль')
            expect(rows.nth(0)).to_contain_text('VIN....0010')
            tabs.get_by_role('link', name='Основная').click()
            expect(columns.get_by_role('button', name='По прайсу', exact=True)).to_be_visible()
            tabs.get_by_role('link', name='Приёмка и осмотр').click()

            page.set_viewport_size({'width': 320, 'height': 840})
            expect(first_row.get_by_text('Константин Александрович Тестовый', exact=True)).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            journal.get_by_role('combobox', name='Столбец сортировки').select_option('vehicle')
            expect(rows.nth(0)).to_contain_text('Автомобиль 2')
            journal.get_by_role('button', name='Сортировать по убыванию').click()
            expect(rows.nth(0)).to_contain_text('Кастомная машина')
            journal.get_by_role('button', name='Столбцы', exact=True).click()
            panel.get_by_role('button', name='Удалить вкладку').click()
            journal.locator('.od-view-editor').get_by_role('button', name='Удалить вкладку').click()
            expect(page).to_have_url(url)
            expect(tabs.get_by_role('link', name='Приёмка и осмотр')).to_have_count(0)

            page.goto(url + '?week=2026-11-23&metric=works')
            works = page.get_by_role('region', name='Работы', exact=True)
            works.get_by_role('combobox', name='Столбец сортировки').select_option('name')
            work_rows = works.locator('[data-work-id]')
            expect(work_rows.nth(0)).to_contain_text('Бампер')
            works.get_by_role('button', name='Сортировать по убыванию').click()
            expect(work_rows.nth(0)).to_contain_text('Зеркала')
            garage.finish_context(context, errors, live)
        finally:
            browser.close()
            server.shutdown()
            server.server_close()
    print('Saved order views passed on desktop and mobile.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    run(parser.parse_args())
