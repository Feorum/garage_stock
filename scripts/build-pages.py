"""Bundle the two Garage entries, then publish only their validated public assets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ICONS = {'icons/icon-192.png', 'icons/icon-512.png'}
STATIC = {'index.html', 'account.html', 'manifest.webmanifest', 'sdk.js', 'sw.js'} | ICONS
BUNDLE_NAME = re.compile(r'assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:css|js|woff2)')


def public_asset(name):
    return isinstance(name, str) and (name in STATIC or BUNDLE_NAME.fullmatch(name) is not None)


def release_identity(value):
    if value is None:
        return None
    if not re.fullmatch(r'[0-9a-fA-F]{40}', value):
        raise SystemExit('Release must be a full 40-character Git commit SHA.')
    return value.lower()


def entry_files(manifest, *entries):
    """Collect both static and lazy dependencies from Vite's private build manifest."""
    pending = list(entries)
    visited, files = set(), set()
    while pending:
        key = pending.pop()
        if key in visited:
            continue
        visited.add(key)
        item = manifest[key]
        files.add(item['file'])
        files.update(item.get('css', []))
        files.update(item.get('assets', []))
        pending.extend(item.get('imports', []))
        pending.extend(item.get('dynamicImports', []))
    if not all(public_asset(name) for name in files):
        raise SystemExit('Unexpected asset outside the public bundle format.')
    return files


def bundle(staging, release):
    vite = ROOT / 'node_modules' / 'vite' / 'bin' / 'vite.js'
    if not vite.is_file():
        raise SystemExit('Run npm ci to install the locked frontend tools before building.')
    result = subprocess.run(['node', str(vite), 'build', '--outDir', str(staging), '--emptyOutDir'], cwd=ROOT)
    if result.returncode:
        raise SystemExit(result.returncode)
    manifest = json.loads((staging / '.vite/manifest.json').read_text())
    shell = entry_files(manifest, 'index.html', 'src/supabase.js') | {'index.html', 'manifest.webmanifest'} | ICONS
    public = shell | entry_files(manifest, 'account.html') | STATIC
    generated = {path.relative_to(staging).as_posix() for path in staging.rglob('*') if path.is_file()}
    if generated - public - {'.vite/manifest.json'}:
        raise SystemExit('Unexpected build output outside the public entry graphs.')
    for icon in ICONS:
        (staging / icon).parent.mkdir(exist_ok=True)
        (staging / icon).write_bytes((ROOT / icon).read_bytes())
    assets = {name: (staging / name).read_bytes() for name in sorted(public - {'sw.js'})}
    # Local rebuilds also get a new cache when a bundled module or public setting changes.
    worker = (ROOT / 'sw.js').read_text()
    digest = hashlib.sha256(worker.encode())
    for name in sorted(shell):
        digest.update(name.encode())
        digest.update(hashlib.sha256(assets[name]).digest())
    version = 'sha-' + release if release else 'local-' + digest.hexdigest()[:16]
    worker = worker.replace("'__GARAGE_RELEASE__'", json.dumps(version))
    worker = worker.replace('__GARAGE_SHELL__', json.dumps(['./'] + ['./' + path for path in sorted(shell)]))
    assets['sw.js'] = worker.encode()
    digests = {name: hashlib.sha256(data).hexdigest() for name, data in assets.items()}
    metadata = {'commit': release, 'cache': 'garage-log-' + version, 'assets': digests}
    assets['release.json'] = (json.dumps(metadata, indent=2, sort_keys=True) + '\n').encode()
    assets['.nojekyll'] = b''
    return assets


def previous_files(output):
    if not output.exists():
        return set()
    if not output.is_dir() or any(path.is_symlink() for path in output.rglob('*')):
        raise SystemExit('Use a dedicated output directory without symbolic links.')
    existing = {path.relative_to(output).as_posix() for path in output.rglob('*') if path.is_file()}
    if not existing:
        return existing
    try:
        old = json.loads((output / 'release.json').read_text())['assets']
    except (OSError, ValueError, KeyError, TypeError):
        old = None
    if not isinstance(old, dict) or existing != set(old) | {'.nojekyll', 'release.json'}:
        raise SystemExit('Use a new empty directory or an existing Garage bundle for output.')
    for name, digest in old.items():
        # An existing pre-Vite dist can be rebuilt in place. Only retire prior
        # generated files whose content still matches its recorded release.
        legacy = name in {'styles.css', 'ledger.css', 'app.js', 'account.js'} or re.fullmatch(r'src/[a-z0-9-]+\.js', name)
        if (not public_asset(name) and not legacy) or hashlib.sha256((output / name).read_bytes()).hexdigest() != digest:
            raise SystemExit('Output contains files outside its recorded release. Use a new empty directory.')
    return existing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    parser.add_argument('--release', default=os.environ.get('GARAGE_RELEASE_SHA'))
    args = parser.parse_args()
    release = release_identity(args.release)
    output = args.output.resolve()
    if output == ROOT or output in ROOT.parents or args.output.is_symlink():
        raise SystemExit('Use a dedicated output directory.')
    previous = previous_files(output)
    with tempfile.TemporaryDirectory(prefix='garage-vite-build-') as temporary:
        assets = bundle(Path(temporary), release)
    # Vite never runs emptyOutDir on a user-supplied directory.
    for name, data in assets.items():
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    for name in previous - assets.keys():
        (output / name).unlink()
    print(f'Built {len(assets)} public files in {output}.')


if __name__ == '__main__':
    main()
