#!/usr/bin/env python3
"""Inspect Owner-provided workbooks without creating application records.

Requires openpyxl. Output is private, outside the repository. Formulas are
preserved as source expressions; this tool never evaluates them or uses the
network. A preview is not a submission and cannot authorize task execution.
"""

import argparse
from collections import Counter, defaultdict
from datetime import date, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter


ROOT = Path(__file__).resolve().parents[1]
FORMAT_VERSION = 1
VIN = re.compile(r'^[A-HJ-NPR-Z0-9]{17}$')
ALFORT_COLUMNS = {
    'date': 'A', 'manager_label': 'C', 'model_label': 'D', 'vin': 'E',
    'colour': 'F', 'wrapping_scope': 'G', 'tint_scope': 'H',
    'completed': 'I', 'notes': 'J',
}
EXPECTED_HEADERS = {
    'A': {'столбец 1', 'дата', 'date'}, 'C': {'менеджер', 'manager'},
    'D': {'автомобиль', 'vehicle'}, 'E': {'vin'}, 'F': {'цвет', 'colour'},
    'G': {'оклейка', 'wrapping'}, 'H': {'тонировка', 'tinting'},
    'I': {'готовность', 'completed'}, 'J': {'примечание', 'notes'},
}
# These are review suggestions, not newly approved aliases or services.
WORK_ALIAS_SUGGESTIONS = {
    'капот 25': 'W04', 'капот 25 см': 'W04', 'капот 25см': 'W04',
    'частично капот 25 см': 'W04', 'часть капота 25 см': 'W04',
    'капот 45': 'W03', 'капот 45 см': 'W03', 'капот 45см': 'W03',
    'частично капот 45 см': 'W03', 'часть капота 45 см': 'W03',
    'капот весь': 'W01', 'весь капот': 'W01', 'капот целиком': 'W01',
    'частично крылья': 'W06', 'часть крыльев': 'W06', 'часть кр.': 'W06',
    'крылья целиком': 'W05', 'крылья полностью': 'W05',
    'стойки а': 'W10', 'стойки a': 'W10', 'стойки лобового': 'W10',
    'полоса над лобовым': 'W09', 'полоса над лобовым стеклом': 'W09',
    'над лобовым': 'W09', 'зона над лобовым стеклом': 'W09',
    'фары': 'W07', 'зм': 'W11', 'маникюр': 'W11',
    'зона маникюра': 'W11', 'антиманикюр': 'W11',
    'канты дверей': 'W16', 'канты': 'W16', 'пороги внутри': 'W17',
    'арки 4 шт': 'W18',
}
MODEL_ALIAS_SUGGESTIONS = {
    'x50+': 'VG08', 'х50+': 'VG08', 'x50': 'VG08', 'х50': 'VG08',
    'x70': 'VG05', 'х70': 'VG05', 'x80': 'VG09', 'х80': 'VG09',
    'cityray': 'VG07', 'сityray': 'VG07', 'monjaro': 'VG12',
}


def normalize(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value)).strip().casefold().replace('ё', 'е'))


