#!/usr/bin/env python3
"""Synthetic preview tests; these contain no uploaded customer or financial data."""

import contextlib
from datetime import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('preview_workbooks', ROOT / 'scripts' / 'preview-workbooks.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)
HEADERS = ['Дата', 'День', 'Менеджер', 'Автомобиль', 'VIN', 'Цвет', 'Оклейка', 'Тонировка', 'Готовность', 'Примечание']


def fixture_row(number=1, **changes):
    row = {'date': datetime(2026, 1, 2), 'weekday': None, 'manager': 'Synthetic manager',
           'model': 'VG02', 'vin': 'L' + f'{number:016d}', 'colour': 'Synthetic colour',
           'wrapping': 'капот полностью', 'tint': None, 'completed': False, 'notes': ''}
    row.update(changes)
    return list(row.values())


class WorkbookPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='garage-preview-tests-')
        self.path = Path(self.temp.name)
        self.catalogue = preview.load_catalogue()

    def tearDown(self):
        self.temp.cleanup()

    def alfort(self, rows):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = 'Synthetic requests'
        sheet.append(HEADERS)
        for row in rows:
            sheet.append(row)
        path = self.path / 'requests.xlsx'
        workbook.save(path)
        workbook.close()
        return path

    def test_templates_not_orders_and_false_checkbox_can_be_meaningful(self):
        template = [None] * 8 + [False, None]
        path = self.alfort([template, fixture_row()])
        result = preview.analyze_alfort(path, self.catalogue)
        self.assertEqual(result['summary']['candidate_rows'], 1)
        self.assertEqual(result['summary']['skipped']['checkbox_only'], 1)
        record = result['records'][0]
        self.assertFalse(record['completed_in_source'])
        self.assertFalse(record['submitted'])
        self.assertFalse(record['publishable'])
        self.assertEqual(record['normalized_order_preview']['purpose'], 'draft_review')
        self.assertIsNone(record['assignment'])

    def test_completed_flag_is_history_not_submission(self):
        result = preview.analyze_alfort(self.alfort([fixture_row(completed=True)]), self.catalogue)
        record = result['records'][0]
        self.assertEqual(record['classification'], 'historical_completed')
        self.assertEqual(record['normalized_order_preview']['purpose'], 'historical_review')
        self.assertEqual(result['summary']['submitted_orders'], 0)
        self.assertFalse(record['publishable'])

    def test_unknown_residual_blocks_whole_preview_and_preserves_fragment(self):
        scope = 'капот полностью, unapproved synthetic treatment'
        result = preview.analyze_alfort(self.alfort([fixture_row(wrapping=scope)]), self.catalogue)
        record = result['records'][0]
        self.assertEqual(record['task_candidates'][0]['work_code'], 'W01')
        self.assertIn('unrecognized_scope_fragment', record['issues'])
        self.assertEqual(record['unresolved_fragments'][0]['fragment'], 'unapproved synthetic treatment')
        self.assertIsNone(record['normalized_order_preview'])

    def test_unapproved_alias_is_review_only(self):
        result = preview.analyze_alfort(self.alfort([fixture_row(wrapping='стойки А')]), self.catalogue)
        record = result['records'][0]
        self.assertEqual(record['task_candidates'][0]['work_code'], 'W10')
        self.assertIn('work_alias_requires_confirmation', record['issues'])
        self.assertIsNone(record['normalized_order_preview'])

    def test_tint_requires_approved_percentage_and_explicit_scope(self):
        rows = [fixture_row(1, wrapping='', tint='тонировка задней полусферы 10%'),
                fixture_row(2, wrapping='', tint='тонировка 5%'),
                fixture_row(3, wrapping='', tint='тонировка задней полусферы 15%')]
        records = preview.analyze_alfort(self.alfort(rows), self.catalogue)['records']
        self.assertIn('unsupported_tint_percentage', records[0]['issues'])
        self.assertIn('tint_scope_requires_confirmation', records[1]['issues'])
        self.assertEqual(records[2]['normalized_order_preview']['tasks'][0]['options'], {'tint_percent': 15})

    def test_atlas_matte_and_unknown_model_do_not_borrow_rate(self):
        rows = [fixture_row(1, model='Atlas'), fixture_row(2, model='MONJARO (матовый)'),
                fixture_row(3, model='Synthetic unknown model')]
        records = preview.analyze_alfort(self.alfort(rows), self.catalogue)['records']
        self.assertIn('ambiguous_atlas_group', records[0]['issues'])
        self.assertIn('unapproved_finish_variant', records[1]['issues'])
        self.assertIn('unknown_vehicle_group', records[2]['issues'])
        self.assertTrue(all(record['normalized_order_preview'] is None for record in records))

    def test_repeated_vin_is_reviewed_as_visits_not_deduplicated(self):
        rows = [fixture_row(), fixture_row(date=datetime(2026, 1, 3))]
        result = preview.analyze_alfort(self.alfort(rows), self.catalogue)
        self.assertEqual(len(result['records']), 2)
        self.assertEqual(result['summary']['repeated_vin_groups'], 1)
        self.assertTrue(all('repeated_vin_review_visits' in record['issues'] for record in result['records']))

    def test_provenance_formula_and_hidden_rows(self):
        path = self.alfort([fixture_row(notes='=1+1')])
        from openpyxl import load_workbook
        workbook = load_workbook(path)
        workbook.active.row_dimensions[2].hidden = True
        workbook.save(path)
        workbook.close()
        record = preview.analyze_alfort(path, self.catalogue)['records'][0]
        self.assertEqual(record['provenance']['sha256'], preview.checksum(path))
        self.assertEqual(record['provenance']['cells']['vin'], 'E2')
        self.assertTrue(record['provenance']['hidden_row'])
        self.assertEqual(record['source_expressions']['J'], '=1+1')
        self.assertIn('formula_or_error_in_input', record['issues'])
        self.assertIsNone(record['normalized_order_preview'])

    def test_unavailable_pair_is_never_zero_or_publishable(self):
        result = preview.analyze_alfort(self.alfort([fixture_row(model='VG01', wrapping='крылья целиком (2шт)')]), self.catalogue)
        record = result['records'][0]
        self.assertIn('unavailable_work_vehicle_combination', record['issues'])
        self.assertIsNone(record['normalized_order_preview'])
        self.assertNotIn('price', json.dumps(record))

    def test_main_is_inventory_only_including_hidden_formulas(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(['Дата', 'Цена', 'Название'])
        sheet.append([datetime(2026, 1, 1), 123.45, 'Synthetic legacy descriptor'])
        hidden = workbook.create_sheet('Synthetic hidden extract')
        hidden.sheet_state = 'hidden'
        hidden['C4'] = "='Missing sheet'!#REF!"
        path = self.path / 'accounting.xlsx'
        workbook.save(path)
        workbook.close()
        result = preview.analyze_main(path)
        self.assertEqual(result['sheet_count'], 2)
        self.assertEqual(result['hidden_sheets'], 1)
        self.assertEqual(result['summary']['literal_reference_errors'], 1)
        self.assertEqual(result['normalized_orders'], [])
        self.assertEqual(result['submitted_orders'], 0)

    def test_private_outputs_and_stdout_contain_counts_only(self):
        path = self.alfort([fixture_row()])
        output = self.path / 'private-output'
        args = SimpleNamespace(alfort=path, main=None, price_list=None, output=output)
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            preview.run(args)
        self.assertEqual(os.stat(output).st_mode & 0o777, 0o700)
        for file in output.iterdir():
            self.assertEqual(os.stat(file).st_mode & 0o777, 0o600)
        stdout = stream.getvalue()
        self.assertNotIn('Synthetic manager', stdout)
        self.assertNotIn('L0000000000000001', stdout)
        self.assertNotIn(str(path), stdout)
        self.assertEqual(json.loads(stdout)['application_records_created'], 0)
        with self.assertRaises(ValueError):
            preview.private_directory(ROOT / 'private-output')
        # A mistyped shared-folder output must not change its access permissions.
        shared = self.path / 'shared'
        shared.mkdir(mode=0o755)
        shared.chmod(0o755)
        (shared / 'unrelated.txt').write_text('synthetic unrelated content')
        with self.assertRaises(ValueError):
            preview.private_directory(shared)
        self.assertEqual(os.stat(shared).st_mode & 0o777, 0o755)

    def test_price_cells_preserve_missing_markers_without_zero_coercion(self):
        workbook = Workbook()
        sheet = workbook.active
        groups = self.catalogue['VEHICLE_GROUPS'][:4]
        sheet.append(['Work', 'Private basis', *[group['name'] for group in groups]])
        sheet.append([self.catalogue['WORKS'][0]['name'], None, 123.45, None, '-', '=10+5'])
        path = self.path / 'synthetic-prices.xlsx'
        workbook.save(path)
        workbook.close()
        result = preview.analyze_price_list(path, self.catalogue)
        self.assertEqual(result['cell_counts'], {'numeric': 1, 'blank': 1, 'dash': 1, 'unresolved': 1})
        self.assertEqual([cell['available'] for cell in result['matrix']], [True, False, False, False])
        self.assertIsNone(result['matrix'][1]['source_value'])
        self.assertEqual(result['matrix'][2]['source_value'], '-')
        self.assertEqual(result['matrix'][3]['source_value'], '=10+5')


if __name__ == '__main__':
    unittest.main()
