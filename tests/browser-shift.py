"""Check the two mechanic feeds, inline work, scoped updates and handoff on a built release."""
import argparse
import importlib.util
from pathlib import Path
import re

from playwright.sync_api import expect, sync_playwright
from order_browser_helpers import open_visit

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
                       order('013','manager',[task('glass','Задняя полусфера'),task('doors','Двери')]),
                       order('014','manager',[task('check','Осмотр кромки')])]}


def calls(page, rpc):
    return page.evaluate("(rpc) => __garageCalls.filter(c => c.name === rpc).map(c => c.args)", rpc)


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


def check_handoff(browser, base):
    data = fixture()
    data['loseInlineResponseOnce'] = ['garage_check_work', 'garage_submit_work']
    context, page, errors, live = smoke.new_page(browser, data, {'width':390,'height':844})
    try:
        page.goto(base + '/index.html#shift')
        expect(page.locator('[data-vehicle-id="011"]')).to_be_visible()
        expect(page.locator('[data-vehicle-id="012"]')).to_have_count(0)
        mine = open_visit(page, '011')
        expect(mine.get_by_text('Чужое поручение', exact=True)).to_have_count(0)
        expect(mine.locator('[data-task-id="assigned"]').get_by_role('checkbox')).to_be_enabled()
        page.get_by_role('link', name='Заказы менеджеров', exact=True).click()
        expect(page.locator('[data-vehicle-id]')).to_have_count(2)
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
        give_back = card.get_by_role('button', name='Передать владельцу', exact=True)
        give_back.click()
        form = card.locator('form.vehicle-handoff')
        expect(form.get_by_role('heading', name='Передача владельцу')).to_be_focused()
        expect(card.locator('[data-task-id="glass"]')).to_be_hidden()
        expect(form.get_by_text('Двери', exact=True)).to_be_visible()
        completed = form.locator('details').filter(has_text='Задняя полусфера')
        expect(completed.locator('summary')).to_be_visible()
        expect(completed.get_by_text('Задняя полусфера', exact=True)).to_be_hidden()
        completed.locator('summary').click()
        expect(completed.get_by_text('Задняя полусфера', exact=True)).to_be_visible()
        form.get_by_role('button', name='Отмена', exact=True).click()
        expect(give_back).to_be_focused()
        give_back.click()
        note = form.get_by_label('Комментарий владельцу')
        note.fill('Перепроверить кромку на дверях')
        submit = form.get_by_role('button', name='Передать владельцу', exact=True)
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
        for width in (320,390,768,1440):
            page.set_viewport_size({'width':width,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        assert not errors and not live, (errors, live)
    finally:
        context.close()


def run(directory, chromium):
    server, base = smoke.serve(directory.resolve())
    try:
        with sync_playwright() as playwright:
            with playwright.chromium.launch(executable_path=chromium, args=['--no-sandbox']) as browser:
                check_updates(browser, base)
                check_handoff(browser, base)
    finally:
        server.shutdown()
        server.server_close()
    print('Passed separate mechanic feeds, private rows, direct shared work, scoped realtime, fallback polling, offline and stale drafts, receipt replay, handoff and history.')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,default=ROOT/'dist')
    parser.add_argument('--chromium',default='/usr/bin/chromium')
    args=parser.parse_args()
    run(args.directory,args.chromium)
