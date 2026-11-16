import { element } from './ui.js';
import { ledgerButton, ledgerHeaders, ledgerIssues, ledgerReadOnly, ledgerValue, resultFor, resultLabel, rowDescription } from './ledger-shared.js';

function valuesView(headers, row, sheet, calculator, original = false) {
  return element('dl', { class: 'ledger-values' }, headers.filter(header => {
    const cell = (original ? row.original_cells : row.cells)?.[header.column];
    return cell && (cell.value != null || cell.cached != null || cell.formula);
  }).map(header => {
    const cell = (original ? row.original_cells : row.cells)[header.column];
    const result = original ? { value: cell.formula ? cell.cached : cell.value, status: 'ok' }
      : resultFor(sheet, row, header.column, calculator);
    return element('div', {}, element('dt', {}, `${header.column} · ${header.label}`),
      element('dd', {}, resultLabel(result)),
      result.status === 'error' ? element('p', { class: 'ledger-cell-note is-warning' }, result.error || 'Source calculation needs review.') : null,
      result.warning ? element('p', { class: 'ledger-cell-note is-warning' }, result.warning) : null,
      cell.formula ? element('p', { class: 'ledger-cell-note' }, cell.override && !original ? 'Manual override · ' : 'Source formula · ', element('code', {}, cell.formula)) : null);
  }));
}

export function renderLedgerRows({ sheet, rows, section, calculator, expanded, edit, history }) {
  const headers = ledgerHeaders(sheet, section, rows);
  const amount = headers.find(item => /^(price|цена|сумма|стоимость)(\b|\s|$)/i.test(item.label)) || headers.find(item => item.column === 'B');
  const date = headers.find(item => /date|дат[аы]/i.test(item.label)) || headers.find(item => item.column === 'A');
  const list = element('div', { class: 'ledger-list', 'aria-label': 'Ledger records' },
    element('div', { class: 'ledger-column-headings', 'aria-hidden': 'true' },
      ...['Row', date?.label || 'Date', 'Description / entry', amount?.label || 'Value', 'Review', ''].map(label => element('span', {}, label))));
  if (!rows.length) list.append(element('div', { class: 'ledger-empty' }, element('h2', {}, 'No matching records'),
    element('p', {}, 'Change the filters or add an entry to this section.')));
  for (const row of rows) {
    const readOnly = ledgerReadOnly(sheet, section, row);
    const results = headers.map(header => resultFor(sheet, row, header.column, calculator));
    const errors = results.filter(result => result.status === 'error').length;
    const overrides = results.filter(result => result.status === 'override').length;
    const issues = ledgerIssues(sheet, row, headers, calculator);
    const state = row.archived ? 'Archived' : errors ? `${errors} unavailable` : issues.length ? 'Review needed' : overrides ? `${overrides} overridden` : row.version > 1 ? 'Edited' : 'Source';
    const details = element('details', { class: 'ledger-record', 'data-ledger-row': row.id });
    details.open = expanded.has(row.id);
    details.addEventListener('toggle', () => details.open ? expanded.add(row.id) : expanded.delete(row.id));
    details.append(element('summary', { class: 'ledger-summary' },
      element('span', { class: 'ledger-row-number' }, row.source_row || 'New'),
      element('span', { class: 'ledger-row-date' }, date ? resultLabel(resultFor(sheet, row, date.column, calculator)) : '—'),
      element('span', { class: 'ledger-row-description' }, rowDescription(row, headers)),
      element('span', { class: 'ledger-row-amount' }, amount ? resultLabel(resultFor(sheet, row, amount.column, calculator)) : '—'),
      element('span', { class: `ledger-row-state${row.archived ? ' is-archived' : errors || issues.length ? ' is-warning' : row.version > 1 ? ' is-edited' : ''}` }, state),
      element('span', { class: 'ledger-chevron', 'aria-hidden': 'true' }, '⌄')));
    const body = element('div', { class: 'ledger-record-body' },
      ...issues.map(issue => element('p', { class: 'ledger-cell-note is-warning' }, issue)),
      valuesView(headers, row, sheet, calculator),
      element('p', { class: 'ledger-cell-note' }, row.source_row
        ? `${sheet.name} · source row ${row.source_row} · revision ${row.version}`
        : `Manual entry · revision ${row.version} · outside original worksheet formula ranges`),
      row.original_cells ? element('details', { class: 'ledger-source-detail' }, element('summary', {}, 'Original workbook values and formulas'),
        valuesView(headers, row, sheet, calculator, true)) : null,
      readOnly ? element('p', { class: 'ledger-notice' }, 'Source header or template. Add a record in Work entries to include it in current entry totals.')
        : element('div', { class: 'button-row' }, ledgerButton('Edit entry', () => edit(row)),
          ledgerButton(row.archived ? 'History and restore' : 'History / archive', () => history(row))));
    details.append(body); list.append(details);
  }
  return list;
}

export function sectionTotals({ sheet, rows, section, calculator }) {
  const headers = ledgerHeaders(sheet, section, rows), active = rows.filter(row => !row.archived);
  const totals = headers.filter(header => !/rate|курс|процент|%|date|дата|цена\s*(за|м)/i.test(header.label)).flatMap(header => {
    let total = 0, numbers = 0, missing = 0, blanks = 0;
    const price = /^(price|цена)(\b|\s|$)/i.test(header.label);
    for (const row of active) {
      const result = resultFor(sheet, row, header.column, calculator);
      if (result.status === 'error') missing++;
      else if (typeof result.value === 'number' && Number.isFinite(result.value)) { total += result.value; numbers++; }
      else if (result.value === null || result.value === undefined || result.value === '') { blanks++; if (price) missing++; }
    }
    return numbers || missing ? [element('div', {}, element('dt', {}, `${header.column} · ${header.label}`),
      element('dd', {}, missing ? 'Unavailable' : ledgerValue(total)),
      missing ? element('p', { class: 'ledger-cell-note is-warning' }, `${missing} unresolved value${missing === 1 ? '' : 's'}; known values total ${ledgerValue(total)}.`)
        : blanks ? element('p', { class: 'ledger-cell-note' }, `${numbers} entered values; ${blanks} blank field${blanks === 1 ? '' : 's'} excluded.`) : null)] : [];
  });
  return element('details', { class: 'ledger-source-detail' }, element('summary', {}, 'Current section column totals'),
    element('p', { class: 'ledger-notice' }, 'Active records are totaled by column, including manual entries. Original worksheet formulas retain their source ranges. Unresolved values keep a column total unavailable.'),
    element('dl', { class: 'ledger-values' }, totals));
}
