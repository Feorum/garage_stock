"""Operate the role-specific task list and verify real navigation state."""
from playwright.sync_api import expect


def navigate_section(page, name):
    link = page.get_by_role('link', name=name, exact=True)
    link.click()
    expect(link).to_have_attribute('aria-current', 'page')
    expect(page.get_by_role('heading', name=name, level=1, exact=True)).to_be_visible()


def open_visit(page, order_id):
    card = page.locator(f'[data-vehicle-id="{order_id}"]')
    toggle = card.locator(f'[data-shift-target="{order_id}"]')
    expect(toggle).to_be_visible()
    if toggle.get_attribute('aria-expanded') != 'true':
        toggle.click()
    expect(toggle).to_have_attribute('aria-expanded', 'true')
    return card
