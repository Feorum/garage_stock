"""Release build checks using only synthetic public configuration."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / 'scripts' / 'build-pages.py'
SHA_A = 'a' * 40
SHA_B = 'b' * 40
PUBLIC_KEY = 'sb_publishable_synthetic_build_test_12345'


class ReleaseBuildTests(unittest.TestCase):
    def build(self, output, release=None, env_changes=None):
        env = {key: value for key, value in os.environ.items() if key not in (
            'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'GARAGE_RELEASE_SHA')}
        env.update(SUPABASE_URL='https://synthetic-build.supabase.co', SUPABASE_PUBLISHABLE_KEY=PUBLIC_KEY)
        env.update(env_changes or {})
        command = [sys.executable, str(BUILDER), '--output', str(output)]
        if release is not None:
            command += ['--release', release]
        return subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True)

    def successful(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(PUBLIC_KEY, result.stdout + result.stderr)

    @staticmethod
    def contents(output):
        return {path.relative_to(output).as_posix(): path.read_bytes()
                for path in output.rglob('*') if path.is_file()}

    def test_release_build_is_reproducible_and_manifest_matches_all_public_assets(self):
        with tempfile.TemporaryDirectory(prefix='garage-release-test-') as directory:
            first, second = Path(directory) / 'first', Path(directory) / 'second'
            self.successful(self.build(first, SHA_A))
            self.successful(self.build(second, SHA_A))
            files = self.contents(first)
            self.assertEqual(files, self.contents(second))
            manifest = json.loads(files['release.json'])
            self.assertEqual(manifest['commit'], SHA_A)
            self.assertEqual(manifest['cache'], 'garage-log-sha-' + SHA_A)
            self.assertEqual(set(files), set(manifest['assets']) | {'release.json', '.nojekyll'})
            for name, digest in manifest['assets'].items():
                self.assertEqual(digest, hashlib.sha256(files[name]).hexdigest(), name)
            self.assertIn(('"sha-' + SHA_A + '"').encode(), files['sw.js'])
            self.assertTrue(all(not path.startswith(('tests/', 'supabase/', '.github/'))
                                and Path(path).suffix not in ('.sql', '.xlsx', '.env') for path in files))
            self.assertIn(PUBLIC_KEY.encode(), files['src/supabase.js'])
            self.assertNotIn(b'YOUR-PROJECT', files['src/supabase.js'])

    def test_new_commit_changes_cache_while_application_assets_remain_unchanged(self):
        with tempfile.TemporaryDirectory(prefix='garage-release-test-') as directory:
            first, second = Path(directory) / 'first', Path(directory) / 'second'
            self.successful(self.build(first, SHA_A))
            self.successful(self.build(second, SHA_B))
            a, b = self.contents(first), self.contents(second)
            changed = {name for name in a if a[name] != b[name]}
            self.assertEqual(changed, {'sw.js', 'release.json'})
            self.assertNotEqual(json.loads(a['release.json'])['cache'], json.loads(b['release.json'])['cache'])

    def test_environment_release_and_local_fallback(self):
        with tempfile.TemporaryDirectory(prefix='garage-release-test-') as directory:
            release, local = Path(directory) / 'release', Path(directory) / 'local'
            self.successful(self.build(release, env_changes={'GARAGE_RELEASE_SHA': SHA_A.upper()}))
            self.assertEqual(json.loads((release / 'release.json').read_text())['commit'], SHA_A)
            self.successful(self.build(local))
            self.assertEqual(json.loads((local / 'release.json').read_text())['cache'], 'garage-log-v8')
            self.assertIsNone(json.loads((local / 'release.json').read_text())['commit'])

    def test_invalid_release_is_rejected_before_output_is_written(self):
        with tempfile.TemporaryDirectory(prefix='garage-release-test-') as directory:
            for index, value in enumerate(('', 'main', 'a' * 39, 'z' * 40, SHA_A + "';alert(1)")):
                with self.subTest(value=value):
                    output = Path(directory) / str(index)
                    result = self.build(output, value)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('full 40-character Git commit SHA', result.stderr)
                    self.assertFalse(output.exists())

    def test_private_configuration_and_mixed_output_are_rejected(self):
        private_claims = json.dumps({'role': 'service_role'}).encode()
        private_key = 'header.' + base64.urlsafe_b64encode(private_claims).decode().rstrip('=') + '.signature'
        with tempfile.TemporaryDirectory(prefix='garage-release-test-') as directory:
            output = Path(directory) / 'private'
            result = self.build(output, SHA_A, {'SUPABASE_PUBLISHABLE_KEY': private_key})
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(private_key, result.stdout + result.stderr)
            self.assertFalse(output.exists())
            mixed = Path(directory) / 'mixed'
            mixed.mkdir()
            marker = mixed / 'private-report.txt'
            marker.write_text('Keep existing user data.')
            result = self.build(mixed, SHA_A)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(marker.read_text(), 'Keep existing user data.')
            self.assertFalse((mixed / 'release.json').exists())


if __name__ == '__main__':
    unittest.main()
