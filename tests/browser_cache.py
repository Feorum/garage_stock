"""Synthetic service-worker lifecycle checks shared by the browser smoke suite."""
from urllib.parse import urlsplit

from playwright.sync_api import expect


def check_cache_upgrade(browser, server, base, new_page, cache_name):
    server.stub_config = True
    context = None
    try:
        context, page, errors, live = new_page(browser, {'signedIn': False}, service_workers='allow')
        legacy = """
          self.addEventListener('install', event => {
            event.waitUntil(caches.open('garage-log-v5').then(cache =>
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
        expect(page.get_by_role('button', name='Войти', exact=True)).to_be_visible()
        # Wait for old controlled tabs to close before changing their module graph.
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
        expect(page.get_by_role('button', name='Войти', exact=True)).to_be_visible()
        page.wait_for_function("navigator.serviceWorker.controller && new URL(navigator.serviceWorker.controller.scriptURL).pathname.endsWith('/sw.js')")
        page.wait_for_function("name => caches.keys().then(keys => keys.includes(name) && !keys.includes('garage-log-v5'))", arg=cache_name)
        keys = page.evaluate('caches.keys()')
        assert 'another-app-v1' in keys, keys
        cache_urls = page.evaluate("name => caches.open(name).then(c => c.keys()).then(reqs => reqs.map(r => r.url))", cache_name)
        assert not any('/account.html' in url or '/account.js' in url for url in cache_urls), cache_urls
        assert not any('/release.json' in url for url in cache_urls), cache_urls
        assert any('/styles.css' in url for url in cache_urls), cache_urls
        assert any('/src/' in url for url in cache_urls), cache_urls
        assert not errors, errors
        assert not live, live
    finally:
        if context:
            context.close()
        server.stub_config = False
