import { element } from './ui.js';

export const clone = value => JSON.parse(JSON.stringify(value));
export const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const columnOrder = value => [...value].reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0);
export function ledgerReadOnly(sheet, section, row) {
  const selected = sheet.metadata?.sections?.find(item => item.id === section);
  return /^(header|template)$/.test(row?.metadata?.role || row?.role || '')
    || /header|template/i.test(selected?.kind || '') || /(^|_)(headers?|templates?)($|_)/i.test(section);
}
export function ledgerButton(label, action, primary = false) {
  return element('button', { type: 'button', class: `button button-small${primary ? ' button-primary' : ''}`,
    'data-ledger-action': '', onclick: action }, label);
}
export function ledgerField(label, control, hint = '') {
  return element('div', { class: 'ledger-control' }, element('label', { for: control.id }, label), control,
    hint ? element('p', { class: 'field-hint' }, hint) : null);
}
export function ledgerHeaders(sheet, section, rows = []) {
  const selected = sheet.metadata?.sections?.find(item => item.id === section);
  const base = selected?.headers || sheet.metadata?.section_headers?.[section] || sheet.metadata?.headers || [];
  const headers = new Map(base.filter(item => /^[A-Z]{1,3}$/.test(item.column)).map(item => [item.column, item]));
  for (const row of rows) for (const column of Object.keys(row.cells || {})) {
    if (!headers.has(column)) headers.set(column, { column, label: column });
  }
  return [...headers.values()].sort((a, b) => columnOrder(a.column) - columnOrder(b.column));
}
export function ledgerValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value)
    ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 }).format(value) : 'Unavailable';
  return String(value);
}
export function resultFor(sheet, row, column, calculator) {
  const cell = row.cells?.[column];
  if (!cell) return { value: null, status: 'blank' };
  if (cell.formula && !cell.override) {
    try { return calculator?.getCell(sheet.name, column, row.source_row)
      || { value: null, status: 'error', error: 'The calculation context is unavailable.' }; }
    catch { return { value: null, status: 'error', error: 'This source formula could not be evaluated.' }; }
  }
  if (cell.type === 'error') return { value: null, status: 'error', error: String(cell.value || 'Source error') };
  return { value: cell.value ?? null, status: cell.override ? 'override' : cell.value == null ? 'blank' : 'ok' };
}
export function resultLabel(result) { return result.status === 'error' ? 'Unavailable' : ledgerValue(result.value); }
export function ledgerIssues(sheet, row, headers, calculator) {
  const source = row.warnings || sheet.metadata?.row_warnings?.[row.source_row] || [];
  const issues = (Array.isArray(source) ? source : [source]).map(value => typeof value === 'string' ? value : value?.message || value?.code).filter(Boolean);
  const price = headers.find(header => /^(price|цена)(\b|\s|$)/i.test(header.label));
  if (price && !row.archived) {
    const result = resultFor(sheet, row, price.column, calculator);
    if (result.status === 'blank' || result.value === null && result.status !== 'error') issues.push('Price is not supplied. A blank price remains unknown.');
  }
  return [...new Set(issues)];
}
export function rowDescription(row, headers) {
  const descriptive = headers.find(item => /description|описан|наименован|назначен|комментар|товар/i.test(item.label));
  const candidates = [descriptive?.column, 'C', ...headers.map(item => item.column)];
  for (const column of candidates) {
    const cell = row.cells?.[column];
    if (cell && !cell.formula && cell.type === 'string' && String(cell.value || '').trim()) return String(cell.value);
  }
  return row.source_row ? `Source row ${row.source_row}` : 'Manual entry';
}
export function ledgerFailure(error) {
  if (error?.code === '42501') return 'Only the active Owner can open or change this ledger.';
  if (['PGRST202', '42883', '42P01'].includes(error?.code)) return 'The ledger is not available yet. Refresh after setup is finished.';
  if (error?.code === '40001' || /version|conflict|changed/i.test(error?.message || '')) return 'This record changed elsewhere. Your entries are kept; review the latest values before saving again.';
  if (error?.code === '23514' || error?.code === '22023') return 'Check the field values and provide a reason for this change.';
  return 'The request could not be confirmed. Your entries are kept. Check the connection and retry.';
}
