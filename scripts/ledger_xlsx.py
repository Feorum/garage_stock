"""Read XLSX values and cached results without evaluating spreadsheet formulas."""

from collections import Counter
import base64
from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation
from pathlib import PurePosixPath
import posixpath
import gzip
import json
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from openpyxl.formula.translate import Translator
from openpyxl.styles.numbers import BUILTIN_FORMATS, is_date_format
from openpyxl.utils.cell import column_index_from_string
from openpyxl.utils.datetime import CALENDAR_MAC_1904, CALENDAR_WINDOWS_1900, from_excel


NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
ERRORS = {'#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#N/A', '#NUM!', '#NULL!', '#SPILL!', '#CALC!'}


def packed(value):
    """Deterministic, lossless storage for layout that the app does not render."""
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return {'encoding': 'gzip+base64', 'data': base64.b64encode(gzip.compress(raw, mtime=0)).decode('ascii')}


def text_content(element):
    """Read rich text, excluding phonetic annotations."""
    if element is None:
        return ''
    return ''.join(t.text or '' for t in element.findall('s:t', NS)
                   + element.findall('s:r/s:t', NS))


def numeric(raw):
    try:
        value = Decimal(raw)
        if not value.is_finite():
            return raw
        return int(value) if value == value.to_integral_value() else float(value)
    except (InvalidOperation, TypeError):
        return raw


def scalar(raw, xml_type, number_format, epoch, strings):
    if raw is None:
        return None, 'string'
    if xml_type == 's':
        return strings[int(raw)], 'string'
    if xml_type == 'b':
        return raw == '1', 'boolean'
    if xml_type == 'e' or raw in ERRORS:
        return raw, 'error'
    if xml_type in ('str', 'inlineStr'):
        return raw, 'string'
    if xml_type == 'd':
        return raw, 'date'
    value = numeric(raw)
    if isinstance(value, (int, float)) and is_date_format(number_format):
        try:
            converted = from_excel(value, epoch=epoch)
            if isinstance(converted, datetime) and converted.time() == time():
                converted = converted.date()
            if isinstance(converted, (date, datetime, time)):
                return converted.isoformat(), 'date'
        except (OverflowError, ValueError):
            pass
    return value, 'number' if isinstance(value, (int, float)) else 'string'


