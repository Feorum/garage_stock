"""Exercise a private two-person order, including a second write immediately after editing it."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from time import sleep

from playwright.sync_api import expect, sync_playwright


def exercise_owner_order(db, directory, chromium, owner, first, second):
    spec = spec_from_file_location('garage_owner_smoke', Path(__file__).with_name('browser-smoke.py'))
    smoke = module_from_spec(spec)
    spec.loader.exec_module(smoke)
    server, base = smoke.serve(directory.resolve())
    vehicle = 'Совместное частное назначение'
    # Keep read-after-write latency observable even on a fast local database.
    def transport(method, parameters):
        if method == 'garage_list_orders':
            sleep(0.15)
        return db.transport(owner, method, parameters)

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=chromium, args=['--no-sandbox'])
            try:
                context, page, errors, requests = smoke.new_page(browser, {
                    'userId': owner, 'profile': {'id': owner, 'name': 'Test Owner', 'role': 'admin', 'active': True}
                }, {'width': 390, 'height': 844})
                page.expose_function('__garageRpcFixture', transport)
                page.goto(base + '/index.html#orders')
                page.get_by_role('link', name='Управление заказами', exact=True).click()
                page.get_by_role('button', name='Новый заказ').click()
                page.get_by_role('combobox', name='Модель автомобиля', exact=True).select_option('manual')
                page.get_by_label('Автомобиль', exact=True).fill(vehicle)
                page.get_by_role('combobox', name='Группа автомобилей', exact=True).select_option('VG02')
                page.locator('#new-work-W01').check()
                for name in ['Андрей', 'Миша']:
                    page.get_by_role('checkbox', name=name, exact=True).check()
                page.get_by_role('button', name='Отправить заказ', exact=True).click()
                panel = page.get_by_role('region', name='Подробности заказа')
                expect(panel.get_by_role('heading', name=vehicle)).to_be_visible()
                panel.get_by_role('button', name='Изменить заказ', exact=True).click()
                rates = panel.get_by_role('region', name='Цены и выплаты', exact=True)
                for name in ['Андрей', 'Миша']:
                    expect(rates.get_by_text(name + ' · Назначено', exact=True)).to_be_visible()
                panel.get_by_text('Данные и состав работ', exact=True).click()
                page.get_by_label('Цвет (необязательно)', exact=True).fill('Белый')
                page.get_by_role('button', name='Сохранить изменения', exact=True).click()
                panel.get_by_role('button', name='Добавить пропущенную выполненную работу').click()
                page.get_by_role('combobox', name='Пропущенная работа из каталога', exact=True).select_option('W09')
                page.get_by_role('combobox', name='Исполнитель', exact=True).select_option(first)
                page.get_by_role('checkbox', name='Миша', exact=True).check()
                page.get_by_label('Дата и время выполнения').fill('2026-11-12T14:00')
                page.get_by_label('Причина исправления').fill('Проверка предыдущей смены')
                page.get_by_role('button', name='Записать выполненную работу').click()
                panel.get_by_role('button', name='Изменить заказ', exact=True).click()
                expect(rates.get_by_text('Выполнение записано владельцем')).to_be_visible()
                result = next(o for o in db.rpc(owner, 'garage_list_orders') if o['vehicle'] == vehicle)
                assert result['colour'] == 'Белый' and len(result['tasks']) == 2
                assert all({p['mechanic_id'] for p in t['participants']} == {first, second} for t in result['tasks'])
                omitted = next(t for t in result['tasks'] if t['work_code'] == 'W09')
                assert omitted['completed_at'].startswith('2026-11-12T11:00')
                assert all(p['confirmation_origin'] == 'owner_recorded' for p in omitted['participants'])
                assert not errors and not requests, (errors, requests)
                context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Passed private team creation, consecutive Owner edits, omission provenance and Minsk wall time.')
