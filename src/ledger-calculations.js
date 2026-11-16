import { readLedgerFormula } from './ledger-formula-parser.js';

export function createLedgerCalculator(context = {}) {
  const sheets = new Map((context.sheets || []).map(sheet => [sheet.name, new Map(
    (sheet.rows || []).filter(row => row.source_row != null).map(row => [Number(row.source_row), row])
  )]));
  const cache = new Map(), visiting = new Set();
  function getCell(sheet, column, row) {
    const key = `${sheet}\u0000${column}${row}`;
    if (cache.has(key)) return cache.get(key);
    if (visiting.has(key)) return { status: 'error', value: null, error: 'В расчёте обнаружена циклическая ссылка.' };
    if (!sheets.has(sheet)) return { status: 'error', value: null, error: `Указанный лист недоступен: ${sheet}` };
    const source = sheets.get(sheet).get(Number(row));
    const cell = source?.cells?.[column];
    if (!source || source.archived || !cell) return { status: 'blank', value: null };
    if (cell.override) return { status: 'override', value: cell.value, formula: cell.formula };
    if (!cell.formula) {
      if (cell.type === 'error') return { status: 'error', value: null, error: String(cell.value || 'Ошибка в источнике') };
      return { status: cell.value == null || cell.value === '' ? 'blank' : 'ok', value: cell.value };
    }
    if (visiting.size > 250) return { status: 'error', value: null, error: 'Цепочку зависимостей нужно проверить.' };
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
          ? { status: 'error', value: null, error: 'Для новой записи введите значения: у неё нет адреса в исходной формуле.' }
          : { status: cell.override ? 'override' : cell.type === 'error' ? 'error' : cell.value == null ? 'blank' : 'ok', value: cell.type === 'error' ? null : cell.value }
        : getCell(sheet, column, row.source_row)
    ]));
  }
  return { getCell, evaluateRow };
}
