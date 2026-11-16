import { element, renderNotice } from './ui.js';
import { clone, same, ledgerButton, ledgerField, ledgerHeaders, ledgerSectionLabel, ledgerValue, resultFor } from './ledger-shared.js';

export function createLedgerEditor({ sheet, section, row, sampleRows = [], getCalculator, save, close }) {
  let record = row ? clone(row) : null, baseline = clone(row?.cells || {}), active = true;
  const controls = new Map(), headers = ledgerHeaders(sheet, section, row ? [row] : sampleRows);
  const form = element('form', { class: 'ledger-form', onsubmit: submit });
  const fields = element('fieldset', { 'data-ledger-fields': '' });
  const inputs = element('div', { class: 'ledger-form-grid' });
  const derived = element('div', { class: 'ledger-form-grid' });
  const conflict = element('div', { class: 'ledger-conflict', 'aria-live': 'polite' });
  const feedback = element('p', { role: 'status', class: 'form-feedback' });
  const reason = element('textarea', { id: 'ledger-edit-reason', rows: '2', maxlength: '2000', required: true });
  for (const header of headers) {
    const template = row?.cells?.[header.column] || sampleRows.find(item => item.cells?.[header.column])?.cells?.[header.column] || {};
    const cell = baseline[header.column] || {};
    const formula = record && Boolean(cell.formula);
    const inferred = header.type || template.type || (/date|дата/i.test(header.label) ? 'date'
      : /price|cost|amount|area|rate|цена|стоимость|сумма|площадь|курс/i.test(header.label) ? 'number' : 'string');
    const type = formula || inferred === 'error' ? 'number' : inferred;
    const value = Object.hasOwn(cell, 'value') ? cell.value : null;
    const calculated = formula ? resultFor(sheet, record, header.column, getCalculator()) : null;
    const shown = formula && !cell.override ? calculated?.value : value;
    const attributes = { id: `ledger-field-${header.column}`, type: cell.type === 'error' && !formula ? 'text' : type === 'number' ? 'number' : type === 'date' ? 'date' : 'text',
      value: shown == null || formula && cell.type === 'error' && !cell.override ? '' : String(shown), step: type === 'number' ? 'any' : null };
    const control = type === 'boolean'
      ? element('select', { id: attributes.id }, element('option', { value: '' }, 'Не указано'),
        element('option', { value: 'true', selected: value === true }, 'Да'), element('option', { value: 'false', selected: value === false }, 'Нет'))
      : /description|описан|назван|наименован|комментар/i.test(header.label)
        ? element('textarea', { ...attributes, rows: '3' }) : element('input', attributes);
    const wrapper = ledgerField(`${header.column} · ${header.label}`, control);
    const override = formula ? element('input', { type: 'checkbox', id: `ledger-override-${header.column}`, checked: cell.override === true,
      onchange: () => { control.disabled = !override.checked; if (override.checked) control.focus(); } }) : null;
    if (formula) {
      control.disabled = !override.checked;
      wrapper.append(element('label', { class: 'ledger-override', for: override.id }, override, 'Задать значение вручную'),
        element('p', { class: 'field-hint' }, calculated?.status === 'error' ? calculated.error || 'Требуется проверка исходного расчёта.' : 'Исходная формула сохраняется.'),
        element('code', { class: 'ledger-cell-note' }, cell.formula));
    } else if (cell.type === 'error') wrapper.append(element('p', { class: 'field-hint' }, 'Исходное значение недоступно. Введите число или оставьте его без изменений.'));
    controls.set(header.column, { control, override, type, template, initialText: control.value, initialOverride: override?.checked });
    (formula ? derived : inputs).append(wrapper);
  }
  const submitButton = ledgerButton(record ? 'Сохранить изменения' : 'Добавить запись', () => {}, true);
  submitButton.type = 'submit';
  fields.append(element('legend', {}, record ? `Изменить: ${sheet.name} · ${record.source_row ? `строка ${record.source_row}` : 'ручная запись'}`
    : `Добавить запись · ${ledgerSectionLabel(sheet.metadata?.sections?.find(item => item.id === section) || { id: section })}`),
    element('p', { class: 'ledger-notice' }, record
      ? 'Изменения сохраняются в приложении. Исходные значения и формулы книги остаются доступны.'
      : 'Ручная запись включается в текущие итоги раздела. Исходные формулы листа сохраняют свои диапазоны.'), inputs,
    derived.childElementCount ? element('details', { class: 'ledger-source-detail' }, element('summary', {}, 'Сохранённые расчёты и ручные значения'),
      element('p', { class: 'ledger-notice' }, 'Расчётные значения обновятся после сохранения изменений.'), derived) : null,
    element('div', { class: 'ledger-reason' }, element('label', { for: reason.id }, 'Причина изменения'), reason),
    conflict, feedback, element('div', { class: 'button-row' }, submitButton, ledgerButton('Отменить редактирование', close)));
  form.append(fields);

  function read(control, type) {
    if (control.value.trim() === '') return null;
    if (type === 'number') {
      const value = Number(control.value);
      if (!Number.isFinite(value)) throw new Error('Введите корректные числовые значения.');
      return value;
    }
    if (type === 'boolean') return control.value === 'true';
    return control.value;
  }
  function cells() {
    const next = clone(baseline);
    for (const [column, entry] of controls) {
      if (entry.control.value === entry.initialText && entry.override?.checked === entry.initialOverride) continue;
      if (entry.override && !entry.override.checked) {
        next[column] = { ...next[column], override: false }; continue;
      }
      const value = read(entry.control, entry.type);
      if (value === null && !Object.hasOwn(next, column)) continue;
      next[column] = { ...(next[column] || { formula: null, cached: null, format: entry.template.format || '' }),
        value, type: entry.type, ...(entry.override ? { override: true } : {}) };
    }
    return next;
  }
  async function submit(event) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    try {
      const next = cells();
      if (!record && !Object.values(next).some(cell => cell.value != null && cell.value !== '')) {
        feedback.textContent = 'Заполните хотя бы одно значение записи.'; return;
      }
      const result = await save('garage_ledger_save_row', { p_row_id: record?.id || null, p_expected_version: record?.version || 0,
        p_cells: next, p_section: record?.section || section, p_archived: record?.archived || false, p_reason: reason.value.trim() });
      if (result && active) close();
    } catch (error) { if (active) feedback.textContent = error.message; }
  }
  function showConflict(latest) {
    if (!active || !record || !latest) return;
    let entered;
    try { entered = cells(); } catch { return; }
    const changed = Object.keys(entered).filter(column => !same(entered[column], baseline[column]));
    const review = element('dl', { class: 'ledger-values' }, changed.map(column => element('div', {},
      element('dt', {}, headers.find(header => header.column === column)?.label || column),
      element('dd', {}, `Ваш ввод: ${ledgerValue(entered[column]?.value)} · Последнее сохранённое значение: ${ledgerValue(latest.cells?.[column]?.value)}`))));
    conflict.replaceChildren(renderNotice('Проверьте последнюю версию', 'Ваш ввод сохранён в форме. Проверьте значения ниже перед применением изменений к последней версии.'), review,
      ledgerButton('Применить мой ввод к последней версии', () => {
        const merged = { ...clone(latest.cells) };
        for (const column of changed) merged[column] = entered[column];
        baseline = clone(latest.cells); record = clone(latest);
        for (const [column, entry] of controls) {
          const cell = merged[column] || {};
          const latestCell = baseline[column] || {};
          const latestResult = latestCell.formula && !latestCell.override ? resultFor(sheet, record, column, getCalculator()) : { value: latestCell.value };
          entry.initialText = latestResult.value == null || latestCell.formula && latestCell.type === 'error' && !latestCell.override ? '' : String(latestResult.value);
          entry.initialOverride = entry.override ? latestCell.override === true : undefined;
          if (entry.override) { entry.override.checked = cell.override === true; entry.control.disabled = !entry.override.checked; }
          const result = cell.formula && !cell.override ? resultFor(sheet, record, column, getCalculator()) : { value: cell.value };
          entry.control.value = result.value == null || cell.formula && cell.type === 'error' && !cell.override ? '' : String(result.value);
        }
        conflict.replaceChildren(renderNotice('Последняя версия загружена', 'Ваши изменения сохранены в форме. Проверьте и сохраните объединённую запись.'));
      }));
  }
  return { element: form, showConflict, dispose() { active = false; } };
}
