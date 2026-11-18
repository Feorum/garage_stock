"""Exercise the Owner's three tabs, frozen net prices and closed history."""
import re

from playwright.sync_api import expect


def exercise_owner_review(browser, base, smoke, output):
    first, second = (
        {'mechanic_id': '80000000-0000-4000-8000-000000000001', 'name': 'Исполнитель А', 'color': '#AF2943', 'status': 'confirmed'},
        {'mechanic_id': '80000000-0000-4000-8000-000000000002', 'name': 'Исполнитель Б', 'color': '#285A9A', 'status': 'confirmed'},
    )
    visits, prices = [], []

    def visit(code, state, services, closed_at=None):
        number = len(visits) + 1
        order_id = f'80000000-0000-4000-8001-{number:012d}'
        work = []
        money = []
        for index, (label, status, amount, participants) in enumerate(services, 1):
            task_id = f'80000000-0000-4000-8002-{number * 10 + index:012d}'
            work.append({'id': task_id, 'work_code': f'W{index:02}', 'work_name': label, 'status': status,
                         'participants': participants, 'version': 1})
            money.append({'task_id': task_id, 'net_kopeks': amount})
        visits.append({'id': order_id, 'vehicle': code, 'order_number': f'T-{number}', 'source': 'manager', 'version': 1,
                       'status': state if state in ('closed', 'cancelled') else 'published',
                       'vehicle_group_code': 'VG02', 'created_at': '2026-10-20T08:30:00Z', 'closed_at': closed_at, 'tasks': work,
                       'vehicle_workflow': {'state': state, 'handed_at': '2026-11-03T09:00:00Z' if state == 'review' else None}})
        prices.append({'order_id': order_id, 'created_at': '2026-10-20T08:30:00Z', 'closed_at': closed_at, 'tasks': money})
        return order_id

    def item(label, price, participants=(first,), state='completed'):
        return label, state, price, list(participants)

    ready = visit('Geely Atlas', 'review', [item('Капот', 23145, [first, second]), item('Зеркала', 455),
                                           item('Отменённый бампер', 99999, [], 'cancelled')])
    missing = visit('Geely Emgrand', 'review', [item('Пороги', 3000), item('Кромки', None)])
    zero = visit('Geely Coolray', 'review', [item('Защита', 0)])
    unavailable = visit('Geely Galaxy', 'review', [item('Лобовое стекло', None)])
    prices.pop()  # Simulate an operational record absent from a partial pricing response.
    partial = visit('Belgee X50', 'review', [item('Двери', 1000), item('Бампер', None, [], 'pending')])
    active = visit('Geely Okavango', 'active', [item('Фары', 1250)])
    cancelled = visit('Geely Tugella', 'cancelled', [item('Багажник', None, [], 'cancelled')])
    # Minsk midnight falls at 21:00 UTC. Only Monjaro closed in November.
    current = visit('Geely Monjaro', 'closed', [item('Капот', 31000, [first, second])], '2026-10-31T21:00:00Z')
    previous = visit('Belgee X70', 'closed', [item('Крылья', 48000), item('Сохранённая работа', 2013, [], 'pending')],
                     '2026-10-31T20:59:59Z')
    fixture = {'orders': visits, 'reviewPrices': prices}
    labels = ('На проверке', 'Все заказы', 'Отчёты и история')

    def order_link(page, order_id):
        return page.locator(f'main a[href="#orders/{order_id}"]')

    def order_card(page, order_id):
        return page.locator(f'article[data-order-id="{order_id}"]')

    for width in (320, 1440):
        context, page, errors, requests = smoke.new_page(browser, fixture, {'width': width, 'height': 900})
        try:
            page.clock.set_fixed_time('2026-11-18T12:00:00Z')
            page.goto(base + '/index.html')
            nav = page.get_by_role('navigation', name='Кабинет владельца')
            expect(nav.get_by_role('link')).to_have_count(3)
            for label in labels:
                link = nav.get_by_role('link', name=label, exact=True)
                expect(link).to_be_in_viewport(ratio=1)
                bounds = link.bounding_box()
                assert min(bounds['height'], bounds['width']) >= 44, bounds
            expect(nav.get_by_role('link', name=labels[0])).to_have_attribute('aria-current', 'page')
            expect(page.get_by_role('heading', name=labels[0], exact=True)).to_be_visible()
            for order_id in (ready, missing, zero, unavailable):
                expect(order_link(page, order_id)).to_be_visible()
            for order_id in (partial, active, current, previous, cancelled):
                expect(order_link(page, order_id)).to_have_count(0)
            card = order_card(page, ready)
            expect(card).to_contain_text(re.compile(r'236,00\s*BYN'))
            expect(card).not_to_contain_text('Отменённый бампер')
            expect(card.get_by_text('Исполнитель А', exact=True)).to_have_count(2)
            expect(card.get_by_text('Исполнитель Б', exact=True)).to_have_count(1)
            expect(card).not_to_contain_text(re.compile(r'Выполнили|Выполнено'))
            assert card.get_by_text('Исполнитель Б', exact=True).evaluate(
                "el => getComputedStyle(el).getPropertyValue('--executor-color').trim().toLowerCase()"
            ) == second['color'].lower()
            expect(order_card(page, missing)).to_contain_text('Ставка не указана')
            expect(order_card(page, missing)).not_to_contain_text(re.compile(r'\d,\d\d\s*BYN'))
            expect(order_card(page, zero)).to_contain_text(re.compile(r'0,00\s*BYN'))
            expect(order_card(page, unavailable)).to_contain_text('Стоимость недоступна')
            batches = page.evaluate("__garageCalls.filter(c => c.name === 'garage_owner_review_prices').map(c => c.args.p_order_ids)")
            assert set().union(*map(set, batches)) == {ready, missing, zero, unavailable}, batches
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=output / f'owner-review-{width}.png')
            order_link(page, ready).click()
            expect(page).to_have_url(base + '/index.html#orders/' + ready)
            expect(page.get_by_role('region', name='Подробности заказа')).to_contain_text('Geely Atlas')
            nav.get_by_role('link', name=labels[1]).click()
            for order_id in (ready, missing, zero, unavailable, partial, active, current, previous, cancelled):
                expect(order_link(page, order_id)).to_be_visible()
            expect(order_card(page, partial)).to_contain_text('На проверке · осталось 1')
            expect(page.get_by_role('link', name='Управление заказами')).to_have_attribute('href', '#orders/tools')
            order_link(page, partial).click()
            expect(page.get_by_role('region', name='Подробности заказа')).to_contain_text('Belgee X50')
            nav.get_by_role('link', name=labels[2]).click()
            expect(nav.get_by_role('link', name=labels[2])).to_have_attribute('aria-current', 'page')
            expect(page.get_by_role('heading', name=labels[2], exact=True)).to_be_visible()
            summary = page.get_by_role('region', name='Итог за месяц')
            expect(summary).to_contain_text(re.compile(r'310,00\s*BYN'))
            month = page.get_by_label('Месяц отчёта')
            month.select_option('2026-10')
            expect(summary).to_contain_text(re.compile(r'500,13\s*BYN'))
            expect(order_link(page, current)).to_be_visible()
            order_link(page, current).click()
            expect(page.get_by_role('region', name='Подробности заказа')).to_contain_text('Geely Monjaro')
            assert not errors and not requests, (errors, requests)
        finally:
            context.close()
