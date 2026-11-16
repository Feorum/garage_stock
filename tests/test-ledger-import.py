"""Synthetic XLSX coverage for data retention, source boundaries and backups."""

from datetime import datetime
import base64
import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from openpyxl.utils.datetime import to_excel


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from ledger_import import build_payload, checksum, create_snapshot, ensure_private_directory


NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'


def c(address, value=None, *, kind='n', style=0, formula=None, shared=None):
    node = ET.Element('c', {'r': address, 't': kind, 's': str(style)})
    if formula is not None or shared is not None:
        f = ET.SubElement(node, 'f', shared or {})
        f.text = formula
    if kind == 'inlineStr':
        ET.SubElement(ET.SubElement(node, 'is'), 't').text = value
    elif value is not None:
        ET.SubElement(node, 'v').text = str(value)
    return node


def fixture(path, sheets, *, epoch_1904=False):
    """Handwritten synthetic ZIP fixture: no source workbook data is included."""
    book = ET.Element('workbook', {'xmlns': NS,
                      'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'})
    ET.SubElement(book, 'workbookPr', {'date1904': str(int(epoch_1904))})
    tabs = ET.SubElement(book, 'sheets')
    relationships = ET.Element('Relationships', {'xmlns': 'http://schemas.openxmlformats.org/package/2006/relationships'})
    with ZipFile(path, 'w') as archive:
        archive.writestr('xl/styles.xml', f'<styleSheet xmlns="{NS}"><numFmts count="1">'
            '<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2">'
            '<xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>')
        for index, (name, visibility, rows) in enumerate(sheets, 1):
            ET.SubElement(tabs, 'sheet', {'name': name, 'sheetId': str(index),
                          'r:id': f'rId{index}', 'state': visibility})
            ET.SubElement(relationships, 'Relationship', {'Id': f'rId{index}',
                          'Target': f'worksheets/sheet{index}.xml'})
            sheet = ET.Element('worksheet', {'xmlns': NS})
            data = ET.SubElement(sheet, 'sheetData')
            for number, cells in rows:
                row = ET.SubElement(data, 'row', {'r': str(number)})
                row.extend(cells)
            ET.SubElement(ET.SubElement(sheet, 'mergeCells'), 'mergeCell', {'ref': 'H1:I1'})
            archive.writestr(f'xl/worksheets/sheet{index}.xml', ET.tostring(sheet))
        archive.writestr('xl/workbook.xml', ET.tostring(book))
        archive.writestr('xl/_rels/workbook.xml.rels', ET.tostring(relationships))


def monthly_rows():
    serial = to_excel(datetime(2026, 11, 2))
    return [(1, [c('A1', 'Дата', kind='inlineStr'), c('B1', 'Цена', kind='inlineStr'),
                 c('C1', 'Название', kind='inlineStr')]),
            (2, [c('A2', serial, style=1), c('B2', 0), c('C2', 'Example', kind='inlineStr')]),
            (3, [c('B3', 5), c('C3', 'Second example', kind='inlineStr')]),
            (4, [c('D4', 0, formula='B4-SUM(E4:F4)'), c('H4'), c('I4')]),
            (5, [c('B5', 0, formula='SUM(B2:B2)')]),
            (7, [c('B7', 'Расходы', kind='inlineStr')]),
            (8, [c('A8', 'Сумма', kind='inlineStr'), c('C8', 'На что', kind='inlineStr')]),
            (9, [c('A9', 'USD', kind='inlineStr'), c('B9', 'BYN', kind='inlineStr')]),
            (10, [c('A10', 2), c('C10', 'Synthetic cost', kind='inlineStr')]),
            (12, [c('B12', 'Должники:', kind='inlineStr')]),
            (13, [c('A13', 'Дата', kind='inlineStr'), c('B13', 'Имя', kind='inlineStr'),
                  c('C13', 'За что', kind='inlineStr'), c('D13', 'USD', kind='inlineStr')])]


class LedgerImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.source = self.directory / 'synthetic.xlsx'

    def tearDown(self):
        # Windows read-only snapshots must be made writable before test cleanup.
        for p in self.directory.rglob('*'):
            if p.is_file():
                p.chmod(0o666)
        self.temp.cleanup()

    def parse(self, sheets, **kwargs):
        fixture(self.source, sheets, **kwargs)
        return build_payload(self.source, imported_at='2026-11-16T00:00:00+00:00')

    def test_shared_formulas_cached_errors_and_exact_zero_retained(self):
        rows = [(1, [c('A1', '2026-11-02', kind='d'), c('B1', 1, kind='b'),
                     c('C1', 0), c('D1', '#REF!', kind='str'),
                     c('E1', 999, formula='C1+2', shared={'t': 'shared', 'si': '0', 'ref': 'E1:E2'})]),
                (2, [c('E2', 0, shared={'t': 'shared', 'si': '0'}),
                     c('F2', formula='1+1'), c('G2', '=HYPERLINK("x")', kind='inlineStr')])]
        payload = self.parse([('Extract', 'hidden', rows)])
        first, second = payload['sheets'][0]['rows']
        self.assertEqual(first['cells']['D']['type'], 'error')
        self.assertEqual(first['cells']['B']['value'], True)
        self.assertEqual(first['cells']['C']['value'], 0)
        self.assertEqual(first['cells']['E']['cached'], 999)
        self.assertEqual(first['cells']['E']['value'], 999)
        self.assertEqual(second['cells']['E']['formula'], '=C2+2')
        self.assertIsNone(second['cells']['F']['value'])
        self.assertIsNone(second['cells']['G']['formula'])
        self.assertEqual(second['metadata']['cell_sources']['E']['formula_attributes']['si'], '0')
        self.assertEqual(payload['metadata']['counts']['formula_cells'], 3)
        self.assertEqual(payload['metadata']['counts']['cached_errors'], 1)
        self.assertEqual(payload['sheets'][0]['visibility'], 'hidden')
        self.assertEqual(set(first['cells']['E']), {'value', 'type', 'formula', 'cached', 'format'})

    def test_physical_subtotal_retains_rows_omitted_by_sum_and_templates(self):
        payload = self.parse([('Ноябрь 2026', 'visible', monthly_rows())])
        sheet = payload['sheets'][0]
        by_row = {r['source_row']: r for r in sheet['rows']}
        self.assertEqual(by_row[1]['section'], 'source_headers')
        self.assertEqual(by_row[3]['section'], 'ledger')
        self.assertEqual(by_row[4]['section'], 'template')
        self.assertEqual(by_row[5]['section'], 'ledger_totals')
        warning = next(w for w in sheet['metadata']['warnings'] if w['code'] == 'subtotal_excludes_described_rows')
        self.assertEqual(warning['rows'], [3])
        self.assertTrue(sheet['metadata']['main_subtotal']['cached_matches_source_inputs'])
        expenses = next(s for s in sheet['metadata']['sections'] if s['kind'] == 'expenses')
        self.assertEqual((expenses['start_row'], expenses['end_row']), (7, 11))
        self.assertEqual(expenses['header_row'], 8)
        self.assertIn({'column': 'B', 'label': 'BYN'}, expenses['headers'])
        layout = json.loads(gzip.decompress(base64.b64decode(sheet['metadata']['layout']['data'])))
        self.assertEqual(layout['blank_cell_runs'][0]['range'], 'H4:I4')
        self.assertEqual(layout['merged_ranges'], ['H1:I1'])

    def test_shifted_headers_inferred_dates_missing_price_and_period_warnings(self):
        old = [(1, [c('A1', 'Цена', kind='inlineStr'), c('B1', 'Название', kind='inlineStr')]),
               (2, [c('A2', 3), c('B2', 'Older layout', kind='inlineStr')]),
               (3, [c('A3', 3, formula='SUM(A2:A2)')])]
        rows = monthly_rows()
        rows[0][1][0].find('is/t').text = ' '
        rows[1][1][0].find('v').text = str(to_excel(datetime(2026, 10, 31)))
        rows[2] = (3, [c('C3', 'Unpriced example', kind='inlineStr')])
        payload = self.parse([('Сентябрь', 'hidden', old), ('Ноябрь 2026', 'visible', rows)])
        older, current = payload['sheets']
        self.assertEqual(older['metadata']['price_column'], 'A')
        self.assertEqual(older['metadata']['name_column'], 'B')
        self.assertIsNone(older['metadata']['source_period']['year'])
        self.assertEqual(current['metadata']['date_column'], 'A')
        row2, row3 = current['rows'][1:3]
        self.assertEqual(row2['cells']['A']['value'], '2026-10-31')
        self.assertEqual(row2['metadata']['warnings'][0]['code'], 'date_outside_sheet_period')
        self.assertEqual(row3['metadata']['warnings'][0]['code'], 'missing_price')
        self.assertEqual(current['metadata']['warnings'][0]['code'], 'date_header_inferred')

    def test_1904_dates_and_non_month_views_are_separate(self):
        rows = [(1, [c('A1', 1, style=1)])]
        payload = self.parse([('Квартал 2021', 'hidden', rows)], epoch_1904=True)
        sheet = payload['sheets'][0]
        self.assertEqual(sheet['kind'], 'quarterly')
        self.assertEqual(sheet['rows'][0]['cells']['A']['value'], '1904-01-02')
        self.assertEqual(sheet['metadata']['warnings'][0]['code'], 'overlapping_source_view')

    def test_uncertain_boundaries_preserve_final_entry_and_unknown_labels(self):
        rows = monthly_rows()[:3]
        unknown = [(1, [c('F1', 'Unclassified source label', kind='inlineStr')]),
                   (2, [c('Z2', 17)])]
        payload = self.parse([('Ноябрь 2026', 'visible', rows), ('Other source', 'hidden', unknown)])
        monthly, other = payload['sheets']
        self.assertEqual(monthly['rows'][-1]['source_row'], 3)
        self.assertEqual(monthly['rows'][-1]['section'], 'ledger')
        self.assertTrue(any(w['code'] == 'main_boundary_uncertain' for w in monthly['metadata']['warnings']))
        self.assertEqual(other['kind'], 'unclassified')
        self.assertEqual(other['metadata']['headers'], [{'column': 'F', 'label': 'Unclassified source label'}])
        self.assertEqual(other['rows'][-1]['cells']['Z']['value'], 17)

    def test_source_backup_and_payload_are_verified_and_never_overwritten(self):
        fixture(self.source, [('Ноябрь 2026', 'visible', monthly_rows())])
        out = self.directory / 'private'
        payload, path, backup = create_snapshot(self.source, out)
        self.assertEqual(checksum(backup), checksum(self.source))
        self.assertEqual(payload['source']['sha256'], checksum(self.source))
        original = path.read_bytes()
        self.assertEqual(create_snapshot(self.source, out)[0], payload)
        self.assertEqual(path.read_bytes(), original)
        path.chmod(0o666)
        path.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'changed'):
            create_snapshot(self.source, out)

    def test_repository_output_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            ensure_private_directory(ROOT / 'artifacts.owner-only.local' / 'ledger')


if __name__ == '__main__':
    unittest.main()
