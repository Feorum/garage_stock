"""Build the allowlisted static site using only public Supabase configuration."""
import argparse
import base64
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    'index.html', 'styles.css', 'app.js', 'account.html', 'account.js', 'sw.js',
    'src/supabase.js', 'src/auth.js', 'src/ui.js', 'src/navigation.js',
    'src/views.js', 'src/orders.js', 'src/sheets.js', 'src/catalogue.js', 'manifest.webmanifest',
    'icons/icon-192.png', 'icons/icon-512.png',
)
CONFIG_FILE = 'src/supabase.js'
PUBLIC_OUTPUT = frozenset((*FILES, '.nojekyll'))


def browser_configuration():
    url = os.environ.get('SUPABASE_URL', '').rstrip('/')
    key = os.environ.get('SUPABASE_PUBLISHABLE_KEY') or os.environ.get('SUPABASE_ANON_KEY', '')
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment or not key):
        raise SystemExit('Set SUPABASE_URL to an HTTPS origin and a public SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY).')
    if re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', key):
        return url, key
    try:
        parts = key.split('.')
        if len(parts) != 3 or any(not part for part in parts) or any(c.isspace() for c in key):
            raise ValueError()
        payload = parts[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        if claims.get('role') != 'anon':
            raise ValueError()
    except (ValueError, AttributeError, UnicodeDecodeError):
        raise SystemExit('Only a public publishable key or anon JWT may be deployed.') from None
    return url, key


def public_files(url, key):
    assets = {}
    for name in FILES:
        data = (ROOT / name).read_bytes()
        if name == CONFIG_FILE:
            source = data.decode()
            old_url, old_key = "'https://YOUR-PROJECT.supabase.co'", "'YOUR-ANON-PUBLIC-KEY'"
            if source.count(old_url) != 1 or source.count(old_key) != 1:
                raise SystemExit(f'{name}: expected exactly one public configuration placeholder pair.')
            data = source.replace(old_url, json.dumps(url)).replace(old_key, json.dumps(key)).encode()
        if name.endswith(('.js', '.html', '.css')) and (
                b'YOUR-PROJECT.supabase.co' in data or b'YOUR-ANON-PUBLIC-KEY' in data):
            raise SystemExit(f'{name}: unresolved public configuration placeholder.')
        assets[name] = data
    return assets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    url, key = browser_configuration()
    output = args.output.resolve()
    if (output == ROOT or output in ROOT.parents
            or any(output == ROOT / name or output in (ROOT / name).parents for name in FILES)):
        raise SystemExit('Use a dedicated output directory, not the checkout or a source directory.')
    if output.exists():
        if not output.is_dir() or any(path.is_symlink() for path in output.rglob('*')):
            raise SystemExit('Use a dedicated output directory containing no symbolic links.')
        unexpected = [path.relative_to(output).as_posix() for path in output.rglob('*')
                      if path.is_file() and path.relative_to(output).as_posix() not in PUBLIC_OUTPUT]
        if unexpected:
            raise SystemExit('Output contains files outside the public build allowlist; use a new empty directory.')
    assets = public_files(url, key)
    for name, data in assets.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (output / '.nojekyll').write_text('')
    print(f'Built {len(FILES)} public site files in {output}; no private keys or database seed files included.')


if __name__ == '__main__':
    main()
