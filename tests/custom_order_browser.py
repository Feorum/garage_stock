"""Owner creates a custom order, pays a named outside worker and reopens it after reload."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def exercise_custom_order(db, directory, chromium, owner):
    spec = spec_from_file_location('custom_order_smoke', Path(__file__).with_name('browser-smoke.py'))
    smoke = module_from_spec(spec)
    spec.loader.exec_module(smoke)
    server, base = smoke.serve(directory.resolve())
    vehicle = 'Тестовый автомобиль с индивидуальной работой'
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=chromium, args=['--no-sandbox'])
            try:
                context, page, errors, live = smoke.new_page(browser, {
                    'userId': owner, 'profile': {'id': owner, 'name': 'Test Owner', 'role': 'admin', 'active': True}
                })
                page.expose_function('__garageRpcFixture', lambda method, args: db.transport(owner, method, args))
                page.goto(base + '/index.html#orders')
                page.get_by_role('link', name='Новый заказ').click()
                kind = page.get_by_label('Тип заказа')
                expect(kind).to_have_value('standard')
                kind.select_option('custom')
                page.get_by_label('Автомобиль', exact=True).fill(vehicle)
                page.get_by_label('Работы', exact=True).fill('Произвольная работа')
                page.get_by_label('Сумма для клиента, BYN').fill('150,00')
                page.get_by_role('button', name='Добавить исполнителя').click()
                payments = page.get_by_role('group', name='Выплаты исполнителям')
                payments.get_by_label('Имя исполнителя 1').fill('Приглашённый мастер')
                payments.get_by_label('Сумма, BYN').fill('50')
                page.get_by_role('button', name='Добавить расход или распределение').click()
                expenses = page.get_by_role('group', name='Расходы и прочее распределение')
                expenses.get_by_label('Назначение', exact=False).fill('Плёнка')
                expenses.get_by_label('Сумма, BYN').fill('12,34')
                expect(page.get_by_text('Свободный остаток')).to_contain_text('87,66')
                page.get_by_role('button', name='Сохранить заказ').click()
                expect(page.get_by_role('heading', name='Кастомный заказ')).to_be_visible()
                page.reload()
                expect(payments.get_by_label('Имя исполнителя 1')).to_have_value('Приглашённый мастер')
                expect(expenses.get_by_label('Сумма, BYN')).to_have_value('12,34')
                assert not page.get_by_role('button', name='Скачать акт').count()
                assert not page.get_by_label('Назначить механика').count()
                page.get_by_label('Состояние').select_option('closed')
                page.get_by_role('button', name='Сохранить заказ').click()
                expect(page.get_by_text('Кастомный заказ сохранён.')).to_be_visible()
                page.get_by_role('link', name='К списку заказов').click()
                link = page.get_by_role('link', name=vehicle, exact=False)
                expect(link).to_contain_text('Закрыт')
                link.click()
                expect(page.get_by_label('Состояние')).to_have_value('closed')
                assert not errors and not live, (errors, live)
                context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
