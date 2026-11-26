"""Keyboard, identity and rate settings through the normal browser entry points."""
from playwright.sync_api import expect


def exercise_accounts(browser, base, new_page):
    profile = {'id': 'a2331903-73ce-47ca-aac2-92ee4fd60921', 'name': 'Тестовый Механик', 'role': 'mechanic', 'active': True}
    email = 'mechanic@example.invalid'
    fixture = {'signedIn': False, 'userId': profile['id'], 'profile': profile, 'email': email,
               'loginName': profile['name'], 'namePassword': 'synthetic-name-password'}
    ctx, page, errors, live = new_page(browser, fixture, {'width': 320, 'height': 844})
    try:
        page.goto(base + '/index.html#mechanics')
        identifier = page.get_by_label('Имя или электронная почта', exact=True)
        expect(identifier).to_have_attribute('type', 'text')
        identifier.fill(profile['name'])
        password = page.get_by_label('Пароль', exact=True)
        password.fill('wrong-password')
        page.get_by_role('button', name='Войти', exact=True).click()
        expect(page.get_by_text('Неверное имя или пароль.', exact=True)).to_be_visible()
        assert not page.evaluate("__garageCalls.some(c => c.method === 'setSession')")
        password.fill(fixture['namePassword'])
        page.get_by_role('button', name='Войти', exact=True).click()
        nav = page.get_by_role('navigation', name='Кабинет механика')
        expect(nav.get_by_role('link')).to_have_count(3)
        expect(nav.get_by_role('link', name='Заказы владельца')).to_have_attribute('aria-current', 'page')
        expect(page.get_by_role('link', name='Механики', exact=True)).to_have_count(0)
        assert page.evaluate("__garageCalls.filter(c => c.method === 'setSession').length") == 1
        assert page.evaluate("__garageCalls.filter(c => c.method === 'invoke').every(c => c.action === 'login')")
        assert not errors and not live, (errors, live)
    finally:
        ctx.close()

    ctx, page, errors, live = new_page(browser, {**fixture, 'signedIn': True}, {'width': 390, 'height': 844})
    try:
        page.goto(base + '/index.html')
        page.locator('summary').filter(has_text=profile['name']).click()
        page.get_by_role('link', name='Учётная запись', exact=True).click()
        expect(page).to_have_url(base + '/account.html')
        name = page.get_by_role('textbox', name='Имя для входа', exact=True)
        expect(name).to_have_value(profile['name'])
        new_name = 'Механик Два'
        name.fill(new_name)
        page.get_by_role('button', name='Сохранить имя').click()
        page.wait_for_function("__garageCalls.some(c => c.name === 'garage_update_profile_name')")
        assert page.evaluate("__garageCalls.find(c => c.name === 'garage_update_profile_name').args") == {'p_name': new_name}
        mail = page.get_by_role('textbox', name='Электронная почта', exact=True)
        expect(mail).to_have_value(email)
        mail.fill('updated@example.invalid')
        page.get_by_role('button', name='Сменить почту').click()
        page.wait_for_function("__garageCalls.some(c => c.method === 'updateUser' && c.email === 'updated@example.invalid')")
        expect(mail).to_have_value(email)
        expect(page.get_by_role('status').filter(has_text='Ожидает подтверждения адрес updated@example.invalid')).to_be_visible()
        assert page.evaluate("__garageCalls.find(c => c.method === 'updateUser' && c.email).redirect") == base + '/account.html'
        page.get_by_text('Изменить пароль', exact=True).click()
        page.get_by_label('Новый пароль', exact=True).fill('synthetic-new-password')
        page.get_by_label('Повторите новый пароль', exact=True).fill('synthetic-new-password')
        page.get_by_role('button', name='Сохранить пароль', exact=True).click()
        page.wait_for_function("__garageCalls.some(c => c.method === 'updateUser' && c.suppliedPassword)")
        assert not errors and not live, (errors, live)
    finally:
        ctx.close()

    account = {**profile, 'email': email}
    ctx, page, errors, live = new_page(browser, {'accounts': [account], 'staff': [profile]}, {'width': 320, 'height': 844})
    try:
        page.goto(base + '/index.html#mechanics')
        expect(page.get_by_role('heading', name='Механики', exact=True, level=1)).to_be_visible()
        page.get_by_role('button', name='Добавить механика').click()
        page.get_by_label('Имя механика', exact=True).fill('Новый механик')
        page.get_by_label('Электронная почта', exact=True).fill('new-mechanic@example.invalid')
        page.get_by_label('Пароль', exact=True).fill('fixture-initial-password')
        page.get_by_role('button', name='Создать механика').click()
        page.wait_for_function("__garageCalls.some(c => c.method === 'invoke' && c.action === 'create')")
        created = page.evaluate("__garageCalls.find(c => c.method === 'invoke' && c.action === 'create')")
        assert (created['name'], created['email'], created['suppliedPassword']) == ('Новый механик', 'new-mechanic@example.invalid', True)
        mail = page.get_by_label('Электронная почта', exact=True)
        expect(mail).to_have_value('new-mechanic@example.invalid')
        mail.fill('corrected@example.invalid')
        page.get_by_label('Новый пароль', exact=True).fill('a-fixture-new-password')
        page.get_by_role('button', name='Сохранить доступ').click()
        page.wait_for_function("__garageCalls.some(c => c.method === 'invoke' && c.action === 'update')")
        updated = page.evaluate("__garageCalls.find(c => c.method === 'invoke' && c.action === 'update')")
        assert updated['email'] == 'corrected@example.invalid' and updated['suppliedPassword']
        page.get_by_label('Действует с').fill('2026-11-25')
        page.get_by_label('Ставка, %').fill('17,5')
        page.get_by_role('button', name='Сохранить ставку').click()
        expect(page.get_by_text('Ставка сохранена.', exact=True)).to_be_visible()
        rate = page.evaluate("__garageCalls.find(c => c.name === 'garage_save_mechanic_rate').args")
        assert (rate['p_mechanic_id'], rate['p_effective_date'], rate['p_rate_bp']) == (updated['id'], '2026-11-25', 1750)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors and not live, (errors, live)
    finally:
        ctx.close()
    return ['name sign-in verifies the mechanic session and keeps owner settings private',
            'the account menu opens personal name, email and password settings',
            'owner creates a mechanic, updates access and saves a dated percentage at mobile width']
