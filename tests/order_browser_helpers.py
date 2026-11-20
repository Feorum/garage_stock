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


def check_decision_buttons(page, secondary, primary):
    """Both decisions must have distinct touch targets in their keyboard order."""
    expect(secondary).to_be_enabled()
    expect(primary).to_be_enabled()
    secondary.focus()
    page.keyboard.press('Tab')
    expect(primary).to_be_focused()
    page.keyboard.press('Shift+Tab')
    expect(secondary).to_be_focused()
    left, right = secondary.bounding_box(), primary.bounding_box()
    assert min(left['width'], left['height'], right['width'], right['height']) >= 48, (left, right)
    same_row = abs(left['y'] - right['y']) < 1
    if same_row:
        assert right['x'] - (left['x'] + left['width']) >= 7.9, (left, right)
    else:
        assert right['y'] - (left['y'] + left['height']) >= 7.9, (left, right)
        assert page.viewport_size['width'] < 768, (left, right)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
