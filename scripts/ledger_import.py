#!/usr/bin/env python3
"""Create a private, immutable XLSX source backup and typed-cell import payload.

This tool performs no network requests, application writes or formula evaluation.
Usage: python scripts/ledger_import.py SOURCE.xlsx --output-directory PRIVATE_DIR
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path

from ledger_sections import classify_sheet
from ledger_xlsx import XlsxReader


ROOT = Path(__file__).resolve().parents[1]
FORMAT_VERSION = 1


def checksum(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build_payload(source, imported_at=None):
    source = Path(source).resolve(strict=True)
    digest = checksum(source)
    reader = XlsxReader(source)
    try:
        sheets = []
        for index, source_sheet in enumerate(reader.sheet_list()):
            sheet = reader.read_sheet(source_sheet, index)
            classify_sheet(sheet)
            sheets.append(sheet)
        metadata = reader.workbook_metadata()
        metadata['formula_function_counts'] = dict(reader.function_counts)
    finally:
        reader.close()
    if checksum(source) != digest:
        raise ValueError('Source workbook changed during import. No snapshot was written.')
    cells = [cell for sheet in sheets for row in sheet['rows'] for cell in row['cells'].values()]
    metadata['counts'] = {'sheets': len(sheets), 'rows': sum(len(s['rows']) for s in sheets),
                          'populated_cells': len(cells),
                          'formula_cells': sum('formula_attributes' in c for sheet in sheets for row in sheet['rows']
                                               for c in row['metadata']['cell_sources'].values()),
                          'cached_errors': sum(c['type'] == 'error' for c in cells),
                          'sheet_kinds': dict(Counter(s['kind'] for s in sheets)),
                          'sheet_visibility': dict(Counter(s['visibility'] for s in sheets))}
    warnings = [{'code': 'cached_source_snapshot',
                 'message': 'Values are the workbook source cache. Formulas were preserved and were not recalculated.'}]
    errors = metadata['counts']['cached_errors']
    if errors:
        warnings.append({'code': 'source_cached_errors', 'count': errors,
                         'message': 'Source error values are retained. Inspect sheet warnings and cell coordinates.'})
    return {'format_version': FORMAT_VERSION,
            'source': {'name': source.name, 'sha256': digest, 'bytes': source.stat().st_size,
                       'imported_at': imported_at or datetime.now(timezone.utc).isoformat()},
            'sheets': sheets, 'warnings': warnings, 'metadata': metadata}


def ensure_private_directory(directory):
    directory = Path(directory).expanduser().resolve()
    if directory == ROOT or ROOT in directory.parents:
        raise ValueError('Private ledger snapshots must be outside the repository.')
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def write_exclusive(path, data):
    """Never overwrite source snapshots or previously reviewed import payloads."""
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    path.chmod(0o444)


def create_snapshot(source, output_directory):
    source = Path(source).resolve(strict=True)
    directory = ensure_private_directory(output_directory)
    payload_path = directory / 'main-workbook.private.json'
    manifest_path = directory / 'snapshot-manifest.private.json'
    digest = checksum(source)
    backup = directory / f'source-{digest}.xlsx'
    if payload_path.exists():
        if not manifest_path.exists():
            raise ValueError('Existing payload has no integrity manifest. Choose a new private directory.')
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if manifest.get('payload_sha256') != checksum(payload_path):
            raise ValueError('Existing payload changed after snapshot creation.')
        payload = json.loads(payload_path.read_text(encoding='utf-8'))
        if payload.get('source', {}).get('sha256') != digest:
            raise FileExistsError('Directory contains another workbook snapshot. Choose a new private directory.')
        if not backup.is_file() or checksum(backup) != digest:
            raise ValueError('Existing snapshot source backup is missing or changed.')
        return payload, payload_path, backup
    payload = build_payload(source)
    if backup.exists():
        if checksum(backup) != digest:
            raise ValueError('Existing source backup does not match the workbook checksum.')
    else:
        write_exclusive(backup, source.read_bytes())
    if checksum(backup) != digest:
        raise ValueError('Source backup verification failed. Import payload was not written.')
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    write_exclusive(payload_path, encoded)
    manifest = {'format_version': 1, 'source_sha256': digest,
                'payload_sha256': hashlib.sha256(encoded).hexdigest(),
                'source_backup': backup.name, 'payload': payload_path.name}
    write_exclusive(manifest_path, json.dumps(manifest, indent=2).encode('utf-8'))
    return payload, payload_path, backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output-directory', type=Path, required=True,
                        help='Private backup directory outside the repository. Existing snapshots are never replaced.')
    args = parser.parse_args()
    payload, payload_path, backup = create_snapshot(args.source, args.output_directory)
    print(json.dumps({'payload': str(payload_path), 'source_backup': str(backup),
                      'source_sha256': payload['source']['sha256'],
                      'counts': payload['metadata']['counts']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
