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
    return element('div', {}, element('dt', {}, `${header.column} · ${original ? header.sourceLabel || header.label : header.label}`),
      element('dd', {}, resultLabel(result, cell.type)),
      result.status === 'error' ? element('p', { class: 'ledger-cell-note is-warning' }, result.error || 'Требуется проверка исходного расчёта.') : null,
      result.warning ? element('p', { class: 'ledger-cell-note is-warning' }, result.warning) : null,
      cell.formula ? element('p', { class: 'ledger-cell-note' }, cell.override && !original ? 'Значение задано вручную · ' : 'Исходная формула · ', element('code', {}, cell.formula)) : null);
  }));
}

export function renderLedgerRows({ sheet, rows, section, calculator, expanded, edit, history }) {
  const headers = ledgerHeaders(sheet, section, rows);
  const amount = headers.find(item => /^(price|цена|сумма|стоимость)(\b|\s|$)/i.test(item.label)) || headers.find(item => item.column === 'B');
  const date = headers.find(item => /date|дат[аы]/i.test(item.label)) || headers.find(item => item.column === 'A');
  const list = element('div', { class: 'ledger-list', 'aria-label': 'Записи журнала' },
    element('div', { class: 'ledger-column-headings', 'aria-hidden': 'true' },
      ...['Строка', date?.label || 'Дата', 'Описание / запись', amount?.label || 'Значение', 'Проверка', ''].map(label => element('span', {}, label))));
  if (!rows.length) list.append(element('div', { class: 'ledger-empty' }, element('h2', {}, 'Подходящих записей нет'),
    element('p', {}, 'Измените фильтры или добавьте запись в этот раздел.')));
  for (const row of rows) {
    const readOnly = ledgerReadOnly(sheet, section, row);
    const results = headers.map(header => resultFor(sheet, row, header.column, calculator));
    const errors = results.filter(result => result.status === 'error').length;
    const overrides = results.filter(result => result.status === 'override').length;
    const issues = ledgerIssues(sheet, row, headers, calculator);
    const state = row.archived ? 'В архиве' : errors ? `Недоступно: ${errors}` : issues.length ? 'Нужна проверка' : overrides ? `Вручную: ${overrides}` : row.version > 1 ? 'Изменено' : 'Исходная запись';
    const details = element('details', { class: 'ledger-record', 'data-ledger-row': row.id });
    details.open = expanded.has(row.id);
    details.addEventListener('toggle', () => details.open ? expanded.add(row.id) : expanded.delete(row.id));
    details.append(element('summary', { class: 'ledger-summary' },
      element('span', { class: 'ledger-row-number' }, row.source_row || 'Новая'),
      element('span', { class: 'ledger-row-date' }, date ? resultLabel(resultFor(sheet, row, date.column, calculator), row.cells?.[date.column]?.type) : '—'),
      element('span', { class: 'ledger-row-description' }, rowDescription(row, headers)),
      element('span', { class: 'ledger-row-amount' }, amount ? resultLabel(resultFor(sheet, row, amount.column, calculator)) : '—'),
      element('span', { class: `ledger-row-state${row.archived ? ' is-archived' : errors || issues.length ? ' is-warning' : row.version > 1 ? ' is-edited' : ''}` }, state),
      element('span', { class: 'ledger-chevron', 'aria-hidden': 'true' }, '⌄')));
    const body = element('div', { class: 'ledger-record-body' },
      ...issues.map(issue => element('p', { class: 'ledger-cell-note is-warning' }, issue)),
      valuesView(headers, row, sheet, calculator),
      element('p', { class: 'ledger-cell-note' }, row.source_row
        ? `${sheet.name} · исходная строка ${row.source_row} · версия ${row.version}`
        : `Ручная запись · версия ${row.version} · вне диапазонов исходных формул листа`),
      row.original_cells ? element('details', { class: 'ledger-source-detail' }, element('summary', {}, 'Исходные значения и формулы книги'),
        valuesView(headers, row, sheet, calculator, true)) : null,
      readOnly ? element('p', { class: 'ledger-notice' }, 'Исходный заголовок или шаблон. Добавьте запись в раздел «Основные записи», чтобы включить её в текущие итоги.')
        : element('div', { class: 'button-row' }, ledgerButton('Изменить запись', () => edit(row)),
          ledgerButton(row.archived ? 'История и восстановление' : 'История / архив', () => history(row))));
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
      element('dd', {}, missing ? 'Недоступно' : ledgerValue(total)),
      missing ? element('p', { class: 'ledger-cell-note is-warning' }, `Неподтверждённых значений: ${missing}. Сумма известных значений: ${ledgerValue(total)}.`)
        : blanks ? element('p', { class: 'ledger-cell-note' }, `Заполненных значений: ${numbers}. Пустых полей исключено: ${blanks}.`) : null)] : [];
  });
  return element('details', { class: 'ledger-source-detail' }, element('summary', {}, 'Текущие итоги по столбцам раздела'),
    element('p', { class: 'ledger-notice' }, 'Суммируются действующие записи, включая добавленные вручную. Исходные формулы листа сохраняют свои диапазоны. Пока есть неподтверждённые значения, итог столбца недоступен.'),
    element('dl', { class: 'ledger-values' }, totals));
}
