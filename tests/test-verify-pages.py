"""Synthetic release integrity checks; no HTTP or production database calls."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('garage_verify_pages', ROOT / 'scripts/verify-pages.py')
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
COMMIT = 'a' * 40
BASE = 'https://site.example.invalid/garage_stock/'


def fixture():
    files = {name: ('Synthetic public asset: ' + name).encode() for name in VERIFY.BUILD.FILES}
    manifest = {'commit': COMMIT, 'cache': 'garage-log-sha-' + COMMIT,
                'assets': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    files['release.json'] = json.dumps(manifest).encode()
    return files, manifest


def reader(files, calls):
    def fetch(url):
        calls.append(url)
        assert url.startswith(BASE), 'A release check left the configured site.'
        return files[urlsplit(url).path.removeprefix('/garage_stock/')]
    return fetch


class VerifyPagesTests(unittest.TestCase):
    def test_verifies_all_served_assets_and_the_commit(self):
        files, _ = fixture()
        calls = []
        result = VERIFY.verify_release(BASE, COMMIT, reader(files, calls))
        self.assertEqual(result['assets_verified'], len(VERIFY.BUILD.FILES))
        self.assertEqual(result['commit'], COMMIT)
        self.assertTrue(all(url.endswith('?release=' + COMMIT) for url in calls))

    def test_rejects_stale_commit_wrong_cache_and_unexpected_asset_paths(self):
        for change in ('commit', 'cache', 'path'):
            with self.subTest(change=change):
                files, manifest = fixture()
                if change == 'path':
                    manifest['assets']['../schema.sql'] = '0' * 64
                else:
                    manifest[change] = 'wrong'
                files['release.json'] = json.dumps(manifest).encode()
                calls = []
                with self.assertRaises(ValueError):
                    VERIFY.verify_release(BASE, COMMIT, reader(files, calls))
                self.assertEqual(len(calls), 1, 'Invalid metadata must fail before fetching any asset.')

    def test_detects_a_changed_asset_even_with_matching_release_metadata(self):
        files, _ = fixture()
        files['src/orders.js'] = b'Unexpected old or modified JavaScript'
        with self.assertRaisesRegex(ValueError, 'src/orders.js'):
            VERIFY.verify_release(BASE, COMMIT, reader(files, []))

    def test_retries_a_stale_cdn_response_and_then_verifies_the_full_release(self):
        files, manifest = fixture()
        manifest['commit'] = 'b' * 40
        stale = json.dumps(manifest).encode()
        calls, pauses = [], []
        normal = reader(files, calls)

        def fetch(url):
            if not calls:
                calls.append(url)
                return stale
            return normal(url)

        with contextlib.redirect_stdout(io.StringIO()):
            result = VERIFY.verify_with_retry(BASE, COMMIT, 2, 0, fetch, pauses.append)
        self.assertEqual(result['assets_verified'], len(VERIFY.BUILD.FILES))
        self.assertEqual(pauses, [0])

    def test_unsafe_urls_fail_without_a_request(self):
        for url in ('http://site.example.invalid/', 'https://user:password@site.example.invalid/',
                    BASE + '?token=value', BASE + '#section'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                VERIFY.verify_release(url, COMMIT, lambda _: self.fail('Unexpected HTTP request'))


if __name__ == '__main__':
    unittest.main()