def source_value(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    # Array-formula objects are data, never instructions to execute.
    return str(getattr(value, 'text', value))


def checksum(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_catalogue():
    source = (ROOT / 'src' / 'catalogue.js').read_text()
    result = {}
    for name in ('WORKS', 'VEHICLE_GROUPS', 'AVAILABLE_WORKS'):
        match = re.search(r'export const ' + name + r' = (.*?);', source, re.S)
        if not match:
            raise ValueError('Approved catalogue format is not recognized.')
        result[name] = json.loads(match.group(1))
    return result


def parse_date(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        for pattern in ('%Y-%m-%d', '%d.%m.%Y', '%d/%m/%Y'):
            try:
                return datetime.strptime(value.strip(), pattern).date().isoformat()
            except ValueError:
                pass
    return None


def split_scope(value):
    """Split explicit delimiters, retaining commas inside package parentheses."""
    depth, start, parts = 0, 0, []
    for index, char in enumerate(value):
        if char == '(':
            depth += 1
        elif char == ')':
            depth = max(0, depth - 1)
        elif char in ',;\n\r' and depth == 0:
            parts.append(value[start:index])
            start = index + 1
    parts.append(value[start:])
    return [re.sub(r'^[-•]\s*', '', part.strip()).strip() for part in parts if part.strip()]


def resolve_model(value, groups):
    text = normalize(value)
    if not text:
        return None, [], ['missing_vehicle_group']
    if 'матов' in text or 'matte' in text:
        return None, ['VG12'] if 'monjaro' in text or 'mongaro' in text else [], ['unapproved_finish_variant']
    if text in {'atlas', 'атлас'}:
        # The source has three Atlas groups; the generic label is insufficient.
        return None, ['VG04', 'VG05', 'VG06'], ['ambiguous_atlas_group']
    for group in groups:
        if text == normalize(group['code']) or text == normalize(group['name']):
            return group['code'], [group['code']], []
        # Literal members of an approved combined label are unambiguous.
        members = [normalize(part) for part in re.split(r'[/\\]+', group['name'])]
        if text in members:
            return group['code'], [group['code']], []
    hint = MODEL_ALIAS_SUGGESTIONS.get(text)
    return None, [hint] if hint else [], ['model_alias_requires_confirmation' if hint else 'unknown_vehicle_group']


def resolve_work(token, works):
    text = normalize(token)
    code = next((work['code'] for work in works if text in {normalize(work['name']), normalize(work['code'])}), None)
    if code and code != 'W19':
        return {'work_code': code, 'options': {}, 'resolution': 'canonical'}, []
    if code == 'W19' or any(word in text for word in ('тониров', 'тонер')):
        percentages = [int(number) for number in re.findall(r'(\d+)\s*%', text)]
        if any(number not in (5, 15) for number in percentages):
            return {'work_code': 'W19', 'options': {}, 'resolution': 'review_candidate'}, ['unsupported_tint_percentage']
        if len(set(percentages)) != 1:
            return {'work_code': 'W19', 'options': {}, 'resolution': 'review_candidate'}, ['tint_percentage_required']
        match = re.fullmatch(r'тонировка задней полусферы\s+(5|15)\s*%', text)
        if match:
            return {'work_code': 'W19', 'options': {'tint_percent': int(match.group(1))}, 'resolution': 'canonical_variant'}, []
        return {'work_code': 'W19', 'options': {'tint_percent': percentages[0]}, 'resolution': 'review_candidate'}, ['tint_scope_requires_confirmation']
    hint = WORK_ALIAS_SUGGESTIONS.get(text)
    if hint:
        return {'work_code': hint, 'options': {}, 'resolution': 'review_candidate'}, ['work_alias_requires_confirmation']
    if 'капот' in text and re.search(r'\b35\b', text):
        return None, ['unsupported_hood_width']
    return None, ['unrecognized_scope_fragment']


def analyze_alfort(path, catalogue):
    workbook = load_workbook(path, read_only=False, data_only=False, keep_links=False)
    cached = load_workbook(path, read_only=True, data_only=True, keep_links=False)
    digest = checksum(path)
    if len(workbook.worksheets) != 1:
        raise ValueError('Alfort mapping v1 expects exactly one sheet; review the new layout before use.')
    sheet = workbook.worksheets[0]
    values = cached[sheet.title]
    for column, allowed in EXPECTED_HEADERS.items():
        if normalize(sheet[f'{column}1'].value) not in allowed:
            raise ValueError(f'Alfort mapping v1 does not match header {column}1.')
    records, notices, skipped, formula_cells = [], [], Counter(), []
    cached_rows = values.iter_rows(min_row=2, max_col=10)
    for index, row in enumerate(cached_rows, start=2):
        raw = {field: source_value(row[ord(column) - ord('A')].value) for field, column in ALFORT_COLUMNS.items()}
        expressions = {}
        for column in ALFORT_COLUMNS.values():
            cell = sheet[f'{column}{index}']
            if cell.data_type == 'f' or cell.data_type == 'e' or getattr(cell.value, 'text', None):
                expressions[column] = source_value(cell.value)
                formula_cells.append(cell.coordinate)
        identity_content = any(raw[key] not in (None, '') for key in ('manager_label', 'model_label', 'vin', 'colour', 'wrapping_scope', 'tint_scope', 'notes'))
        if not identity_content and raw['date'] in (None, '') and (raw['completed'] is None or raw['completed'] is False):
            skipped['checkbox_only' if raw['completed'] is False else 'empty'] += 1
            continue
        if not identity_content and isinstance(raw['date'], str) and not parse_date(raw['date']) and not expressions:
            notices.append({'sheet': sheet.title, 'row': index, 'source_text': raw['date']})
            continue
        issues = []
        if expressions:
            issues.append('formula_or_error_in_input')
        date_iso = parse_date(row[0].value)
        if not date_iso:
            issues.append('date_missing_or_ambiguous')
        group, group_candidates, model_issues = resolve_model(raw['model_label'] or '', catalogue['VEHICLE_GROUPS'])
        issues.extend(model_issues)
        vin = str(raw['vin'] or '').strip().upper()
        if not VIN.fullmatch(vin):
            issues.append('invalid_or_missing_vin')
        if not str(raw['manager_label'] or '').strip():
            issues.append('missing_manager_label')
        if raw['completed'] is not True and raw['completed'] is not False:
            issues.append('completion_flag_not_boolean')
        task_candidates, unresolved = [], []
        for field in ('wrapping_scope', 'tint_scope'):
            scope = str(raw[field] or '').strip()
            if not scope:
                continue
            for token in split_scope(scope):
                candidate, work_issues = resolve_work(token, catalogue['WORKS'])
                issues.extend(work_issues)
                if candidate:
                    candidate['source_cell'] = ALFORT_COLUMNS[field] + str(index)
                    candidate['source_fragment'] = token
                    task_candidates.append(candidate)
                if work_issues:
                    unresolved.append({'source_cell': ALFORT_COLUMNS[field] + str(index), 'fragment': token, 'issues': work_issues})
        if not task_candidates:
            issues.append('no_explicit_catalogue_tasks')
        seen = Counter((item['work_code'], json.dumps(item['options'], sort_keys=True)) for item in task_candidates)
        if any(count > 1 for count in seen.values()):
            issues.append('repeated_work_requires_confirmation')
        hood_codes = {item['work_code'] for item in task_candidates} & {'W01', 'W03', 'W04'}
        if len(hood_codes) > 1:
            issues.append('conflicting_hood_scope_requires_review')
        if group:
            available = set(catalogue['AVAILABLE_WORKS'][group])
            if any(item['work_code'] not in available for item in task_candidates):
                issues.append('unavailable_work_vehicle_combination')
        record = {
            'provenance': {'sha256': digest, 'sheet': sheet.title, 'row': index,
                           'cells': {key: column + str(index) for key, column in ALFORT_COLUMNS.items()},
                           'hidden_row': bool(sheet.row_dimensions[index].hidden)},
            'source_values': raw, 'source_expressions': expressions,
            'date': date_iso, 'derived_weekday': date.fromisoformat(date_iso).weekday() if date_iso else None,
            'vin': vin, 'vehicle_group_code': group, 'vehicle_group_candidates': group_candidates,
            'completed_in_source': raw['completed'] is True,
            'classification': 'historical_completed' if raw['completed'] is True else 'unsubmitted_requires_review',
            'task_candidates': task_candidates, 'unresolved_fragments': unresolved,
            'issues': sorted(set(issues)), 'normalized_order_preview': None,
            'submitted': False, 'publishable': False,
            'assignment': None,
        }
        records.append(record)
    by_vin = defaultdict(list)
    for record in records:
        if VIN.fullmatch(record['vin']):
            by_vin[record['vin']].append(record)
    repeats = []
    for vin, matches in by_vin.items():
        if len(matches) > 1:
            repeats.append({'vin': vin, 'rows': [record['provenance']['row'] for record in matches], 'resolution': 'review_visits_or_duplicate; do not merge automatically'})
            for record in matches:
                record['issues'] = sorted(set(record['issues'] + ['repeated_vin_review_visits']))
    for record in records:
        if not record['issues']:
            record['normalized_order_preview'] = {
                'purpose': 'historical_review' if record['completed_in_source'] else 'draft_review',
                'vehicle': str(record['source_values']['model_label']),
                'vehicle_group_code': record['vehicle_group_code'], 'vin': record['vin'],
                'colour': record['source_values']['colour'] or '', 'requested_date': record['date'],
                'manager_label': record['source_values']['manager_label'],
                'source': 'manager',
                'tasks': [{'work_code': task['work_code'], 'options': task['options']} for task in record['task_candidates']],
                'submitted': False, 'publishable': False, 'external_order_id': None,
            }
    issue_counts = Counter(issue for record in records for issue in record['issues'])
    summary = {
        'source_sha256': digest, 'sheet_count': len(workbook.worksheets), 'candidate_rows': len(records),
        'completed_rows': sum(record['completed_in_source'] for record in records),
        'unchecked_rows': sum(record['source_values']['completed'] is False for record in records),
        'hidden_candidate_rows': sum(record['provenance']['hidden_row'] for record in records),
        'skipped': dict(skipped), 'non_order_notices': len(notices), 'repeated_vin_groups': len(repeats),
        'fully_normalized_review_previews': sum(record['normalized_order_preview'] is not None for record in records),
        'issue_counts': dict(issue_counts), 'submitted_orders': 0, 'publishable_orders': 0,
        'completion_semantics': 'Checked Готовность means work completed, as confirmed by Owner.',
        'mapping_version': 'alfort-v1', 'formulas_in_input_columns': formula_cells,
        'weekday_column': 'Ignored; derived from parsed date, not cached weekday formulas.',
    }
    workbook.close()
    cached.close()
    return {'summary': summary, 'records': records, 'repeated_vins': repeats, 'non_order_notices': notices}


def analyze_main(path):
    workbook = load_workbook(path, read_only=True, data_only=False, keep_links=False)
    digest = checksum(path)
    sheets = []
    for sheet in workbook:
        counts = Counter()
        headers = []
        for index, row in enumerate(sheet.iter_rows(), start=1):
            populated = [cell for cell in row if cell.value is not None]
            if not populated:
                continue
            counts['nonempty_rows'] += 1
            counts['nonempty_cells'] += len(populated)
            for cell in populated:
                if cell.data_type == 'f' or getattr(cell.value, 'text', None):
                    counts['formulas'] += 1
                    if '#REF!' in str(source_value(cell.value)):
                        counts['literal_reference_errors'] += 1
                elif cell.data_type == 'e':
                    counts['error_cells'] += 1
            if index <= 5:
                # Header text only; numeric amounts and full accounting rows stay in the source file.
                headers.append({'row': index, 'text_cells': [
                    {'cell': cell.coordinate, 'text': cell.value}
                    for cell in populated if isinstance(cell.value, str) and cell.data_type not in ('f', 'e')
                ]})
        sheets.append({'name': sheet.title, 'state': sheet.sheet_state, 'dimension_rows': sheet.max_row,
                       'dimension_columns': sheet.max_column, 'counts': dict(counts), 'header_samples': headers,
                       'classification': 'owner_accounting_history_only', 'normalized_orders': []})
    workbook.close()
    return {'source_sha256': digest, 'sheet_count': len(sheets), 'hidden_sheets': sum(sheet['state'] != 'visible' for sheet in sheets),
            'sheets': sheets, 'summary': dict(sum((Counter(sheet['counts']) for sheet in sheets), Counter())),
            'normalized_orders': [], 'submitted_orders': 0,
            'warning': 'Accounting descriptions, invoices, wages and amounts do not establish authorized tasks, completion or authenticated mechanic identity.'}


def analyze_price_list(path, catalogue):
    workbook = load_workbook(path, read_only=True, data_only=False, keep_links=False)
    sheet = workbook.worksheets[0]
    work_index = {normalize(work['name']): work['code'] for work in catalogue['WORKS']}
    group_index = {normalize(group['name']): group['code'] for group in catalogue['VEHICLE_GROUPS']}
    header = next(sheet.iter_rows(max_row=1))
    groups = {cell.column: group_index[normalize(cell.value)] for cell in header if cell.value is not None and normalize(cell.value) in group_index}
    cells, notes = [], []
    for index, row in enumerate(sheet.iter_rows(min_row=2, max_col=max(groups, default=1)), start=2):
        if not row:
            continue
        name = row[0].value
        if name is None:
            continue
        work = work_index.get(normalize(name))
        if not work:
            notes.append({'cell': row[0].coordinate, 'text': source_value(name), 'classification': 'unapproved_work_or_commercial_note'})
            continue
        for column, group in groups.items():
            cell = row[column - 1]
            value = source_value(cell.value)
            state = 'blank' if value is None else 'dash' if value == '-' else 'numeric' if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else 'unresolved'
            cells.append({'work_code': work, 'vehicle_group_code': group, 'source_cell': get_column_letter(column) + str(index),
                          'state': state, 'available': state == 'numeric', 'source_value': value})
    workbook.close()
    return {'source_sha256': checksum(path), 'currency': 'BYN', 'vat_rate': '0.20',
            'tax_basis': 'excluding VAT per approved source heading',
            'commercial_meaning': 'Not inferred as customer revenue, wage, payment or profit.',
            'cell_counts': dict(Counter(cell['state'] for cell in cells)), 'matrix': cells,
            'commercial_notes': notes, 'publication': 'Owner-only data; never include this output in a public build.'}


def private_directory(path):
    requested = Path(path).expanduser()
    if requested.is_symlink():
        raise ValueError('Use a dedicated private output directory, not a symbolic link.')
    output = requested.resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError('Private workbook output must be outside the application repository.')
    known_outputs = {'alfort-preview.owner-only.json', 'main-inventory.owner-only.json',
                     'price-matrix.owner-only.json', 'summary.owner-only.json'}
    if output.exists():
        if not output.is_dir() or any(item.name not in known_outputs or not item.is_file() or item.is_symlink() for item in output.iterdir()):
            raise ValueError('Use a dedicated empty output directory or one containing only this tool’s previous outputs.')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.chmod(0o700)
    return output


def write_private_json(output, name, data):
    path = output / name
    if path.is_symlink():
        raise ValueError('Refusing a symbolic-link output file.')
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def run(args):
    if not any((args.alfort, args.main, args.price_list)):
        raise ValueError('Provide --alfort, --main or --price-list explicitly.')
    for path in (args.alfort, args.main, args.price_list):
        if path and Path(path).suffix.lower() != '.xlsx':
            raise ValueError('Only explicitly selected .xlsx files are supported.')
    output = private_directory(args.output)
    catalogue = load_catalogue()
    results = {'format_version': FORMAT_VERSION, 'mode': 'dry_run_only', 'application_records_created': 0}
    if args.alfort:
        result = analyze_alfort(args.alfort, catalogue)
        write_private_json(output, 'alfort-preview.owner-only.json', result)
        results['alfort'] = result['summary']
    if args.main:
        result = analyze_main(args.main)
        write_private_json(output, 'main-inventory.owner-only.json', result)
        results['main'] = {'sheet_count': result['sheet_count'], 'hidden_sheets': result['hidden_sheets'], **result['summary'], 'submitted_orders': 0}
    if args.price_list:
        result = analyze_price_list(args.price_list, catalogue)
        write_private_json(output, 'price-matrix.owner-only.json', result)
        results['price_list'] = {'cell_counts': result['cell_counts']}
    write_private_json(output, 'summary.owner-only.json', results)
    # Deliberately print counts only: no paths, VINs, names, worksheet titles or amounts.
    print(json.dumps({'mode': 'dry_run_only', 'application_records_created': 0,
                      'alfort_candidate_rows': results.get('alfort', {}).get('candidate_rows', 0),
                      'alfort_completed_rows': results.get('alfort', {}).get('completed_rows', 0),
                      'main_sheet_count': results.get('main', {}).get('sheet_count', 0),
                      'price_cell_counts': results.get('price_list', {}).get('cell_counts', {})}))
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--alfort', type=Path, help='Operational Alfort workbook, mapping v1.')
    parser.add_argument('--main', type=Path, help='Owner accounting workbook; inventory only.')
    parser.add_argument('--price-list', type=Path, help='Owner-only matrix workbook; never an order feed.')
    parser.add_argument('--output', type=Path, required=True, help='Private output directory outside the checkout.')
    try:
        run(parser.parse_args())
    except (ValueError, OSError, KeyError) as error:
        parser.exit(2, f'Preview stopped: {error}\n')
