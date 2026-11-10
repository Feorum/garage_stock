"""Build a static Pages site using only public Supabase browser settings."""
import argparse
import base64
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
FILES = ['index.html', 'app.js', 'account.html', 'account.js', 'sw.js',
         'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    url = os.environ.get('SUPABASE_URL', '').rstrip('/')
    key = os.environ.get('SUPABASE_PUBLISHABLE_KEY') or os.environ.get('SUPABASE_ANON_KEY', '')
    if urlsplit(url).scheme != 'https' or not urlsplit(url).hostname or not key:
        raise SystemExit('Set SUPABASE_URL and a public SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY).')
    if not key.startswith('sb_publishable_'):
        try:
            payload = key.split('.')[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
            if claims.get('role') != 'anon':
                raise ValueError()
        except (ValueError, IndexError):
            raise SystemExit('Only a public publishable key or anon JWT may be deployed.')
    output = args.output.resolve()
    if output == ROOT or output in ROOT.parents:
        raise SystemExit('Use a dedicated output directory, not the checkout or its parent.')
    for name in FILES:
        data = (ROOT / name).read_bytes()
        if name in ('app.js', 'account.js'):
            text = data.decode()
            old_url, old_key = "'https://YOUR-PROJECT.supabase.co'", "'YOUR-ANON-PUBLIC-KEY'"
            if text.count(old_url) != 1 or text.count(old_key) != 1:
                raise SystemExit(f'{name}: expected exactly one public configuration placeholder pair.')
            data = text.replace(old_url, json.dumps(url)).replace(old_key, json.dumps(key)).encode()
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (output / '.nojekyll').write_text('')
    print(f'Built {len(FILES)} public site files in {output}; no private keys or database seed files included.')


if __name__ == '__main__':
    main()
