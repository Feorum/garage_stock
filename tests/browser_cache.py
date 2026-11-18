"""Exercise a tab across a real upgrade and rollback, on the loopback test server."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

from playwright.sync_api import expect

BASELINE = '5b89aa5ece5dc3ff65e262c194338cf326ac5ed5'
ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def legacy_build():
    with tempfile.TemporaryDirectory(prefix='garage-legacy-pages-') as directory:
        checkout = Path(directory)
        paths = ['scripts/build-pages.py', 'index.html', 'account.html', 'account.js', 'app.js',
                 'src', 'icons', 'styles.css', 'ledger.css', 'sw.js', 'manifest.webmanifest']
        archive = checkout / 'baseline.tar'
        subprocess.run(['git', 'archive', '--format=tar', '--output', str(archive), BASELINE, '--', *paths],
                       cwd=ROOT, check=True)
        with tarfile.open(archive) as files:
            files.extractall(checkout, filter='data')
        env = {**os.environ, 'SUPABASE_URL': 'https://baseline.invalid',
               'SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_legacy_fixture'}
        env.pop('GARAGE_RELEASE_SHA', None)
        subprocess.run([sys.executable, str(checkout / 'scripts/build-pages.py')], cwd=checkout, env=env,
                       check=True, stdout=subprocess.DEVNULL)
        yield checkout / 'dist'


def check_cache_upgrade(browser, server, base, new_page, cache_name):
    current = Path(server.RequestHandlerClass.keywords['directory'])
    with legacy_build() as legacy:
        old_cache = json.loads((legacy / 'release.json').read_text())['cache']
        context = None
        try:
            server.release_root = legacy
            server.stub_config = True
            context, tab, errors, live = new_page(browser, {'signedIn': False}, service_workers='allow')
            tab.goto(base + '/index.html')
            expect(tab.get_by_role('button', name='Войти', exact=True)).to_be_visible()
            tab.evaluate('navigator.serviceWorker.ready')
            tab.reload()
            tab.wait_for_function('navigator.serviceWorker.controller !== null')
            observer = context.new_page()
            # Outside the worker's scope, so its open page never blocks activation.
            observer.goto(base.rsplit('/', 1)[0] + '/')
            observer.evaluate("caches.open('another-app-v1').then(cache => cache.put('/sibling', new Response('keep')))")
            for directory, retiring, incoming in [(current, old_cache, cache_name), (legacy, cache_name, old_cache)]:
                server.release_root = directory
                tab.evaluate("navigator.serviceWorker.getRegistration().then(reg => reg.update())")
                tab.wait_for_function("navigator.serviceWorker.getRegistration().then(reg => !!reg.waiting)")
                # The old tab still owns its complete version while the replacement waits.
                assert tab.evaluate('name => caches.has(name)', retiring)
                expect(tab.get_by_role('button', name='Войти', exact=True)).to_be_visible()
                tab.close()
                observer.wait_for_function("""async ([current, previous]) =>
                    await caches.has(current) && !await caches.has(previous)""", arg=[incoming, retiring])
                tab = context.new_page()
                tab.on('pageerror', lambda error: errors.append(str(error)))
                tab.goto(base + '/index.html')
                expect(tab.get_by_role('button', name='Войти', exact=True)).to_be_visible()
                tab.wait_for_function('navigator.serviceWorker.controller !== null')
                if incoming == cache_name:
                    urls = tab.evaluate("name => caches.open(name).then(c => c.keys()).then(keys => keys.map(r => new URL(r.url).pathname))", incoming)
                    assert any('/assets/' in path and path.endswith('.css') for path in urls), urls
                    assert '/garage_stock/sdk.js' in urls
                    assert not any('account' in path or 'release.json' in path for path in urls), urls
                    tab.evaluate("""async () => { await fetch('./account.html?code=synthetic');
                        await fetch('./release.json'); await fetch('./index.html?token_hash=synthetic'); }""")
                    assert not tab.evaluate("name => caches.open(name).then(c => c.keys()).then(keys => keys.some(r => r.url.includes('?') || r.url.endsWith('/release.json')))", incoming)
                    context.set_offline(True)
                    try:
                        tab.reload()
                        expect(tab.get_by_role('button', name='Войти', exact=True)).to_be_visible()
                        assert tab.evaluate("""async () => {
                          const results = await Promise.allSettled([
                            fetch('./account.html?code=synthetic', {cache: 'no-store'}),
                            fetch('./index.html', {headers: {Authorization: 'Bearer synthetic'}, cache: 'no-store'})
                          ]);
                          return results.every(result => result.status === 'rejected');
                        }"""), 'Private or authorization-bearing requests must bypass the offline shell'
                    finally:
                        context.set_offline(False)
            assert observer.evaluate("caches.has('another-app-v1')")
            assert not errors, errors
            assert not live, live
        finally:
            if context:
                context.close()
            server.stub_config = False
            server.release_root = current
