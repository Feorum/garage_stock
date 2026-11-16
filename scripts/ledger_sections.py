"""Conservative source-section detection for the Owner's evolving ledger."""

from collections import Counter
from decimal import Decimal
import re

from openpyxl.utils.cell import column_index_from_string, get_column_letter


MONTHS = ['янв', 'фев', 'март', 'апрел', 'май', 'июнь', 'июль', 'август',
          'сентябр', 'октябр', 'ноябр', 'декабр']


def norm(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip().casefold().replace('ё', 'е')


def labels(row):
    return [{'column': col, 'label': cell['value']} for col, cell in row['cells'].items()
            if cell['type'] == 'string' and norm(cell['value']) and not cell['formula']]


def source_period(name):
    name = norm(name)
    month = next((i for i, prefix in enumerate(MONTHS, 1) if name.startswith(prefix)), None)
    match = re.search(r'(?<!\d)(20\d{2}|2[4-6])(?!\d)', name)
    year = int(match[0]) if match else None
    if year and year < 100:
        year += 2000
    return {'year': year, 'month': month}


def marker(row):
    """Section titles are source labels in the leftmost two columns only."""
    for item in labels(row):
        if item['column'] not in ('A', 'B'):
            continue
        value = norm(item['label']).rstrip(':')
        if value == 'расходы':
            return 'expenses', item['label']
        if value in ('должники', 'авансы', 'выплаты'):
            return 'advances', item['label']
        if value in ('результаты', 'итоги'):
            return 'summary', item['label']
        if value in ('продажи', 'пленка', 'возврат за пленку') or value.startswith(('sunmax', 'black mat')):
            return 'stock', item['label']
    return None


def section_headers(rows, start, end, kind, fallback):
    candidates = [row for row in rows if start <= row['source_row'] <= min(end, start + 3)]
    if kind == 'ledger':
        return fallback, start
    if kind in ('staff_extract', 'quarterly'):
        return fallback, None
    tokens = {'сумма', 'на что', 'дата', 'имя', 'за что', 'usd', 'byn', 'выручка',
              'закуп', 'продажа', 'наименование', 'возврат', 'остаток', 'моя зп'}
    chosen = next((r for r in candidates if sum(norm(x['label']) in tokens
                  for x in labels(r)) >= 2), None)
    if not chosen:
        return [], None
    result = {x['column']: x['label'] for x in labels(chosen)}
    next_row = next((r for r in candidates if r['source_row'] == chosen['source_row'] + 1), None)
    if next_row:
        for item in labels(next_row):
            if norm(item['label']) in ('usd', 'byn'):
                prior = result.get(item['column'])
                result[item['column']] = f"{prior} ({item['label']})" if prior else item['label']
    return [{'column': c, 'label': v} for c, v in result.items()], chosen['source_row']


def total_anchor(rows, price_column):
    expression = re.compile(rf'^=SUM\(\$?{price_column}\$?(\d+):\$?{price_column}\$?(\d+)\)$', re.I)
    for row in rows:
        cell = row['cells'].get(price_column, {})
        match = expression.fullmatch(cell.get('formula') or '')
        if match and int(match[1]) <= 3 and int(match[2]) < row['source_row']:
            return row['source_row'], int(match[1]), int(match[2])
    return None


def classify_sheet(sheet):
    rows, meta = sheet['rows'], sheet['metadata']
    if not rows:
        meta.update({'headers': [], 'sections': []})
        return
    first = rows[0]
    headers = labels(first)
    columns = {norm(h['label']): h['column'] for h in headers}
    monthly = 'цена' in columns and 'название' in columns
    is_extract = any(r['cells'].get('A', {}).get('type') == 'date'
                     and r['cells'].get('B', {}).get('type') == 'string'
                     and r['cells'].get('C', {}).get('type') == 'number' for r in rows)
    kind = 'monthly' if monthly else ('quarterly' if 'квартал' in norm(sheet['name'])
                                     else 'staff_extract' if is_extract else 'unclassified')
    sheet['kind'] = kind
    meta['headers'] = headers if kind != 'staff_extract' else [
        {'column': 'A', 'label': 'Дата'}, {'column': 'B', 'label': 'Название'},
        {'column': 'C', 'label': sheet['name']}]
    if not monthly:
        only = {'id': kind, 'kind': kind, 'label': sheet['name'], 'start_row': first['source_row'],
                'end_row': rows[-1]['source_row'], 'headers': meta['headers'], 'header_row': None}
        meta['sections'] = [only]
        if kind in ('staff_extract', 'quarterly'):
            meta['warnings'].append({'code': 'overlapping_source_view',
                                     'message': 'This view may repeat monthly ledger records. Do not add it to monthly totals.'})
        for row in rows:
            row['section'] = kind
        return
    price, name = columns['цена'], columns['название']
    date_col = columns.get('дата')
    if not date_col and column_index_from_string(price) > 1:
        candidate = get_column_letter(column_index_from_string(price) - 1)
        if any(r['cells'].get(candidate, {}).get('type') == 'date' for r in rows[1:]):
            date_col = candidate
            meta['warnings'].append({'code': 'date_header_inferred', 'cell': candidate + '1',
                                     'message': 'Date column inferred from typed source dates. Original header retained.'})
    meta.update({'price_column': price, 'name_column': name, 'date_column': date_col,
                 'source_period': source_period(sheet['name'])})
    anchor = total_anchor(rows, price)
    main_end = anchor[0] if anchor else rows[-1]['source_row']
    if not anchor:
        meta['warnings'].append({'code': 'main_boundary_uncertain',
                                 'message': 'No early Price-column SUM subtotal found. All source rows retained for review.'})
    last_entry = max((r['source_row'] for r in rows if 1 < r['source_row'] < main_end + int(not anchor)
                      and norm(r['cells'].get(name, {}).get('value'))), default=1)
    sections = [{'id': 'source_headers', 'kind': 'source_headers', 'label': 'Заголовки',
                 'start_row': first['source_row'], 'end_row': first['source_row'],
                 'headers': headers, 'header_row': first['source_row']}]
    for section_id, label, start, end in [
            ('ledger', 'Основные записи', first['source_row'] + 1, last_entry),
            ('template', 'Пустые строки шаблона', last_entry + 1, main_end - int(bool(anchor))),
            ('ledger_totals', 'Исходный итог', main_end, main_end if anchor else 0)]:
        if end >= start:
            sections.append({'id': section_id, 'kind': section_id, 'label': label,
                             'start_row': start, 'end_row': end, 'headers': headers,
                             'header_row': None})
    starts = []
    for row in rows:
        found = marker(row) if row['source_row'] > main_end else None
        if found:
            starts.append((row['source_row'], *found))
    if main_end < rows[-1]['source_row']:
        starts.insert(0, (main_end + 1, 'unclassified', 'Дополнительные записи'))
    counts = Counter()
    for i, (start, section_kind, label) in enumerate(starts):
        end = starts[i + 1][0] - 1 if i + 1 < len(starts) else rows[-1]['source_row']
        if end < start:
            continue
        counts[section_kind] += 1
        section_id = f'{section_kind}_{counts[section_kind]}'
        local_headers, header_row = section_headers(rows, start, end, section_kind, headers)
        sections.append({'id': section_id, 'kind': section_kind, 'label': label,
                         'start_row': start, 'end_row': end, 'headers': local_headers,
                         'header_row': header_row})
    meta['sections'] = sections
    for row in rows:
        section = next(s for s in sections if s['start_row'] <= row['source_row'] <= s['end_row'])
        row['section'] = section['id']
        role = 'source'
        if row['source_row'] == section.get('header_row'):
            role = 'header'
        elif section['kind'] == 'ledger_totals':
            role = 'subtotal' if anchor else 'source'
        elif section['kind'] in ('ledger', 'template'):
            role = 'entry' if norm(row['cells'].get(name, {}).get('value')) else 'template'
        row.setdefault('metadata', {}).update({'role': role, 'warnings': []})
        if role == 'entry':
            entry_warnings(sheet, row, price, date_col)
    if anchor:
        check_subtotal(sheet, anchor, price, name)


def entry_warnings(sheet, row, price, date_col):
    warnings = row['metadata']['warnings']
    if row['cells'].get(price, {}).get('value') in (None, ''):
        warnings.append({'code': 'missing_price', 'cell': price + str(row['source_row']),
                         'message': 'The described entry has no base Price value.'})
    period = sheet['metadata']['source_period']
    value = row['cells'].get(date_col, {}).get('value') if date_col else None
    if isinstance(value, str) and re.match(r'^\d{4}-\d{2}-\d{2}', value):
        if period['year'] and (int(value[:4]), int(value[5:7])) != (period['year'], period['month']):
            warnings.append({'code': 'date_outside_sheet_period', 'cell': date_col + str(row['source_row']),
                             'message': 'The source date differs from the month in the sheet title.'})


def check_subtotal(sheet, anchor, price, name):
    row_number, start, end = anchor
    rows, meta = sheet['rows'], sheet['metadata']
    omitted = [r['source_row'] for r in rows if 1 < r['source_row'] < row_number
               and not start <= r['source_row'] <= end and norm(r['cells'].get(name, {}).get('value'))]
    if omitted:
        meta['warnings'].append({'code': 'subtotal_excludes_described_rows', 'cell': price + str(row_number),
                                 'rows': omitted, 'message': 'Source SUM omits described rows before its physical subtotal.'})
    subtotal = next(r for r in rows if r['source_row'] == row_number)['cells'][price]
    values = [r['cells'].get(price, {}).get('value') for r in rows if start <= r['source_row'] <= end]
    expected = sum((Decimal(str(v)) for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)), Decimal(0))
    cached = subtotal['value']
    reconciles = isinstance(cached, (int, float)) and abs(expected - Decimal(str(cached))) <= Decimal('.005')
    meta['main_subtotal'] = {'cell': price + str(row_number), 'start_row': start, 'end_row': end,
                             'cached_matches_source_inputs': reconciles,
                             'note': 'Independent sum of cached inputs. This does not recalculate source formulas.'}
    if not reconciles:
        meta['warnings'].append({'code': 'cached_subtotal_mismatch', 'cell': price + str(row_number),
                                 'message': 'Cached subtotal does not reconcile to its declared cached numeric inputs.'})
