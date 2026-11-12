#!/usr/bin/env python3
"""Run the skeleton against a fake SDK. No live accounts or database writes.

Requires Python Playwright and Chromium. Build first:
  python3 scripts/build-pages.py
  python3 tests/browser-smoke.py
"""

import argparse
import functools
import http.server
import json
from pathlib import Path
import re
import threading
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
SDK = (ROOT / 'tests' / 'fake-supabase.js').read_text()


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def translate_path(self, path):
        # Match the production GitHub Pages subdirectory, not only a root host.
        if path.startswith('/garage_stock/'):
            return super().translate_path(path[len('/garage_stock'):])
        return str(Path(self.directory) / '__outside_test_mount__')

    def do_GET(self):
        # Worker fetches are not reliably intercepted by browser network routing.
        # Serve the same fake SDK locally for this one cache-lifecycle scenario.
        if getattr(self.server, 'stub_config', False) and urlsplit(self.path).path.endswith('/src/supabase.js'):
            body = SDK.replace('export function createClient()', 'function createClient()')
            data = (body + '\nexport const sb = createClient();\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()


def serve(directory):
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}/garage_stock'


def check_no_private_data(page):
    calls = page.evaluate('globalThis.__garageCalls || []')
    reads = [entry['table'] for entry in calls if entry['method'] == 'from']
    assert set(reads) <= {'profiles'}, reads
    assert not any(entry['method'] in ('insert', 'delete', 'upsert', 'rpc') for entry in calls), calls
    body = page.locator('body').inner_text()
    assert not re.search(r'€|\bBYN\b|\bEUR\b|\bVAT\b', body), body


def new_page(browser, fixture, viewport=None, service_workers='block'):
    context = browser.new_context(
        viewport=viewport or {'width': 1440, 'height': 1000},
        service_workers=service_workers,
    )
    context.add_init_script('globalThis.__garageTest = ' + json.dumps(fixture) + ';')
    errors = []
    live_requests = []
    context.route('https://cdn.jsdelivr.net/**', lambda route: route.fulfill(
        content_type='text/javascript', body=SDK))

    def reject_live(route):
        live_requests.append(route.request.url)
        route.abort()

    context.route(re.compile(r'https://[^/]*supabase\.(?:co|com)/'), reject_live)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    return context, page, errors, live_requests


def ready(page, name):
    expect(page.get_by_role('button', name='Sign out', exact=True)).to_be_visible()
    expect(page.get_by_text(name, exact=True).first).to_be_visible()


