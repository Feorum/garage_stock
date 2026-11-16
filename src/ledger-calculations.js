import { readLedgerFormula } from './ledger-formula-parser.js';

export function createLedgerCalculator(context = {}) {
  const sheets = new Map((context.sheets || []).map(sheet => [sheet.name, new Map(
    (sheet.rows || []).filter(row => row.source_row != null).map(row => [Number(row.source_row), row])
  )]));
  const cache = new Map(), visiting = new Set();
  function getCell(sheet, column, row) {
    const key = `${sheet}\u0000${column}${row}`;
    if (cache.has(key)) return cache.get(key);
    if (visiting.has(key)) return { status: 'error', value: null, error: 'The calculation contains a circular reference.' };
    if (!sheets.has(sheet)) return { status: 'error', value: null, error: `The referenced sheet is unavailable: ${sheet}` };
    const source = sheets.get(sheet).get(Number(row));
    const cell = source?.cells?.[column];
    if (!source || source.archived || !cell) return { status: 'blank', value: null };
    if (cell.override) return { status: 'override', value: cell.value, formula: cell.formula };
    if (!cell.formula) {
      if (cell.type === 'error') return { status: 'error', value: null, error: String(cell.value || 'Source error') };
      return { status: cell.value == null || cell.value === '' ? 'blank' : 'ok', value: cell.value };
    }
    if (visiting.size > 250) return { status: 'error', value: null, error: 'The dependency chain needs review.' };
    visiting.add(key);
    let result;
    try {
      const value = readLedgerFormula(cell.formula, sheet, (target, col, number) => {
        const input = getCell(target, col, number);
        if (input.status === 'error') throw new Error(input.error);
        return input.value;
      });
      result = { status: value == null ? 'blank' : 'ok', value, formula: cell.formula };
    } catch (error) {
      result = { status: 'error', value: null, formula: cell.formula, error: error.message };
    } finally { visiting.delete(key); }
    cache.set(key, result);
    return result;
  }
  function evaluateRow(sheet, row) {
    return Object.fromEntries(Object.entries(row.cells || {}).map(([column, cell]) => [column,
      row.source_row == null
        ? cell.formula && !cell.override
          ? { status: 'error', value: null, error: 'New entries need explicit values; they have no source formula address.' }
          : { status: cell.override ? 'override' : cell.type === 'error' ? 'error' : cell.value == null ? 'blank' : 'ok', value: cell.type === 'error' ? null : cell.value }
        : getCell(sheet, column, row.source_row)
    ]));
  }
  return { getCell, evaluateRow };
}
