"""Wait for visible navigation state before operating collapsible test orders."""
from playwright.sync_api import expect


def navigate_section(page, name):
    link = page.get_by_role('link', name=name, exact=True)
    link.click()
    expect(link).to_have_attribute('aria-current', 'page')
    expect(page.get_by_role('heading', name=name, level=1, exact=True)).to_be_visible()


def task_card(page, task_id):
    card = page.locator(f'[data-task-id="{task_id}"]')
    details = card.locator('xpath=ancestor::details[contains(@class,"compact-order")][1]')
    expect(details).to_have_count(1)
    if details.get_attribute('open') is None:
        details.locator(':scope > summary').click()
    return card
