"""Exercise task detail layout, drafts, focus and team visibility with the local SDK fixture."""
import argparse
import importlib.util
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('garage_browser_smoke', ROOT / 'tests/browser-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def fixture():
    actor = '11111111-1111-4111-8111-111111111111'
    members = [{'mechanic_id': actor, 'name': 'Иван', 'status': 'working'}]
    locked_members = [{'mechanic_id': 'a', 'name': 'Анна', 'status': 'confirmed'},
                      {'mechanic_id': 'b', 'name': 'Олег', 'status': 'working'}]

    def order(source, key, team):
        return {'id': key, 'order_number': 'GS-' + key, 'vehicle': 'Тестовый автомобиль ' + key,
                'source': source, 'priority': 'normal', 'status': 'published', 'version': 1,
                'tasks': [{'id': 'task-' + key, 'work_name': 'Оклейка капота', 'work_code': 'W01',
                           'version': 1, 'participants': team, 'status': 'in_progress'}]}

    private = order('owner', '11', members)
    shared = order('manager', '12', locked_members)
    shared['tasks'][0]['notes'] = [{'id': 'private', 'note': 'Закрытый комментарий бригады'}]
    return {'userId': actor, 'profile': {'id': actor, 'name': 'Иван', 'role': 'mechanic'},
            'orders': [private, shared]}


def run(directory, chromium):
    server, base = smoke.serve(directory.resolve())
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chromium, args=['--no-sandbox'])
            try:
                context, page, errors, live = smoke.new_page(browser, fixture(), {'width': 390, 'height': 844})
                page.goto(base + '/index.html#shift')
                trigger = page.locator('[data-task-id="task-11"] button')
                trigger.focus()
                page.keyboard.press('Enter')
                primary = page.get_by_role('button', name='Подтвердить свою работу', exact=True)
                expect(primary).to_be_in_viewport(ratio=1)
                assert primary.bounding_box()['height'] >= 44
                page.get_by_role('button', name='Оставить заметку', exact=True).click()
                text = page.get_by_label('Текст заметки', exact=True)
                text.fill('Проверить кромку перед выдачей')
                context.set_offline(True)
                expect(page.get_by_role('button', name='Сохранить заметку')).to_be_disabled()
                page.evaluate('__garageOrderState.orders[0].tasks[0].version++')
                context.set_offline(False)
                expect(text).to_have_value('Проверить кромку перед выдачей')
                page.get_by_role('button', name='Я проверил изменения').click()
                page.get_by_role('button', name='Сохранить заметку').click()
                expect(page.locator('.shift-notes')).to_contain_text('Проверить кромку перед выдачей')
                page.get_by_role('button', name='← К списку').click()
                expect(trigger).to_be_focused()
                page.get_by_role('link', name='Общая очередь').click()
                expect(page.get_by_role('heading', name='Уже в работе')).to_be_visible()
                row = page.locator('[data-task-id="task-12"] button')
                expect(row).to_contain_text('Анна, Олег')
                row.click()
                expect(page.get_by_role('heading', name='Команда')).to_be_visible()
                expect(page.get_by_role('heading', name='Заметки команды')).to_have_count(0)
                expect(page.get_by_text('Закрытый комментарий бригады')).to_have_count(0)
                expect(page.get_by_role('button', name='Присоединиться')).to_have_count(0)
                for width in (320, 390, 768, 1440):
                    page.set_viewport_size({'width': width, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
                context.close()
                assert not errors and not live, (errors, live)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Passed phone action visibility, offline draft recovery, task conflicts, keyboard focus and team-only note checks.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    run(args.directory, args.chromium)
