"""Verify a public Pages release without credentials or application data."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

SPEC = importlib.util.spec_from_file_location('garage_pages_build', Path(__file__).with_name('build-pages.py'))
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)
MAX_BYTES = 8 * 1024 * 1024


def public_base(value):
    parts = urlsplit(value)
    if (parts.scheme != 'https' or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment):
        raise ValueError('Use an HTTPS site URL without credentials, query or fragment.')
    return value.rstrip('/') + '/'


def fetch_bytes(url):
    request = Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'Garage-release-verifier'})
    with urlopen(request, timeout=15) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('A public release response exceeded the verification limit.')
    return data


def verify_release(base, commit, fetch=fetch_bytes):
    base = public_base(base)
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Expected commit must be a full lowercase Git SHA.')
    query = '?' + urlencode({'release': commit})
    manifest = json.loads(fetch(base + 'release.json' + query))
    if not isinstance(manifest, dict) or set(manifest) != {'commit', 'cache', 'assets'}:
        raise ValueError('The site has no recognized release manifest.')
    if manifest['commit'] != commit:
        raise ValueError('The site is still serving a different release commit.')
    if manifest['cache'] != 'garage-log-sha-' + commit:
        raise ValueError('The release cache does not match the expected commit.')
    assets = manifest['assets']
    if (not isinstance(assets, dict) or set(assets) != set(BUILD.FILES)
            or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value)
                   for value in assets.values())):
        raise ValueError('The release asset list does not match the public build allowlist.')
    for name, expected in assets.items():
        actual = hashlib.sha256(fetch(base + name + query)).hexdigest()
        if actual != expected:
            raise ValueError(f'The served asset does not match the release: {name}')
    return {'commit': commit, 'assets_verified': len(assets), 'url': base}


def verify_with_retry(base, commit, attempts=12, interval=10, fetch=fetch_bytes, pause=time.sleep):
    public_base(base)
    if not 1 <= attempts <= 30 or not 0 <= interval <= 60:
        raise ValueError('Use 1–30 attempts and an interval of 0–60 seconds.')
    for attempt in range(1, attempts + 1):
        try:
            return verify_release(base, commit, fetch)
        except (OSError, ValueError) as error:
            if attempt == attempts:
                raise
            print(f'Release check {attempt}/{attempts}: {error}', flush=True)
            pause(interval)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--attempts', type=int, default=12)
    parser.add_argument('--interval', type=float, default=10)
    args = parser.parse_args()
    try:
        result = verify_with_retry(args.url, args.commit.lower(), args.attempts, args.interval)
    except (OSError, ValueError) as error:
        raise SystemExit(f'Public release verification failed: {error}') from None
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
