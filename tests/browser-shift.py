"""Check the two mechanic feeds, inline work, scoped updates and handoff on a built release."""
import argparse
import base64
import importlib.util
from pathlib import Path
import re

from playwright.sync_api import expect, sync_playwright
from order_browser_helpers import check_decision_buttons, open_visit

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('garage_browser_smoke', ROOT / 'tests/browser-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
ME = '11111111-1111-4111-8111-111111111111'
PEER = '22222222-2222-4222-8222-222222222222'


def fixture():
    def task(key, name, assigned=None):
        return {'id': key, 'work_name': name, 'work_code': 'W01', 'version': 1, 'status': 'pending',
                'participants': [{'mechanic_id': assigned, 'status': 'assigned', 'name': 'Иван' if assigned == ME else 'Олег'}] if assigned else []}

    def order(key, source, jobs):
        return {'id': key, 'order_number': 'GS-' + key, 'vehicle': 'Повторный автомобиль', 'source': source,
                'priority': 'normal', 'status': 'published', 'version': 1, 'vin': 'WVWZZZ1JZXW000001',
                'created_at':'2026-11-18T08:00:00Z','tasks': jobs}

    return {'userId': ME, 'profile': {'id': ME, 'name': 'Иван', 'role': 'mechanic'},
            'staff': [{'id': ME, 'name': 'Иван', 'color': '#135286'}, {'id': PEER, 'name': 'Олег', 'color':'#884422'}],
            'orders': [order('011','owner',[task('assigned','Капот',ME),task('private','Чужое поручение',PEER)]),
                       order('012','owner',[task('other','Полностью закрытый заказ',PEER)]),
                       {**order('013','manager',[task('glass','Задняя полусфера'),task('doors','Двери')]),
                        'planned_date':'2026-11-23'},
                       {**order('014','manager',[task('check','Осмотр кромки')]), 'due_date':'2026-11-19'}]}


def calls(page, rpc):
    return page.evaluate("(rpc) => __garageCalls.filter(c => c.name === rpc).map(c => c.args)", rpc)


def check_card_layout(browser, base, output):
    data = fixture()
    order = data['orders'][2]
    order.update(vehicle='Belgee X50', manager_label='Тестовый автор заказа')
    order['tasks'][0].update(work_code='W19', options={'tint_percent': 15})
    long_name = 'Очистка и полировка верхней кромки рядом с задней дверью'
    order['tasks'].append({**order['tasks'][1], 'id': 'edge', 'work_name': long_name})
    context, page, errors, live = smoke.new_page(browser, data)
    try:
        for width in (320, 1440):
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto(base + '/index.html#manager-orders')
            card = page.locator('[data-vehicle-id="013"]')
            summary = card.get_by_role('list', name='Работы по заказу')
            rows = summary.get_by_role('listitem')
            expect(rows).to_have_text(['Задняя полусфера · 15%', 'Двери', long_name])
            expect(card).not_to_contain_text(order['manager_label'])
            expect(card).not_to_contain_text('Заказ менеджера')
            toggle = card.locator('.mb-order')
            date = toggle.locator('time')
            expect(date).to_have_attribute('datetime', '2026-11-23')
            assert date.evaluate("el => parseFloat(getComputedStyle(el).fontSize)") >= 14
            assert date.bounding_box()['y'] > toggle.locator('strong').bounding_box()['y']
            assert rows.evaluate_all('''items => items.every(item =>
              getComputedStyle(item).backgroundColor !== 'rgba(0, 0, 0, 0)' &&
              parseFloat(getComputedStyle(item).fontSize) >= 16 && item.scrollWidth <= item.clientWidth)''')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            if output:
                card.screenshot(path=output / f'mechanic-collapsed-{width}.png')
            bounds = rows.last.bounding_box()
            page.mouse.click(bounds['x'] + bounds['width'] / 2, bounds['y'] + bounds['height'] / 2)
            expect(toggle).to_have_attribute('aria-expanded', 'true')
            expect(summary).to_have_count(0)
            tasks = card.get_by_role('checkbox')
            expect(tasks).to_have_count(3)
            assert all(box.bounding_box()['height'] >= 44 for box in tasks.all())
            if output:
                card.screenshot(path=output / f'mechanic-expanded-{width}.png')
            toggle.focus()
            toggle.press('Space')
            expect(summary).to_be_visible()
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def check_updates(browser, base):
    for realtime_available in (True, False):
        data = fixture()
        data['realtimeUnavailable'] = not realtime_available
        context, page, errors, live = smoke.new_page(browser, data, {'width':390,'height':844})
        try:
            page.clock.install(time='2026-11-19T09:00:00Z')
            page.goto(base + '/index.html#manager-orders/013')
            card = open_visit(page, '013')
            row = card.locator('[data-task-id="glass"]')
            box = row.get_by_role('checkbox')
            expect(box).to_be_enabled()
            subscribed = page.evaluate("__garageCalls.find(c => c.method === 'channel.on' && c.options.table === 'garage_board_updates')")
            assert subscribed['options']['filter'] == 'recipient_id=eq.' + ME and subscribed['options']['schema'] == 'public'
            # Freeze foreground timers so a successful invalidation cannot be confused with a poll.
            page.clock.pause_at('2026-11-19T09:00:02Z')
            page.evaluate("""([peer]) => {
                const visit = __garageOrderState.orders.find(o => o.id === '013');
                const task = visit.tasks[0];
                task.status = 'completed'; task.completed_at = new Date().toISOString(); task.version++; visit.version++;
                task.participants = [{mechanic_id: peer, name:'Олег', status:'confirmed', color:'#884422', confirmed_at:task.completed_at}];
                __garageBoardSignal({recipient_id:peer, revision:1});
            }""", [PEER])
            marker = row.locator(f'[data-mechanic-id="{PEER}"]')
            page.clock.run_for(50)
            expect(marker).to_have_count(0)
            page.evaluate("(recipient_id) => __garageBoardSignal({recipient_id, revision:2})", ME)
            page.clock.run_for(150)
            if realtime_available:
                expect(marker).to_be_visible(timeout=1000)
            else:
                expect(marker).to_have_count(0)
                page.clock.run_for(3500)
                expect(marker).to_be_visible()
            expect(box).to_be_enabled()
            assert not errors and not live, (errors, live)
        finally:
            context.close()


def check_history_order(browser, base):
    data = fixture()
    older, recent = data['orders'][2:]

    def completed(task, at):
        return {**task, 'status': 'completed', 'completed_at': at,
                'participants': [{'mechanic_id': ME, 'name': 'Иван', 'status': 'confirmed', 'confirmed_at': at}]}

    old_tasks = [completed(older['tasks'][0], '2026-11-20T18:00:00Z'),
                 completed(older['tasks'][1], '2026-11-20T20:00:00Z')]
    older.update(status='closed', planned_date='2026-11-24', tasks=old_tasks)
    recent.update(status='closed', tasks=[completed(recent['tasks'][0], '2026-11-20T20:30:00Z')])
    handed = {**recent, 'id': '015', 'order_number': 'GS-015', 'tasks': [
        {**recent['tasks'][0], 'id': 'handed'}],
        'vehicle_workflow': {'state': 'closed', 'handed_by': ME, 'handed_at': '2026-11-20T21:30:00Z'}}
    undated = {**recent, 'id': '016', 'order_number': 'GS-016', 'due_date': None,
               'tasks': [completed({**recent['tasks'][0], 'id': 'undated'}, None)]}
    data['orders'] += [undated, handed]
    context, page, errors, live = smoke.new_page(browser, data, {'width': 390, 'height': 844})
    try:
        page.goto(base + '/index.html#history')
        visits = page.locator('[data-vehicle-id]')
        expect(visits).to_have_count(4)
        assert visits.evaluate_all("cards => cards.map(card => card.dataset.vehicleId)") == ['015', '014', '013', '016']
        expect(visits.nth(0).locator('time')).to_have_attribute('datetime', '2026-11-21')
        expect(visits.nth(2).locator('time')).to_have_attribute('datetime', '2026-11-20')
        expect(visits.nth(2).locator('time')).to_contain_text('Выполнение')
        expect(visits.nth(3)).to_contain_text('Дата не указана')
        card = visits.nth(2)
        expect(card.get_by_role('list', name='Работы по заказу').get_by_role('listitem')).to_have_text(['Двери', 'Задняя полусфера'])
        expanded = open_visit(page, '013')
        expect(expanded.locator('.mb-work-list .mb-work-name')).to_have_text(['Двери', 'Задняя полусфера'])
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def check_handoff(browser, base, output=None):
    data = fixture()
    data['loseInlineResponseOnce'] = ['garage_check_work', 'garage_uncheck_work', 'garage_submit_work']
    context, page, errors, live = smoke.new_page(browser, data, {'width':390,'height':844})
    try:
        page.goto(base + '/index.html#shift')
        expect(page.locator('[data-vehicle-id="011"]')).to_be_visible()
        expect(page.locator('[data-vehicle-id="012"]')).to_have_count(0)
        mine = open_visit(page, '011')
        expect(mine.get_by_text('Чужое поручение', exact=True)).to_have_count(0)
        expect(mine.locator('[data-task-id="assigned"]').get_by_role('checkbox')).to_be_enabled()
        page.get_by_role('link', name='Заказы менеджеров', exact=True).click()
        visits = page.locator('[data-vehicle-id]')
        expect(visits).to_have_count(2)
        expect(visits.nth(0)).to_have_attribute('data-vehicle-id', '014')
        expect(visits.nth(0).locator('time')).to_have_attribute('datetime', '2026-11-19')
        expect(visits.nth(1).locator('time')).to_have_attribute('datetime', '2026-11-23')
        assert visits.evaluate_all("rows => rows.every(row => getComputedStyle(row, '::before').width === '3px') && "
                                   "new Set(rows.map(row => getComputedStyle(row, '::before').backgroundColor)).size === 2")
        card = open_visit(page, '013')
        row = card.locator('[data-task-id="glass"]')
        box = row.get_by_role('checkbox')
        context.set_offline(True)
        expect(box).to_be_disabled()
        context.set_offline(False)
        expect(box).to_be_enabled()
        box.focus()
        page.keyboard.press('Space')
        retry = page.get_by_role('button', name='Проверить отправку', exact=True)
        retry.click()
        expect(row.locator(f'[data-mechanic-id="{ME}"]')).to_be_visible()
        writes = calls(page, 'garage_check_work')
        assert len(writes) == 2 and writes[0] == writes[1] and writes[0]['p_task_id'] == 'glass', writes
        expect(box).to_be_checked()
        expect(box).to_be_enabled()
        give_back = card.get_by_role('button', name='Передать владельцу', exact=True)
        # A stale removal must leave the current participant in place until the mechanic reviews and tries again.
        page.evaluate("__garageOrderState.orders.find(o => o.id === '013').tasks[0].version++")
        box.click()
        expect(card.get_by_text('Заказ изменился. Проверьте обновлённые работы.', exact=False)).to_be_visible()
        expect(box).to_be_checked()
        expect(row.locator(f'[data-mechanic-id="{ME}"]')).to_be_visible()
        card.get_by_role('button', name='Закрыть', exact=True).click()
        page.evaluate("__garageTest.rpcDelays = {garage_uncheck_work: 250}")
        box.focus()
        page.keyboard.press('Space')
        expect(box).to_be_checked()
        expect(box).to_be_disabled()
        expect(box).to_have_attribute('aria-busy', 'true')
        retry.click()
        expect(box).not_to_be_checked()
        expect(box).to_be_enabled()
        expect(row.locator(f'[data-mechanic-id="{ME}"]')).to_have_count(0)
        expect(give_back).to_have_count(0)
        undos = calls(page, 'garage_uncheck_work')
        assert len(undos) == 3 and undos[0]['p_expected_version'] == 2 and undos[1]['p_expected_version'] == 3
        assert undos[1] == undos[2] and undos[1]['p_request_id'] != undos[0]['p_request_id']
        expect(box).to_be_focused()
        page.keyboard.press('Space')
        expect(box).to_be_checked()
        expect(box).to_be_focused()
        give_back.click()
        form = card.locator('form.vehicle-handoff')
        expect(form.get_by_role('heading', name='Передача владельцу')).to_be_focused()
        cancel = form.get_by_role('button', name='Отмена', exact=True)
        submit = form.get_by_role('button', name='Передать владельцу', exact=True)
        for width in (320, 1440):
            page.set_viewport_size({'width': width, 'height': 900})
            check_decision_buttons(page, cancel, submit)
            submit.focus()
            if output:
                card.screenshot(path=output / f'mechanic-handoff-{width}.png')
        page.set_viewport_size({'width': 390, 'height': 844})
        expect(card.locator('[data-task-id="glass"]')).to_be_hidden()
        expect(form.get_by_text('Двери', exact=True)).to_be_visible()
        completed = form.locator('details').filter(has_text='Задняя полусфера')
        expect(completed.locator('summary')).to_be_visible()
        expect(completed.get_by_text('Задняя полусфера', exact=True)).to_be_hidden()
        completed.locator('summary').click()
        expect(completed.get_by_text('Задняя полусфера', exact=True)).to_be_visible()
        cancel.click()
        expect(give_back).to_be_focused()
        give_back.click()
        note = form.get_by_label('Комментарий владельцу')
        note.fill('Перепроверить кромку на дверях')
        context.set_offline(True)
        expect(submit).to_be_disabled()
        page.evaluate("__garageOrderState.orders.find(order => order.id === '013').version++")
        context.set_offline(False)
        verify = form.get_by_role('button', name=re.compile('проверил изменения', re.I))
        expect(verify).to_be_visible()
        expect(note).to_have_value('Перепроверить кромку на дверях')
        verify.click()
        submit.click()
        retry.click()
        writes = calls(page, 'garage_submit_work')
        assert len(writes) == 2 and writes[0] == writes[1] and writes[0]['p_note'] == 'Перепроверить кромку на дверях', writes
        assert not calls(page, 'garage_vehicle_action') and not calls(page, 'garage_team_action')
        assert not [name for name in ('garage_manager_intakes','garage_staff','garage_pay_worklist','garage_order_financials','garage_owner_review_prices') if calls(page,name)]
        assert not re.search(r'BYN|НДС|€', page.locator('body').inner_text())
        page.get_by_role('link', name='История', exact=True).click()
        history = open_visit(page, '013')
        expect(history.get_by_text('Перепроверить кромку на дверях', exact=True)).to_be_visible()
        expect(history.get_by_role('checkbox')).to_have_count(0)
        for width in (320,390,768,1440):
            page.set_viewport_size({'width':width,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def photo_session(browser, data):
    context, page, errors, live = smoke.new_page(browser, data)
    context.route('**/garage_stock/sdk.js', lambda route: route.fulfill(content_type='text/javascript',
        body=smoke.fake_browser_module() + """
const photos = new Map();
sb.storage = { from(bucket) {
  if (bucket !== 'garage-order-photos') throw Error('Unexpected photo bucket');
  return {
    async upload(key, blob, opts) {
      if (opts.upsert || photos.has(key)) throw Error('Photo overwrite');
      photos.set(key, blob);
      return {data:{path:key}, error:null};
    },
    async list(folder) {
      return {data:[...photos.keys()].filter(key => key.startsWith(folder + '/')).map(key =>
        ({name:key.split('/')[1], created_at:'2026-11-26T08:00:00Z'})), error:null};
    },
    async download(key) { return {data:photos.get(key), error:null}; }
  };
}};
"""))
    return context, page, errors, live


def check_photo_protocol(browser, base):
    data = fixture()
    review = data['orders'][2]
    review['vehicle_workflow'] = {'state': 'review', 'handed_by': PEER, 'holder_id': PEER}
    # Opening a review visit is allowed even when this mechanic never checked a job.
    context, page, errors, live = photo_session(browser, data)
    try:
        page.goto(base + '/index.html#history')
        card = open_visit(page, review['id'])
        expect(card.get_by_text('На проверке у владельца', exact=True)).to_be_visible()
        expect(card.get_by_role('checkbox')).to_have_count(0)
        with page.expect_file_chooser() as selection:
            card.get_by_role('button', name='Прикрепить фото').click()
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTQAAAABJRU5ErkJggg==')
        selection.value.set_files({'name':'visit.png','mimeType':'image/png','buffer':png})
        expect(card.get_by_text('Фото прикреплено.', exact=True)).to_be_visible()
        card.get_by_role('button',name=re.compile(r'^Фото 1')).click()
        expect(card.get_by_role('img',name='Фотография автомобиля по заказу')).to_be_visible()
        card.get_by_role('button',name='Закрыть фото').click()
        page.get_by_role('link', name='Заказы менеджеров', exact=True).click()
        other = open_visit(page, '014')
        other.get_by_role('button',name='Показать фотографии').click()
        expect(other.get_by_text('Фотографий пока нет.', exact=True)).to_be_visible()

        page.evaluate("""() => {
          const visit = __garageOrderState.orders.find(o => o.id === '013');
          visit.status = 'closed';
          visit.tasks[0].participants = [{mechanic_id:__garageTest.userId,status:'assigned',name:'Иван'}];
          visit.vehicle_workflow.state = 'closed';
          document.dispatchEvent(new Event('visibilitychange'));
        }""")
        page.get_by_role('link',name='История',exact=True).click()
        card = open_visit(page, '013')
        expect(card.get_by_role('button',name='Прикрепить фото')).to_have_count(0)
        card.get_by_role('button',name='Показать фотографии').click()
        expect(card.get_by_role('button',name=re.compile(r'^Фото 1'))).to_be_visible()
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def check_owner_photos(browser, base):
    data = fixture()
    data['profile']['role'] = 'admin'
    review, closed = data['orders'][2:]
    review['vehicle_workflow'] = {'state':'review', 'handed_by':PEER, 'holder_id':PEER}
    closed['status'] = 'closed'
    context, page, errors, live = photo_session(browser, data)
    try:
        page.goto(base + '/index.html#orders/' + review['id'])
        page.get_by_role('button', name='Фото к заказу', exact=True).click()
        photos = page.get_by_role('region', name='Фотопротокол')
        with page.expect_file_chooser() as chosen:
            photos.get_by_role('button',name='Прикрепить фото').click()
        chosen.value.set_files({'name':'review.jpg','mimeType':'image/jpeg','buffer':b'photo fixture'})
        expect(photos.get_by_text('Фото прикреплено.', exact=True)).to_be_visible()
        page.goto(base + '/index.html#orders/' + closed['id'])
        page.get_by_role('button', name='Фото', exact=True).click()
        expect(photos.get_by_text('Фотографий пока нет.')).to_be_visible()
        expect(photos.get_by_role('button',name='Прикрепить фото')).to_have_count(0)
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def run(directory, chromium, output=None):
    if output:
        output.mkdir(parents=True, exist_ok=True)
    server, base = smoke.serve(directory.resolve())
    try:
        with sync_playwright() as playwright:
            with playwright.chromium.launch(executable_path=chromium, args=['--no-sandbox']) as browser:
                check_card_layout(browser, base, output)
                check_photo_protocol(browser, base)
                check_owner_photos(browser, base)
                check_history_order(browser, base)
                check_updates(browser, base)
                check_handoff(browser, base, output)
    finally:
        server.shutdown()
        server.server_close()
    print('Passed compact mechanic cards, ascending active feeds, newest-first history and tasks, weekday markers, private rows, shared work, scoped realtime, fallback polling, offline and stale drafts, receipt replay and handoff.')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,default=ROOT/'dist')
    parser.add_argument('--chromium',default='/usr/bin/chromium')
    parser.add_argument('--output', type=Path, help='Optional directory for mechanic card and handoff screenshots.')
    args=parser.parse_args()
    run(args.directory,args.chromium,args.output)