def run(args):
    built = args.directory.resolve()
    assert (built / 'index.html').exists(), 'Build the site first.'
    args.output.mkdir(parents=True, exist_ok=True)
    server, base = serve(built)
    passed = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True,
                                             args=['--no-sandbox'])
        try:
            # Both roles load only their own workspace navigation.
            for role, name, expected_links, forbidden in [
                ('admin', 'Test Owner', ['Orders', 'Approved works', 'Reports'], 'Assigned by Owner'),
                ('mechanic', 'Test Mechanic', ['Assigned by Owner', 'Manager orders', 'My work'], 'Reports'),
            ]:
                viewport = {'width': 390, 'height': 844} if role == 'mechanic' else None
                context, page, errors, live = new_page(browser, {'profile': {'name': name, 'role': role}}, viewport)
                page.goto(base + '/index.html')
                ready(page, name)
                for label in expected_links:
                    expect(page.get_by_role('link', name=label, exact=True)).to_be_visible()
                expect(page.get_by_role('link', name=forbidden, exact=True)).to_have_count(0)
                page.evaluate("location.hash = '#reports'" if role == 'mechanic' else "location.hash = '#assigned'")
                expect(page.get_by_role('link', name=expected_links[0], exact=True)).to_have_attribute('aria-current', 'page')
                check_no_private_data(page)
                assert not errors, errors
                assert not live, live
                if role == 'admin':
                    page.screenshot(path=str(args.output / 'owner-workspace.png'), full_page=True)
                    page.get_by_role('link', name='Approved works', exact=True).click()
                    expect(page.get_by_label('Vehicle group', exact=True)).to_be_visible()
                    assert page.get_by_label('Vehicle group', exact=True).locator('option').count() in (17, 18)
                    assert page.locator('[data-work-code]').count() == 19
                    page.get_by_label('Vehicle group', exact=True).select_option('VG01')
                    expect(page.get_by_text('15 of 19 works available for this group', exact=True)).to_be_visible()
                    assert page.locator('[data-work-code].unavailable').count() == 4
                    page.get_by_label('Vehicle group', exact=True).select_option('VG02')
                    expect(page.get_by_text('19 of 19 works available for this group', exact=True)).to_be_visible()
                    assert page.locator('[data-work-code].unavailable').count() == 0
                    page.get_by_role('link', name='Skip to content', exact=True).evaluate('link => link.click()')
                    assert page.url.endswith('#catalogue'), page.url
                    expect(page.get_by_role('link', name='Approved works', exact=True)).to_have_attribute('aria-current', 'page')
                    assert page.evaluate("document.activeElement.id === 'main-content'")
                    page.screenshot(path=str(args.output / 'owner-catalogue.png'), full_page=True)
                    check_no_private_data(page)
                else:
                    page.screenshot(path=str(args.output / 'mechanic-workspace.png'), full_page=True)
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.get_by_role('button', name='Sign out', exact=True).click()
                expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
                expect(page.get_by_role('navigation')).to_have_count(0)
                expect(page.get_by_text(name, exact=True)).to_have_count(0)
                passed.append(role + ' role, route guard, catalogue/privacy and logout')
                context.close()

            # Sign-in uses a real form, prevents duplicate submits, and shows useful errors.
            context, page, errors, live = new_page(browser, {
                'signedIn': False, 'loginError': 'Invalid login credentials', 'loginDelay': 250,
            }, {'width': 390, 'height': 844})
            page.goto(base + '/index.html')
            page.get_by_label('Email', exact=True).fill('test@example.invalid')
            page.get_by_label('Password', exact=True).fill('not-a-real-password')
            page.get_by_role('button', name='Sign in', exact=True).click()
            button = page.locator('form button[type="submit"]')
            expect(button).to_be_disabled()
            expect(page.get_by_text('Invalid login credentials', exact=True)).to_be_visible()
            assert page.evaluate("__garageCalls.filter(c => c.method === 'signInWithPassword').length") == 1
            expect(button).to_be_enabled()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(args.output / 'sign-in-mobile.png'), full_page=True)
            assert not errors, errors
            assert not live, live
            passed.append('mobile sign-in, error handling and in-flight submit guard')
            context.close()

            context, page, errors, live = new_page(browser, {
                'signedIn': False, 'profile': {'name': 'Test Mechanic', 'role': 'mechanic'},
            })
            page.goto(base + '/index.html')
            page.get_by_label('Email', exact=True).fill('test@example.invalid')
            page.get_by_label('Password', exact=True).fill('not-a-real-password')
            page.get_by_role('button', name='Sign in', exact=True).click()
            ready(page, 'Test Mechanic')
            expect(page.get_by_role('link', name='Assigned by Owner', exact=True)).to_be_visible()
            expect(page.get_by_role('link', name='Reports', exact=True)).to_have_count(0)
            check_no_private_data(page)
            assert not errors, errors
            assert not live, live
            passed.append('successful sign-in opens the verified mechanic workspace')
            context.close()

            # Unknown role and missing profile cannot fall through to a mechanic workspace.
            for profile in (None, {'name': 'Unexpected User', 'role': 'manager'}):
                context, page, errors, live = new_page(browser, {'profile': profile})
                page.goto(base + '/index.html')
                expect(page.get_by_role('button', name='Sign out', exact=True)).to_be_visible()
                expect(page.get_by_role('navigation')).to_have_count(0)
                check_no_private_data(page)
                assert not errors, errors
                assert not live, live
                context.close()
            passed.append('missing profiles and unknown roles denied')

            # Session expiry must win a race against a slow profile fetch.
            context, page, errors, live = new_page(browser, {'profileDelay': 600})
            page.goto(base + '/index.html')
            page.wait_for_function("(globalThis.__garageCalls || []).some(c => c.method === 'from')")
            page.evaluate('__garageAuth.signOut()')
            expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
            page.wait_for_timeout(750)
            expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
            expect(page.get_by_role('navigation')).to_have_count(0)
            assert not errors, errors
            assert not live, live
            passed.append('session expiry wins delayed-profile race')
            context.close()

            # The account callback remains verified, scrubbed and usable after configuration refactor.
            context, page, errors, live = new_page(browser, {})
            page.goto(base + '/account.html#access_token=fake-test-token&type=recovery')
            expect(page.get_by_label('New password', exact=True)).to_be_visible()
            assert page.url == base + '/account.html', page.url
            page.get_by_label('New password', exact=True).fill('a-long-test-password')
            page.get_by_label('Confirm new password', exact=True).fill('a-long-test-password')
            page.get_by_role('button', name='Save password', exact=True).click()
            expect(page.get_by_role('heading', name='Password saved', exact=True)).to_be_visible()
            assert not errors, errors
            assert not live, live
            passed.append('account callback verification, URL cleanup and password form')
            context.close()

            for path, fixture in (
                ('/account.html?code=unsupported-test-code', {}),
                ('/account.html#error=access_denied', {}),
                ('/account.html', {'signedIn': False}),
            ):
                context, page, errors, live = new_page(browser, fixture)
                page.goto(base + path)
                expect(page.get_by_text('This account link is missing, expired, or invalid.', exact=True)).to_be_visible()
                expect(page.get_by_label('New password', exact=True)).not_to_be_visible()
                assert page.url == base + '/account.html', page.url
                assert not errors, errors
                context.close()
            passed.append('unsupported and failed account callbacks rejected and scrubbed')

            # Real service-worker upgrade: install a minimal v3 worker on the same scope first.
            server.stub_config = True
            context, page, errors, live = new_page(browser, {'signedIn': False}, service_workers='allow')
            legacy = """
              self.addEventListener('install', event => {
                event.waitUntil(caches.open('garage-log-v3').then(cache =>
                  cache.put('./legacy-marker', new Response('old shell'))));
                self.skipWaiting();
              });
              self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
            """
            context.route('**/legacy-test-sw.js', lambda route: route.fulfill(
                content_type='text/javascript', headers={'Service-Worker-Allowed': '/'}, body=legacy))
            page.goto(base + '/account.html')
            page.evaluate("""async () => {
              await caches.open('another-app-v1').then(cache => cache.put('./sibling-marker', new Response('keep')));
              await navigator.serviceWorker.register('./legacy-test-sw.js', {scope: './'});
              await navigator.serviceWorker.ready;
            }""")
            page.wait_for_function('navigator.serviceWorker.controller !== null')
            page.goto(base + '/index.html')
            expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
            # A waiting version is deliberate: do not mix its modules into an old controlled tab.
            page.wait_for_function('navigator.serviceWorker.getRegistration().then(reg => !!reg.waiting)')
            page.close()
            worker = next(worker for worker in context.service_workers if urlsplit(worker.url).path.endswith('/sw.js'))
            worker.evaluate("""() => new Promise((resolve, reject) => {
              const deadline = setTimeout(() => reject(new Error('Waiting service worker did not activate')), 10000);
              const check = () => {
                if (self.registration.active && new URL(self.registration.active.scriptURL).pathname.endsWith('/sw.js')) {
                  clearTimeout(deadline);
                  resolve(true);
                }
                else setTimeout(check, 25);
              };
              check();
            })""")
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/index.html')
            expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
            page.wait_for_function("navigator.serviceWorker.controller && new URL(navigator.serviceWorker.controller.scriptURL).pathname.endsWith('/sw.js')")
            page.wait_for_function("caches.keys().then(keys => keys.includes('garage-log-v4') && !keys.includes('garage-log-v3'))")
            keys = page.evaluate('caches.keys()')
            assert 'another-app-v1' in keys, keys
            cache_urls = page.evaluate("caches.open('garage-log-v4').then(c => c.keys()).then(reqs => reqs.map(r => r.url))")
            assert not any('/account.html' in url or '/account.js' in url for url in cache_urls), cache_urls
            assert any('/styles.css' in url for url in cache_urls), cache_urls
            assert any('/src/' in url for url in cache_urls), cache_urls
            assert not errors, errors
            assert not live, live
            passed.append('v3 service-worker upgrade, sibling-cache preservation and account exclusions')
            context.close()
            server.stub_config = False
        finally:
            browser.close()
            server.shutdown()
            server.server_close()
    result = {'passed': passed, 'count': len(passed), 'live_database_requests': 0}
    (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'dist')
    parser.add_argument('--output', type=Path, default=Path('/workspace/scratch/skeleton-smoke'))
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    run(parser.parse_args())
