"""Synthetic tests for private SQL batches. No database or source data is used."""

import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from ledger_sql import NAMESPACE, json_sql, literal, prepare


def decode_literal(sql, start=0):
    """Independently decode the PostgreSQL E-string subset emitted by prepare."""
    if sql[start:start + 2] != "E'":
        raise AssertionError('Expected an escape string literal.')
    result, pos = [], start + 2
    while pos < len(sql):
        char = sql[pos]
        if char == "'":
            if sql[pos + 1:pos + 2] == "'":
                result.append("'")
                pos += 2
                continue
            return ''.join(result), pos + 1
        if char == '\\':
            if sql[pos + 1:pos + 2] != '\\':
                raise AssertionError('Unexpected escape interpretation in generated SQL.')
            result.append('\\')
            pos += 2
            continue
        result.append(char)
        pos += 1
    raise AssertionError('Unterminated SQL string literal.')


def sample_payload(row_count=2, large=False):
    hostile = "O'Brien \\new\\x41\\012 literal \\n and newline\n'; select 'synthetic'; -- АБВ"
    cell = {'value': hostile, 'type': 'string', 'formula': None, 'cached': None,
            'format': 'General'}
    rows = []
    for index in range(row_count):
        value = dict(cell, value=hostile + ('x' * 19000 if large else '') + str(index))
        rows.append({'source_row': index + 2, 'section': 'ledger', 'cells': {'A': value},
                     'metadata': {'role': 'entry', 'cell_sources': {'A': {'raw_value': value['value']}}}})
    return {'format_version': 1,
            'source': {'name': "Synthetic O'Brien\\source.xlsx", 'sha256': '0' * 64,
                       'bytes': 0, 'imported_at': '2026-11-16T00:00:00Z'},
            'warnings': [], 'metadata': {'counts': {'sheets': 1}},
            'sheets': [{'key': "Synthetic O'Brien\\tab", 'name': "Synthetic O'Brien\\tab",
                        'index': 0, 'visibility': 'hidden', 'kind': 'monthly',
                        'metadata': {'headers': [{'column': 'A', 'label': 'Synthetic note'}],
                                     'sections': [{'id': 'ledger', 'kind': 'ledger', 'label': 'Entries',
                                                   'start_row': 2, 'end_row': row_count + 1}]},
                        'rows': rows}]}


class LedgerSqlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_escape_literals_and_nested_json_round_trip_without_backslash_changes(self):
        value = "' \\new \\t \\x41 \\012 \\u1234 \\'\n Unicode АБВ"
        decoded, end = decode_literal(literal(value))
        self.assertEqual(decoded, value)
        self.assertEqual(end, len(literal(value)))
        data = {'value': value, 'formula': "='O''Brien'!B2", 'nested': [False, 0, None]}
        sql = json_sql(data)
        decoded, end = decode_literal(sql)
        self.assertEqual(sql[end:], '::jsonb')
        self.assertEqual(json.loads(decoded), data)

    def test_prepared_rows_preserve_quotes_backslashes_source_cells_and_metadata(self):
        payload = sample_payload()
        manifest = prepare(payload, self.directory / 'sql')
        rows_file = next(name for name in manifest['chunks'] if name.endswith('-rows.sql'))
        sql = (self.directory / 'sql' / rows_file).read_text(encoding='utf-8')
        decoded, end = decode_literal(sql, sql.index("E'"))
        prepared_rows = json.loads(decoded)
        self.assertEqual(prepared_rows[0]['cells'], payload['sheets'][0]['rows'][0]['cells'])
        self.assertEqual(prepared_rows[0]['metadata'], payload['sheets'][0]['rows'][0]['metadata'])
        self.assertTrue(sql[end:].startswith('::jsonb as payload'))
        self.assertIn('x.cells,x.cells,x.metadata', sql)
        self.assertTrue(sql.endswith('on conflict(id) do nothing;'))
        import_sql = (self.directory / 'sql' / manifest['chunks'][0]).read_text(encoding='utf-8')
        import_metadata = json.loads(decode_literal(import_sql, import_sql.index("E'{"))[0])
        self.assertEqual(import_metadata['workbook'], payload['metadata'])

    def test_repeated_preparation_is_byte_identical_and_ids_are_stable(self):
        payload = sample_payload(5, large=True)
        out = self.directory / 'sql'
        first = prepare(payload, out)
        files = {name: (out / name).read_bytes() for name in first['chunks']}
        second = prepare(copy.deepcopy(payload), out)
        self.assertEqual(first, second)
        self.assertEqual(files, {name: (out / name).read_bytes() for name in second['chunks']})
        expected_import = uuid.uuid5(NAMESPACE, payload['source']['sha256'])
        expected_sheet = uuid.uuid5(expected_import, payload['sheets'][0]['key'])
        self.assertEqual(first['import_id'], str(expected_import))
        self.assertEqual(first['sheets'][0]['id'], str(expected_sheet))
        self.assertEqual((first['row_count'], first['cell_count']), (5, 5))
        rows = []
        for name in first['chunks']:
            if name.endswith('-rows.sql'):
                sql = (out / name).read_text(encoding='utf-8')
                rows.extend(json.loads(decode_literal(sql, sql.index("E'"))[0]))
        self.assertGreater(sum(name.endswith('-rows.sql') for name in first['chunks']), 1)
        self.assertEqual([r['id'] for r in rows], [str(uuid.uuid5(expected_sheet, str(i))) for i in range(2, 7)])
        self.assertTrue(first['chunks'][0].endswith('-import.sql'))
        self.assertTrue(first['chunks'][-1].endswith('-activate.sql'))
        activation = (out / first['chunks'][-1]).read_text(encoding='utf-8')
        self.assertIn('actual_rows<>5', activation)
        self.assertLess(activation.index('raise exception'), activation.index("status='ready'"))

    def test_checkout_output_and_invalid_source_fingerprint_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            prepare(sample_payload(), ROOT / 'private-test-output')
        self.assertFalse((ROOT / 'private-test-output').exists())
        payload = sample_payload()
        payload['source']['sha256'] = "invalid'; select 1; --"
        out = self.directory / 'invalid'
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            prepare(payload, out)
        self.assertFalse(out.exists())

    def snapshot(self):
        backup = self.directory / 'source.xlsx'
        backup.write_bytes(b'Synthetic immutable source bytes. Not a real workbook.')
        digest = hashlib.sha256(backup.read_bytes()).hexdigest()
        payload = sample_payload()
        payload['source']['sha256'] = digest
        path = self.directory / 'main-workbook.private.json'
        path.write_text(json.dumps(payload), encoding='utf-8')
        manifest = {'source_sha256': digest, 'source_backup': backup.name,
                    'payload_sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        (self.directory / 'snapshot-manifest.private.json').write_text(json.dumps(manifest), encoding='utf-8')
        return path, backup

    def run_cli(self, path):
        return subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / 'ledger_sql.py'),
                               str(path), '--output', str(self.directory / 'cli-sql')],
                              capture_output=True, text=True, encoding='utf-8', cwd=ROOT, timeout=10)

    def test_cli_accepts_verified_snapshot(self):
        path, backup = self.snapshot()
        result = self.run_cli(path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.directory / 'cli-sql' / 'manifest.private.json').is_file())

    def test_cli_rejects_changed_payload_before_writing_batches(self):
        path, backup = self.snapshot()
        path.write_text('{}', encoding='utf-8')
        result = self.run_cli(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('immutable snapshot manifest', result.stderr)
        self.assertFalse((self.directory / 'cli-sql').exists())

    def test_cli_rejects_changed_source_backup_before_writing_batches(self):
        path, backup = self.snapshot()
        backup.write_bytes(b'Changed synthetic source bytes.')
        result = self.run_cli(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('workbook backup differs', result.stderr)
        self.assertFalse((self.directory / 'cli-sql').exists())

    def test_cli_rejects_payload_source_hash_mismatch_with_valid_payload_digest(self):
        path, backup = self.snapshot()
        payload = json.loads(path.read_text(encoding='utf-8'))
        payload['source']['sha256'] = 'f' * 64
        path.write_text(json.dumps(payload), encoding='utf-8')
        manifest_path = self.directory / 'snapshot-manifest.private.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest['payload_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        self.assertEqual(hashlib.sha256(backup.read_bytes()).hexdigest(), manifest['source_sha256'])
        result = self.run_cli(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('payload and original workbook fingerprints do not agree', result.stderr)
        self.assertFalse((self.directory / 'cli-sql').exists())


if __name__ == '__main__':
    unittest.main()