class XlsxReader:
    """ZIP/XML reader. openpyxl is used only for translation and date decoding."""

    def __init__(self, path):
        self.zip = ZipFile(path)
        self.book = ET.fromstring(self.zip.read('xl/workbook.xml'))
        rels = ET.fromstring(self.zip.read('xl/_rels/workbook.xml.rels'))
        self.rels = {r.get('Id'): self.part(r.get('Target')) for r in rels}
        self.strings = []
        if 'xl/sharedStrings.xml' in self.zip.namelist():
            self.strings = [text_content(si) for si in
                            ET.fromstring(self.zip.read('xl/sharedStrings.xml'))]
        self.styles_xml = self.zip.read('xl/styles.xml').decode('utf-8')
        styles = ET.fromstring(self.styles_xml)
        formats = dict(BUILTIN_FORMATS)
        formats.update({int(n.get('numFmtId')): n.get('formatCode') for n in
                        styles.findall('s:numFmts/s:numFmt', NS)})
        self.formats = [formats.get(int(x.get('numFmtId', 0)), 'General') for x in
                        styles.findall('s:cellXfs/s:xf', NS)] or ['General']
        props = self.book.find('s:workbookPr', NS)
        self.epoch = CALENDAR_MAC_1904 if props is not None and props.get('date1904') in ('1', 'true') else CALENDAR_WINDOWS_1900
        self.function_counts = Counter()

    @staticmethod
    def part(target):
        path = target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target)
        path = posixpath.normpath(path)
        if '..' in PurePosixPath(path).parts:
            raise ValueError('Workbook relationship escapes the XLSX archive.')
        return path

    def close(self):
        self.zip.close()

    def sheet_list(self):
        return self.book.findall('s:sheets/s:sheet', NS)

    def workbook_metadata(self):
        calc = self.book.find('s:calcPr', NS)
        return {'styles': packed(self.styles_xml),
                'date_system': '1904' if self.epoch == CALENDAR_MAC_1904 else '1900',
                'calculation_properties': dict(calc.attrib) if calc is not None else {},
                'defined_names': [{'name': n.get('name'), 'value': n.text,
                                   'attributes': dict(n.attrib)} for n in
                                  self.book.findall('s:definedNames/s:definedName', NS)]}

    def read_sheet(self, source, index):
        root = ET.fromstring(self.zip.read(self.rels[source.get(REL)]))
        anchors, warnings = {}, []
        # Locate anchors first: shared-formula followers need not be in source order.
        for cell in root.findall('s:sheetData/s:row/s:c', NS):
            formula = cell.find('s:f', NS)
            if formula is not None and formula.get('t') == 'shared' and formula.text:
                anchors[formula.get('si')] = (cell.get('r'), '=' + formula.text)
        rows, blank_runs, row_layout = [], [], []
        for source_row in root.findall('s:sheetData/s:row', NS):
            row_num, cells, blank, cell_sources = int(source_row.get('r')), {}, [], {}
            attrs = {k: v for k, v in source_row.attrib.items() if k != 'r'}
            if attrs:
                row_layout.append({'row': row_num, 'attributes': attrs})
            for source_cell in source_row.findall('s:c', NS):
                address = source_cell.get('r')
                value, formula = source_cell.find('s:v', NS), source_cell.find('s:f', NS)
                inline = source_cell.find('s:is', NS)
                if formula is None and (value is None or value.text is None) and inline is None:
                    blank.append((address, {k: v for k, v in source_cell.attrib.items() if k != 'r'}))
                    continue
                cell = self.read_cell(source_cell, anchors, warnings)
                column = re.sub(r'\d', '', address)
                cell_sources[column] = cell.pop('source')
                cells[column] = cell
                if cell['formula']:
                    self.function_counts.update(re.findall(r'([A-Z][A-Z0-9._]*)\s*\(', cell['formula'].upper()))
                if cell['type'] == 'error':
                    warnings.append({'code': 'source_cached_error', 'cell': address,
                                     'message': str(cell['value'])})
            blank_runs.extend(compress_blanks(blank))
            if cells:
                rows.append({'source_row': row_num, 'section': 'unclassified', 'cells': cells,
                             'metadata': {'cell_sources': cell_sources}})
        layout = {'merged_ranges': [m.get('ref') for m in root.findall('s:mergeCells/s:mergeCell', NS)],
                  'columns': [dict(c.attrib) for c in root.findall('s:cols/s:col', NS)],
                  'row_attributes': row_layout, 'blank_cell_runs': blank_runs}
        return {'key': source.get('name'), 'name': source.get('name'), 'index': index,
                'visibility': source.get('state', 'visible'), 'kind': 'unclassified',
                'metadata': {'layout': packed(layout), 'warnings': warnings}, 'rows': rows}

    def read_cell(self, source, anchors, warnings):
        address, xml_type = source.get('r'), source.get('t', 'n')
        style_id = int(source.get('s', 0))
        number_format = self.formats[style_id] if style_id < len(self.formats) else 'General'
        v, f = source.find('s:v', NS), source.find('s:f', NS)
        raw = text_content(source.find('s:is', NS)) if xml_type == 'inlineStr' else (v.text if v is not None else None)
        value, kind = scalar(raw, xml_type, number_format, self.epoch, self.strings)
        formula = None
        if f is not None:
            if f.text is not None:
                formula = '=' + f.text
            elif f.get('t') == 'shared' and f.get('si') in anchors:
                origin, expression = anchors[f.get('si')]
                formula = Translator(expression, origin=origin).translate_formula(address)
            else:
                warnings.append({'code': 'formula_without_expression', 'cell': address,
                                 'message': 'The source formula has no expression or shared anchor.'})
        result = {'value': value, 'type': kind, 'formula': formula,
                  'cached': value if f is not None else None, 'format': number_format,
                  'source': {'xml_type': xml_type, 'style_id': style_id, 'raw_value': raw}}
        if f is not None:
            result['source']['formula_attributes'] = dict(f.attrib)
            result['source']['formula_text'] = f.text
        return result


def compress_blanks(cells):
    """Keep all styled empty coordinates as same-style horizontal runs."""
    runs, previous = [], None
    for address, attrs in cells:
        col, row = re.fullmatch(r'([A-Z]+)(\d+)', address).groups()
        column = column_index_from_string(col)
        if previous and previous[0] + 1 == column and previous[1] == attrs:
            runs[-1]['range'] = runs[-1]['range'].split(':')[0] + ':' + address
        else:
            runs.append({'range': address, 'attributes': attrs})
        previous = (column, attrs)
    return runs
