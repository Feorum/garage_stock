"""Operate the role-specific task list and verify real navigation state."""
from playwright.sync_api import expect


def navigate_section(page, name):
    link = page.get_by_role('link', name=name, exact=True)
    link.click()
    expect(link).to_have_attribute('aria-current', 'page')
    expect(page.get_by_role('heading', name=name, level=1, exact=True)).to_be_visible()


def open_visit(page, order_id, *, take=False):
    row = page.locator(f'[data-vehicle-id="{order_id}"]')
    if take:
        row.get_by_role('button', name='Взять автомобиль', exact=True).click()
    else:
        row.locator(f'[data-shift-target="{order_id}"]').click()


def task_card(page, task_id, order_id=None):
    if order_id:
        open_visit(page, order_id)
    page.locator(f'[data-task-id="{task_id}"]').get_by_role('button').first.click()
    detail = page.locator(f'[data-task-detail="{task_id}"]')
    expect(detail).to_be_visible()
    return detail
