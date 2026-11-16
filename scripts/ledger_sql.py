"""Prepare resumable, private SQL batches from a reviewed ledger import payload."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import uuid

ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = uuid.UUID('62adbb3d-9889-4ba4-98fd-cbfc695bd88c')


def literal(value):
    return "E'" + str(value).replace('\\', '\\\\').replace("'", "''") + "'"


def json_sql(value):
    return literal(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)) + '::jsonb'


def prepare(payload, output):
    output = output.resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError('Private import batches must be stored outside the checkout.')
    sha = payload['source']['sha256']
    if not re.fullmatch('[0-9a-f]{64}', sha):
        raise ValueError('The source needs a valid SHA-256 fingerprint.')
    batch_id = str(uuid.uuid5(NAMESPACE, sha))
    output.mkdir(parents=True, exist_ok=True)
    chunks = []

    def write(kind, sql):
        name = f'{len(chunks):04d}-{kind}.sql'
        (output / name).write_text(sql, encoding='utf-8')
        chunks.append(name)

    source = payload['source']
    metadata = {'source': source, 'warnings': payload.get('warnings', []), 'workbook': payload.get('metadata', {}),
                'operator': 'Codex user-approved administrative import', 'format_version': payload['format_version']}
    write('import', 'insert into garage_ledger.imports(id,name,filename,source_sha256,metadata) values ('
          + ','.join([literal(batch_id), literal(source['name']), literal(source['name']), literal(sha), json_sql(metadata)])
          + ') on conflict(id) do nothing;')
    manifest = {'import_id': batch_id, 'source_sha256': sha, 'sheets': [], 'row_count': 0, 'cell_count': 0}
    for sheet in payload['sheets']:
        sheet_id = str(uuid.uuid5(uuid.UUID(batch_id), sheet['key']))
        meta = dict(sheet['metadata'], kind=sheet['kind'])
        write('sheet', 'insert into garage_ledger.sheets(id,import_id,sheet_key,name,sort,state,metadata) values ('
              + ','.join([literal(sheet_id), literal(batch_id), literal(sheet['key']), literal(sheet['name']),
                          str(int(sheet['index'])), literal(sheet['visibility']), json_sql(meta)])
              + ') on conflict(id) do nothing;')
        source_rows = sheet['rows']
        manifest['sheets'].append({'id': sheet_id, 'name': sheet['name'], 'rows': len(source_rows)})
        manifest['row_count'] += len(source_rows)
        manifest['cell_count'] += sum(len(row['cells']) for row in source_rows)
        pending = []

        def flush():
            if not pending:
                return
            sql = ('with source as (select ' + json_sql(pending) + ' as payload) '
                   'insert into garage_ledger.rows(id,sheet_id,source_row,section,position,original_section,original_cells,cells,metadata) '
                   'select x.id,' + literal(sheet_id) + '::uuid,x.source_row,x.section,x.source_row,x.section,x.cells,x.cells,x.metadata '
                   'from source,jsonb_to_recordset(source.payload) as x(id uuid,source_row integer,section text,cells jsonb,metadata jsonb) '
                   'on conflict(id) do nothing;')
            write('rows', sql)
            pending.clear()

        for row in source_rows:
            normalized = {'id': str(uuid.uuid5(uuid.UUID(sheet_id), str(row['source_row']))),
                          'source_row': row['source_row'], 'section': row['section'],
                          'cells': row['cells'], 'metadata': row.get('metadata', {})}
            if pending and len(json.dumps([*pending, normalized], ensure_ascii=False)) > 36000:
                flush()
            pending.append(normalized)
        flush()
    verification = (
        'do $verify$ declare actual_rows integer; actual_cells integer; actual_sheets integer; begin '
        'select count(*),coalesce(sum((select count(*) from jsonb_object_keys(r.original_cells))),0) '
        'into actual_rows,actual_cells from garage_ledger.rows r join garage_ledger.sheets s on s.id=r.sheet_id '
        f'where s.import_id={literal(batch_id)}::uuid; '
        f'select count(*) into actual_sheets from garage_ledger.sheets where import_id={literal(batch_id)}::uuid; '
        f'if actual_rows<>{manifest["row_count"]} or actual_cells<>{manifest["cell_count"]} '
        f'or actual_sheets<>{len(payload["sheets"])} then raise exception \'Ledger import counts do not match.\'; end if; '
        'perform garage_ledger.validate_cells(r.cells) from garage_ledger.rows r join garage_ledger.sheets s on s.id=r.sheet_id '
        f'where s.import_id={literal(batch_id)}::uuid; '
        f'update garage_ledger.imports set status=\'ready\' where id={literal(batch_id)}::uuid; '
        'end $verify$;')
    write('activate', verification)
    manifest['chunks'] = chunks
    (output / 'manifest.private.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('payload', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    snapshot = json.loads(args.payload.with_name('snapshot-manifest.private.json').read_text(encoding='utf-8'))
    if hashlib.sha256(args.payload.read_bytes()).hexdigest() != snapshot['payload_sha256']:
        raise ValueError('The private payload differs from its immutable snapshot manifest.')
    backup = args.payload.with_name(snapshot['source_backup'])
    if backup.parent != args.payload.parent or hashlib.sha256(backup.read_bytes()).hexdigest() != snapshot['source_sha256']:
        raise ValueError('The original workbook backup differs from its fingerprint.')
    payload = json.loads(args.payload.read_text(encoding='utf-8'))
    if payload['source']['sha256'] != snapshot['source_sha256']:
        raise ValueError('The payload and original workbook fingerprints do not agree.')
    manifest = prepare(payload, args.output)
    print(json.dumps({key: manifest[key] for key in ['import_id', 'row_count', 'cell_count']})
          + f' ({len(manifest["chunks"])} private SQL batches prepared)')


if __name__ == '__main__':
    main()
