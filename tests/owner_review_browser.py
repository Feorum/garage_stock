"""Exercise the Owner's review decisions, agreed job prices and catalogue history."""
import re

from playwright.sync_api import expect
from order_browser_helpers import check_decision_buttons


def exercise_owner_review(browser, base, smoke, output):
    first, second = (
        {'mechanic_id': '80000000-0000-4000-8000-000000000001', 'name': 'Исполнитель А', 'color': '#AF2943', 'status': 'confirmed'},
        {'mechanic_id': '80000000-0000-4000-8000-000000000002', 'name': 'Исполнитель Б', 'color': '#285A9A', 'status': 'confirmed'},
    )
    visits, prices = [], []

    def visit(code, state, services, closed_at=None, *, planned_date=None, colour=None, note=None, due_date=None):
        number = len(visits) + 1
        order_id = f'80000000-0000-4000-8001-{number:012d}'
        work = []
        money = []
        for index, (label, status, catalogue, agreed, participants) in enumerate(services, 1):
            task_id = f'80000000-0000-4000-8002-{number * 10 + index:012d}'
            work.append({'id': task_id, 'work_code': f'W{index:02}', 'work_name': label, 'status': status,
                         'participants': participants, 'version': 1})
            money.append({'task_id': task_id, 'net_kopeks': catalogue, 'effective_kopeks': agreed})
        visits.append({'id': order_id, 'vehicle': code, 'order_number': f'T-{number}', 'source': 'manager', 'version': 1,
                       'status': state if state in ('closed', 'cancelled') else 'published',
                       'vehicle_group_code': 'VG02', 'created_at': '2026-10-20T08:30:00Z', 'closed_at': closed_at, 'tasks': work,
                       'planned_date': planned_date, 'due_date': due_date, 'colour': colour,
                       'vehicle_workflow': {'state': state, 'origin': 'inline', 'handed_by': first['mechanic_id'],
                                            'handoff_note': note,
                                            'handed_at': '2026-11-03T09:00:00Z' if state == 'review' else None}})
        prices.append({'order_id': order_id, 'created_at': '2026-10-20T08:30:00Z', 'closed_at': closed_at, 'tasks': money})
        return order_id

    def item(label, price, participants=(first,), state='completed', *, agreed=None):
        return label, state, price, price if agreed is None else agreed, list(participants)

    assigned = {'mechanic_id': '80000000-0000-4000-8000-000000000003', 'name': 'Исполнитель В', 'status': 'assigned'}
    handoff_note = 'Осмотреть капот утром.\nКлючи в шкафу.'
    ready = visit('Geely Atlas', 'review', [item('Капот', 23145, [first, second, assigned], agreed=17890), item('Зеркала', 455),
                                           item('Отменённый бампер', 99999, [], 'cancelled')],
                  planned_date='2026-10-30', colour='Графитовый', note=handoff_note)
    missing = visit('Geely Emgrand', 'review', [item('Пороги', 3000), item('Кромки', None)], due_date='2026-10-29')
    zero = visit('Geely Coolray', 'review', [item('Защита', 5400, agreed=0)], planned_date='2026-10-28')
    unavailable = visit('Geely Galaxy', 'review', [item('Лобовое стекло', None)])
    prices.pop()  # Simulate an operational record absent from a partial pricing response.
    partial = visit('Belgee X50', 'review', [item('Двери', 1000), item('Бампер', None, [], 'pending')], planned_date='2026-11-02')
    active = visit('Geely Okavango', 'active', [item('Фары', 1250)])
    cancelled = visit('Geely Tugella', 'cancelled', [item('Багажник', None, [], 'cancelled')], planned_date='2026-10-20')
    # Minsk midnight falls at 21:00 UTC. Two orders closed on November 1.
    current = visit('Geely Monjaro', 'closed', [item('Капот', 30000, [first, second], agreed=28000), item('Фары', 1000)],
                     '2026-10-31T21:00:00Z', planned_date='2026-10-18')
    visits[-1]['tasks'][0]['completed_at'] = '2026-10-31T18:30:00Z'
    visits[-1]['tasks'][1]['completed_at'] = '2026-10-31T20:00:00Z'
    previous = visit('Belgee X70', 'closed', [item('Крылья', 48000), item('Сохранённая работа', 2013, [], 'pending')],
                     '2026-10-31T20:59:59Z', planned_date='2026-10-16')
    later = visit('Geely Cityray', 'closed', [item('Двери', 2500)], '2026-11-01T00:01:00+02:00', planned_date='2026-10-17')
    intake_id = '80000000-0000-4000-8003-000000000001'
    raw = {'vehicle': 'S50', 'vin': 'TEST0000000000009', 'manager_label': 'Мария', 'notes': 'Проверить способ оклейки'}
    intake = {'id': intake_id, 'version': 1, 'status': 'pending', 'row_numbers': [42], 'source_name': 'Таблица заявок',
              'original': raw, 'latest': raw, 'suggested_order': {**raw, 'vehicle_group_code': 'VG02'},
              'issues': ['NO_APPROVED_TASKS']}
    fixture = {'orders': visits, 'reviewPrices': prices, 'managerIntakes': [
        intake,
        {**intake, 'id': '80000000-0000-4000-8003-000000000002', 'order_id': ready},
        {**intake, 'id': '80000000-0000-4000-8003-000000000003', 'status': 'source_completed'},
    ]}
    labels = ('Главная', 'На проверке', 'Все заказы', 'Отчёты и история', 'Механики')

    def order_link(page, order_id):
        return page.locator(f'main a[href="#orders/{order_id}"]')

    def order_card(page, order_id):
        return page.locator(f'article[data-order-id="{order_id}"]')

    def intake_link(page):
        return page.get_by_role('region', name='Заявки менеджеров').get_by_role('link', name=re.compile('S50.*Проверить заявку'))

    for width in (320, 1440):
        setup = {**fixture, 'rpcErrors': {'garage_manager_intakes': 'Intake temporarily unavailable'}} if width == 320 else fixture
        context, page, errors, requests = smoke.new_page(browser, setup, {'width': width, 'height': 900})
        try:
            page.clock.set_fixed_time('2026-11-18T12:00:00Z')
            page.goto(base + '/index.html#shift')
            nav = page.get_by_role('navigation', name='Кабинет владельца')
            expect(nav.get_by_role('link')).to_have_count(len(labels))
            for label in labels:
                link = nav.get_by_role('link', name=label, exact=True)
                expect(link).to_be_in_viewport(ratio=1)
                bounds = link.bounding_box()
                assert min(bounds['height'], bounds['width']) >= 44, bounds
            expect(nav.get_by_role('link', name='На проверке', exact=True)).to_have_attribute('aria-current', 'page')
            expect(page.get_by_role('heading', name='На проверке', exact=True)).to_be_visible()
            attention = page.get_by_role('region', name='Требует внимания')
            expect(attention.get_by_role('region', name='Передачи механиков')).to_be_visible()
            for order_id in (ready, missing, zero, unavailable, partial):
                expect(order_link(page, order_id)).to_be_visible()
            for order_id in (active, current, previous, later, cancelled):
                expect(order_link(page, order_id)).to_have_count(0)
            if width == 320:
                expect(attention.get_by_role('alert')).to_contain_text('Не удалось загрузить заявки менеджеров.')
                page.evaluate('delete __garageTest.rpcErrors.garage_manager_intakes')
                attention.get_by_role('button', name='Повторить загрузку заявок').click()
            expect(intake_link(page)).to_have_count(1)
            expect(intake_link(page)).to_have_attribute('href', f'#orders/intake-{intake_id}/review')
            card = order_card(page, ready)
            def job(card, name):
                return card.get_by_role('listitem').filter(has_text=re.compile('^' + re.escape(name)))

            expect(job(card, 'Капот')).to_contain_text(re.compile(r'178,90\s*BYN'))
            expect(job(card, 'Капот')).to_contain_text('Исполнитель А')
            expect(job(card, 'Капот')).to_contain_text('Исполнитель Б')
            expect(job(card, 'Зеркала')).not_to_contain_text('Исполнитель Б')
            expect(job(card, 'Зеркала')).to_contain_text(re.compile(r'4,55\s*BYN'))
            expect(card).not_to_contain_text(re.compile(r'231,45|Отменённый бампер|Исполнитель В|НДС|VAT|T-1'))
            expect(card).to_contain_text('Графитовый')
            expect(card.locator('time')).to_have_attribute('datetime', '2026-10-30')
            expect(card).to_have_class(re.compile(r'\border-weekday-5\b'))
            assert page.locator('.owner-review-card').evaluate_all("cards => cards.map(card => card.dataset.orderId)") == [
                zero, missing, ready, partial, unavailable,
            ]
            assert card.locator('.owner-review-note p').inner_text() == handoff_note
            jobs_end = card.get_by_role('list').bounding_box()
            note_box = card.locator('.owner-review-note').bounding_box()
            assert jobs_end['y'] + jobs_end['height'] <= note_box['y']
            expect(order_card(page, missing).locator('.owner-review-meta')).to_contain_text('Срок')
            expect(order_card(page, unavailable)).to_contain_text('Дата записи не указана')
            expect(job(order_card(page, missing), 'Пороги')).to_contain_text(re.compile(r'30,00\s*BYN'))
            expect(job(order_card(page, missing), 'Кромки')).to_contain_text('Цена не указана')
            expect(job(order_card(page, zero), 'Защита')).to_contain_text(re.compile(r'0,00\s*BYN'))
            expect(job(order_card(page, unavailable), 'Лобовое стекло')).to_contain_text('Цена недоступна')
            unfinished = order_card(page, partial)
            expect(job(unfinished, 'Бампер')).to_have_count(0)
            expect(unfinished).to_contain_text('Осталось работ · 1')
            expect(unfinished.get_by_role('button', name='Подтвердить', exact=True)).to_have_count(0)
            confirm = card.get_by_role('button', name='Подтвердить', exact=True)
            check_decision_buttons(page, card.get_by_role('button', name='На доработку', exact=True), confirm)
            confirm.focus()
            note_box = card.locator('.owner-review-note').bounding_box()
            assert note_box['y'] + note_box['height'] <= confirm.bounding_box()['y']
            batches = page.evaluate("__garageCalls.filter(c => c.name === 'garage_owner_review_prices').map(c => c.args.p_order_ids)")
            assert set().union(*map(set, batches)) == {ready, missing, zero, unavailable, partial, active, current, previous, later}, batches
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=output / f'owner-review-{width}.png')
            order_link(page, ready).click()
            expect(page).to_have_url(base + '/index.html#orders/' + ready)
            expect(page.get_by_role('region', name='Подробности заказа')).to_contain_text('Geely Atlas')
            drawer = page.get_by_role('dialog', name='Карточка заказа')
            expect(drawer).to_be_visible()
            page.keyboard.press('Escape')
            expect(drawer).to_have_count(0)
            page.evaluate("location.hash = '#shift?week=2026-10-26'")
            for order_id in (ready, missing, zero):
                expect(order_link(page, order_id)).to_be_visible()
            for order_id in (unavailable, partial):
                expect(order_link(page, order_id)).to_have_count(0)
            expect(attention.get_by_role('region', name='Заявки менеджеров')).to_have_count(0)
            attention.get_by_role('link', name='За все даты').click()
            expect(order_link(page, unavailable)).to_be_visible()
            expect(intake_link(page)).to_be_visible()
            nav.get_by_role('link', name='Главная', exact=True).click()
            expect(page.get_by_role('heading', level=1, name='Главная')).to_be_visible()
            weekly = page.get_by_role('region', name='Недельная сводка заказов')
            expect(weekly).to_be_visible()
            weekly.get_by_label('Выбрать неделю по дате').fill('2026-10-30')
            schedule = page.get_by_role('region', name='Расписание заказов', exact=True)
            for order_id in (zero, missing, ready):
                expect(schedule.locator(f'a[href="#orders/{order_id}"]')).to_be_visible()
            expect(schedule.locator(f'a[href="#orders/{partial}"]')).to_have_count(0)
            schedule.get_by_role('link', name='К журналу заказов').click()
            expect(weekly).to_have_count(0)
            expect(page).to_have_url(re.compile(r'#orders\?week=2026-10-26'))
            for order_id in (ready, missing, zero):
                expect(order_link(page, order_id)).to_be_visible()
            for order_id in (unavailable, partial):
                expect(order_link(page, order_id)).to_have_count(0)
            expect(page.get_by_role('region', name='Заявки менеджеров')).to_have_count(0)
            nav.get_by_role('link', name='Все заказы', exact=True).click()
            expect(intake_link(page)).to_be_visible()
            intake_link(page).click()
            expect(page).to_have_url(base + f'/index.html#orders/intake-{intake_id}/review')
            form = drawer.get_by_role('form', name='Проверка заявки менеджера')
            expect(form.get_by_label('VIN', exact=True)).to_have_value(raw['vin'])
            expect(form.get_by_label('Менеджер', exact=True)).to_have_value(raw['manager_label'])
            expect(drawer).to_contain_text('Выберите запрошенные менеджером работы из каталога.')
            form.get_by_text('Исходная заявка менеджера · только владельцу', exact=True).click()
            expect(form.get_by_text(raw['notes'], exact=True)).to_be_visible()
            assert page.evaluate("__garageCalls.every(call => call.name !== 'garage_save_team_order')")
            form.get_by_role('button', name='Закрыть форму').click()
            expect(drawer).to_have_count(0)
            expect(intake_link(page)).to_be_focused()
            for order_id in (ready, missing, zero, unavailable, partial, active):
                expect(order_link(page, order_id)).to_be_visible()
            order_ids = '(cards) => cards.map(card => card.dataset.orderId)'
            assert page.locator('.owner-board > .owner-board-list > article').evaluate_all(order_ids) == [zero, missing, ready, partial, unavailable, active]
            expect(order_card(page, partial)).to_contain_text('В работе')
            expect(order_card(page, ready)).to_contain_text('Выполнен')
            expect(order_card(page, ready)).to_contain_text('Графитовый')
            expect(order_card(page, ready)).to_contain_text('Менеджер')
            expect(order_card(page, ready).locator('time')).to_have_attribute('datetime', '2026-10-30')
            expect(order_card(page, active)).to_contain_text('Дата не назначена')
            archive = page.locator('.owner-archive')
            for order_id in (current, previous, later, cancelled):
                expect(order_link(page, order_id)).to_be_hidden()
            archive.locator('summary').click()
            expect(archive).to_have_attribute('open', '')
            for order_id in (current, previous, later, cancelled):
                expect(order_link(page, order_id)).to_be_visible()
            assert archive.locator('article').evaluate_all(order_ids) == [previous, later, current, cancelled]
            expect(order_card(page, current)).to_contain_text('Закрыт')
            expect(order_card(page, cancelled)).to_contain_text('Отменён')
            expect(order_card(page, ready)).to_have_class(re.compile(r'\border-weekday-5\b'))
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=output / f'owner-archive-{width}.png', full_page=True)
            expect(page.get_by_role('link', name='Управление заказами')).to_have_count(0)
            status = page.get_by_role('combobox', name='Статус заказа')
            status.select_option(label='На проверке')
            expect(order_link(page, active)).to_have_count(0)
            expect(order_link(page, ready)).to_be_visible()
            status.select_option(label='Все статусы')
            search = page.get_by_role('searchbox', name='Поиск заказов')
            search.fill('Belgee X50')
            expect(order_link(page, ready)).to_have_count(0)
            order_link(page, partial).click()
            expect(drawer).to_contain_text('Belgee X50')
            private_note = drawer.get_by_role('region', name='Комментарий к заказу')
            private_note.get_by_role('textbox').fill('Забрать ключи утром')
            private_note.get_by_role('button', name='Сохранить комментарий').click()
            expect(private_note.get_by_role('status')).to_have_text('Комментарий сохранён.')
            expect(page).to_have_url(base + '/index.html#orders/' + partial)
            page.keyboard.press('Escape')
            expect(drawer).to_have_count(0)
            expect(page).to_have_url(base + '/index.html#orders')
            expect(search).to_have_value('Belgee X50')
            expect(order_link(page, partial)).to_be_focused()
            order_link(page, partial).press('Enter')
            expect(private_note.get_by_role('textbox')).to_have_value('Забрать ключи утром')
            drawer.get_by_role('button', name='Закрыть карточку заказа').click()
            expect(drawer).to_have_count(0)
            nav.get_by_role('link', name='Отчёты и история', exact=True).click()
            expect(nav.get_by_role('link', name='Отчёты и история', exact=True)).to_have_attribute('aria-current', 'page')
            expect(page.get_by_role('heading', name='Отчёты и история', exact=True)).to_be_visible()
            expect(order_card(page, previous).locator('time')).to_have_attribute('datetime', '2026-10-31')
            assert page.locator('.owner-board > .owner-board-list > article').evaluate_all(order_ids) == [later, current, previous]
            expect(order_card(page, current).locator('.owner-board-services li > span:first-child')).to_have_text(['Фары', 'Капот'])
            summary = page.get_by_role('region', name='Итог за месяц')
            expect(summary).to_contain_text(re.compile(r'335,00\s*BYN'))
            month = page.get_by_label('Месяц отчёта')
            month.select_option('2026-10')
            expect(summary).to_contain_text(re.compile(r'500,13\s*BYN'))
            expect(order_link(page, current)).to_be_visible()
            order_link(page, current).click()
            expect(page.get_by_role('region', name='Подробности заказа')).to_contain_text('Geely Monjaro')

            page.keyboard.press('Escape')
            expect(drawer).to_have_count(0)
            nav.get_by_role('link', name='На проверке', exact=True).click()
            note = 'Перепроверить кромку перед выдачей'
            return_button = unfinished.get_by_role('button', name='На доработку', exact=True)
            return_button.click()
            unfinished.get_by_role('button', name='Отмена', exact=True).click()
            assert not decision_calls(page, partial)
            return_button.click()
            comment = unfinished.get_by_label('Комментарий механику (необязательно)', exact=True)
            comment.fill(note)
            send = unfinished.get_by_role('button', name='Вернуть в работу', exact=True)
            check_decision_buttons(page, unfinished.get_by_role('button', name='Отмена', exact=True), send)
            send.focus()
            unfinished.screenshot(path=output / f'owner-return-{width}.png')
            if width == 320:
                # Another session updated the work while the Owner was writing. Refresh the board in place.
                page.evaluate("""id => {
                    __garageOrderState.orders.find(o => o.id === id).version++;
                    window.dispatchEvent(new Event('focus'));
                }""", partial)
                accept_changes = unfinished.get_by_role('button', name='Использовать актуальную версию', exact=True)
                expect(accept_changes).to_be_visible()
                expect(comment).to_have_value(note)
                expect(send).to_be_disabled()
                assert not decision_calls(page, partial)
                accept_changes.click()
            send.click()
            expect(unfinished).to_have_count(0)
            writes = decision_calls(page, partial)
            assert len(writes) == 1 and writes[0]['p_action'] == 'return' and writes[0]['p_note'] == note, writes
            assert writes[0]['p_expected_version'] == (2 if width == 320 else 1)
            returned = page.evaluate("id => __garageOrderState.orders.find(o => o.id === id)", partial)
            assert returned['vehicle_workflow']['state'] == 'available' and returned['vehicle_workflow']['return_note'] == note
            assert [t['status'] for t in returned['tasks']] == ['completed', 'pending']

            # Simulate losing the connection before the server received the first confirmation.
            page.evaluate("""() => {
                __garageTest.rpcErrors = { garage_vehicle_action: {times: 1, message:'Network timeout', code:'NETWORK'} };
            }""")
            card.get_by_role('button', name='Подтвердить', exact=True).click()
            card.get_by_role('button', name='Проверить отправку', exact=True).click()
            expect(card).to_have_count(0)
            confirmations = decision_calls(page, ready)
            assert len(confirmations) == 2 and confirmations[0] == confirmations[1], confirmations
            assert confirmations[0]['p_action'] == 'close' and confirmations[0]['p_request_id']
            assert page.evaluate("id => __garageOrderState.orders.find(o => o.id === id).status", ready) == 'closed'
            if width == 1440:
                intake_link(page).click()
                form.get_by_label('Плановая дата', exact=True).fill('2026-10-30')
                form.locator('#new-work-W01').check()
                form.get_by_role('button', name='Опубликовать заказ').click()
                expect(form).to_have_count(0)
                expect(drawer.get_by_role('heading', name='BELGEE S50', exact=True)).to_be_visible()
                page.keyboard.press('Escape')
                expect(attention.get_by_text('Нет заявок на проверке.')).to_be_visible()
                page.evaluate("hash => { location.hash = hash }", f'#orders/intake-{intake_id}/review')
                expect(drawer).to_contain_text('Заявка уже обработана или недоступна.')
                expect(form).to_have_count(0)
            assert not errors and not requests, (errors, requests)
        finally:
            context.close()


def decision_calls(page, order_id):
    return page.evaluate("""id => __garageCalls.filter(c => c.name === 'garage_vehicle_action'
                            && c.args.p_order_id === id).map(c => c.args)""", order_id)
