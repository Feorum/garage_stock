#!/usr/bin/env python3
"""Verify widget editing and tab-specific owner preferences with synthetic orders."""

import argparse
import importlib.util
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('garage_browser_smoke', ROOT / 'tests/browser-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

ACTIVE = {
    'id': '00000000-0000-4000-8000-000000000001',
    'order_number': 'WIDGET-1', 'vehicle': 'Widget test order', 'status': 'published',
    'source': 'owner', 'planned_date': '2026-10-29', 'version': 1,
    'tasks': [{'id': '00000000-0000-4000-8000-000000000003', 'work_code': 'W02', 'work_name': 'Бампер',
               'status': 'pending', 'version': 1}],
}
CLOSED_CUSTOM = {
    'id': '00000000-0000-4000-8000-000000000002',
    'vehicle': 'Historic widget order', 'visit_date': '2024-05-04', 'status': 'closed',
}


def open_editor(page):
    button = page.get_by_role('button', name='Настроить виджеты', exact=True)
    button.click()
    dialog = page.get_by_role('dialog', name='Виджеты вкладки', exact=True)
    expect(dialog).to_be_visible()
    return button, dialog


def save_editor(dialog):
    dialog.get_by_role('button', name='Сохранить виджеты', exact=True).click()
    expect(dialog).to_have_count(0)


def expect_cards(region, titles):
    expect(region.locator('.dash-owner-widgets h3')).to_have_text(titles)


def widget_tests(browser, base):
    context, page, errors, live = smoke.new_page(
        browser, {'orders': [ACTIVE], 'customOrders': [CLOSED_CUSTOM]},
        {'width': 360, 'height': 800},
    )
    page.set_default_timeout(5000)
    page.goto(base + '/index.html#home?week=2026-10-26')
    smoke.ready(page, 'Test Owner')
    summary = page.get_by_role('region', name='Недельная сводка заказов', exact=True)
    expect_cards(summary, [
        'Активность', 'Выполнение работ', 'По прайсу', 'Заказы', 'В работе',
        'Работы', 'На проверке', 'Закрытые заказы',
    ])
    expect(summary.locator('.dash-day[href*="day=2026-10-29"]')).to_have_attribute(
        'href', '#orders?week=2026-10-26&metric=orders&day=2026-10-29',
    )
    trigger, dialog = open_editor(page)
    fields = dialog.locator('fieldset')
    fields.nth(0).get_by_label('Название', exact=True).fill('Первая активность')
    fields.nth(0).get_by_label('Данные', exact=True).select_option('works')
    dialog.get_by_role('button', name='Добавить виджет «График»').click()
    fields.last.get_by_label('Название', exact=True).fill('Вторая активность')
    dialog.get_by_role('button', name='Удалить виджет 8', exact=True).click()
    dialog.get_by_role('button', name='Переместить виджет 8 выше', exact=True).click()
    assert page.evaluate('new Set([...document.querySelectorAll("[id]")].map(el => el.id)).size === document.querySelectorAll("[id]").length')
    save_editor(dialog)
    expect(trigger).to_be_focused()
    titles = ['Первая активность', 'Выполнение работ', 'По прайсу', 'Заказы', 'В работе',
              'Работы', 'Вторая активность', 'На проверке']
    expect_cards(summary, titles)
    expect(summary.locator('.dash-activity').nth(0).get_by_role('button', name='Работы')).to_have_attribute('aria-pressed', 'true')
    expect(summary.locator('.dash-activity').nth(1).get_by_role('button', name='Заказы')).to_have_attribute('aria-pressed', 'true')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

    trigger, dialog = open_editor(page)
    dialog.locator('fieldset').first.get_by_label('Название', exact=True).fill('Черновик')
    page.keyboard.press('Escape')
    expect(dialog).to_have_count(0)
    expect(trigger).to_be_focused()
    page.reload()
    expect_cards(summary, titles)
    expect(summary.locator('.dash-activity').nth(0).get_by_role('button', name='Работы')).to_have_attribute('aria-pressed', 'true')

    page.evaluate("location.hash = '#orders'")
    all_orders = page.get_by_role('region', name='Сводка по всем заказам', exact=True)
    expect_cards(all_orders, ['Всего заказов', 'Активные заказы', 'На проверке', 'Закрытые заказы'])
    expect(all_orders.locator('.dash-metric-result strong')).to_have_text(['2', '1', '0', '1'])
    expect(all_orders.get_by_role('button', name='Текущая неделя')).to_have_count(0)
    _, dialog = open_editor(page)
    dialog.get_by_role('button', name='Добавить виджет «Прогресс»').click()
    fields = dialog.locator('fieldset')
    fields.last.get_by_label('Данные', exact=True).select_option('closed')
    fields.last.get_by_label('Название', exact=True).fill('Прогресс журнала')
    save_editor(dialog)
    expect(all_orders.get_by_text('Закрыто 1 из 2')).to_be_visible()

    page.get_by_role('button', name='Создать вкладку', exact=True).click()
    page.get_by_label('Название вкладки', exact=True).fill('Моя подборка')
    page.get_by_role('button', name='Создать', exact=True).click()
    expect(page.get_by_role('link', name='Моя подборка', exact=True)).to_have_attribute('aria-current', 'page')
    expect(all_orders).to_have_count(0)
    expect(summary).to_have_count(0)
    _, dialog = open_editor(page)
    dialog.get_by_role('button', name='Добавить виджет «Показатель»').click()
    dialog.get_by_label('Название', exact=True).fill('Только здесь')
    save_editor(dialog)
    expect_cards(summary, ['Только здесь'])
    page.reload()
    expect_cards(summary, ['Только здесь'])
    page.get_by_role('link', name='Основная', exact=True).click()
    expect_cards(all_orders, ['Всего заказов', 'Активные заказы', 'На проверке', 'Закрытые заказы', 'Прогресс журнала'])
    page.evaluate("location.hash = '#orders?week=2026-10-26&metric=works'")
    expect(page.get_by_role('button', name='Настроить виджеты', exact=True)).to_have_count(0)
    page.evaluate("location.hash = '#home?week=2026-10-26'")
    expect_cards(summary, titles)

    assert not errors, errors
    assert not live, live
    context.close()

    context, page, errors, live = smoke.new_page(browser, {'profile': {'name': 'Test Mechanic', 'role': 'mechanic'}})
    page.goto(base + '/index.html')
    smoke.ready(page, 'Test Mechanic')
    expect(page.get_by_role('button', name='Настроить виджеты', exact=True)).to_have_count(0)
    assert not page.evaluate('(__garageCalls || []).some(call => /owner_preference/.test(call.name))')
    assert not errors, errors
    assert not live, live
    context.close()


def reports_tests(browser, base):
    closed = {**ACTIVE, 'status': 'closed', 'closed_at': '2026-10-30T11:00:00Z',
              'tasks': [{**ACTIVE['tasks'][0], 'status': 'completed'}]}
    rates = [{'order_id': closed['id'], 'tasks': [{'task_id': closed['tasks'][0]['id'], 'net_kopeks': 12555}]}]
    context, page, errors, live = smoke.new_page(browser, {'orders': [closed], 'reviewPrices': rates})
    page.set_default_timeout(5000)
    page.goto(base + '/index.html#reports')
    smoke.ready(page, 'Test Owner')
    widgets = page.get_by_role('region', name='Виджеты отчёта', exact=True)
    monthly = widgets.get_by_role('region', name='Итог за месяц', exact=True)
    expect(monthly).to_be_visible()
    expect(widgets.get_by_label('Выбрать неделю по дате', exact=True)).to_have_count(0)
    monthly.get_by_label('Месяц отчёта').select_option('2026-10')
    expect(monthly.get_by_text('Закрыто заказов 1')).to_be_visible()
    expect(monthly.get_by_text('125,55 BYN')).to_be_visible()

    _, dialog = open_editor(page)
    dialog.get_by_label('Данные', exact=True).select_option('count')
    dialog.get_by_label('Название', exact=True).fill('Сводка закрытия')
    dialog.get_by_role('button', name='Добавить виджет «График»').click()
    dialog.get_by_role('button', name='Переместить виджет 1 ниже', exact=True).click()
    save_editor(dialog)
    expect(widgets.locator('.dash-owner-widgets > *').first).to_have_class('dash-activity')
    monthly = widgets.get_by_role('region', name='Сводка закрытия', exact=True)
    expect(monthly.get_by_label('Месяц отчёта')).to_have_value('2026-10')
    expect(monthly.get_by_text('Закрыто заказов 1')).to_be_visible()
    expect(monthly.get_by_text('По прайсу', exact=True)).to_have_count(0)
    expect(widgets.get_by_label('Выбрать неделю по дате', exact=True)).to_be_visible()

    page.reload()
    expect(widgets.locator('.dash-owner-widgets > *').first).to_have_class('dash-activity')
    expect(monthly.get_by_text('По прайсу', exact=True)).to_have_count(0)
    _, dialog = open_editor(page)
    dialog.get_by_role('button', name='Удалить виджет 2', exact=True).click()
    dialog.get_by_role('button', name='Удалить виджет 1', exact=True).click()
    save_editor(dialog)
    expect(widgets).to_have_count(0)
    expect(page.get_by_role('heading', name='История заказов', exact=True)).to_be_visible()
    expect(page.get_by_role('heading', name=closed['vehicle'], exact=True)).to_be_visible()

    _, dialog = open_editor(page)
    dialog.get_by_role('button', name='Добавить виджет «Итог за месяц»').click()
    dialog.get_by_label('Данные', exact=True).select_option('amount')
    save_editor(dialog)
    monthly = widgets.get_by_role('region', name='Итог за месяц', exact=True)
    monthly.get_by_label('Месяц отчёта').select_option('2026-10')
    expect(monthly.get_by_text('Закрыто заказов', exact=False)).to_have_count(0)
    expect(monthly.get_by_text('125,55 BYN')).to_be_visible()
    expect(widgets.get_by_label('Выбрать неделю по дате', exact=True)).to_have_count(0)

    page.evaluate("location.hash = '#home'")
    _, dialog = open_editor(page)
    expect(dialog.get_by_role('button', name='Добавить виджет «Итог за месяц»')).to_have_count(0)
    page.keyboard.press('Escape')
    assert not errors, errors
    assert not live, live
    context.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--chromium')
    args = parser.parse_args()
    server, base = smoke.serve(args.directory.resolve())
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium, args=['--no-sandbox'])
            try:
                widget_tests(browser, base)
                reports_tests(browser, base)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Owner widget layout, metrics, tab persistence and mechanic isolation verified.')
