export const columnOrder = value => [...value].reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0);
const LABELS = {
  Date: 'Дата', Price: 'Цена', Description: 'Описание', 'Exchange rate': 'Курс', Area: 'Площадь',
  'Film cost': 'Стоимость плёнки', 'Owner earnings': 'Доход владельца', 'Staff allocation': 'Начисление сотруднику',
  Rent: 'Аренда', Expense: 'Расход', Income: 'Доход', 'Income/residual': 'Доход / остаток', Payer: 'Плательщик',
  'Invoice number': 'Номер счёта', 'Invoice#': 'Номер счёта', Cash: 'Наличные', 'Bank BYN': 'Банк BYN',
  'Source headers': 'Заголовки', 'Work entries': 'Основные записи', 'Source totals': 'Исходный итог',
  'Blank template rows': 'Пустые строки шаблона', Expenses: 'Расходы', Advances: 'Авансы', Summary: 'Итоги',
  'Additional entries': 'Дополнительные записи', 'Film sales / stock': 'Продажи и остатки плёнки'
};
const WARNINGS = {
  cached_source_snapshot: 'Сохранены исходные значения книги и формулы. Исходный снимок не пересчитывался.',
  source_cached_errors: 'В исходной книге есть ошибки. Проверьте указанные листы и ячейки.',
  source_cached_error: 'В исходной ячейке сохранена ошибка.',
  formula_without_expression: 'В исходной книге отсутствует выражение формулы или связанная опорная ячейка.',
  overlapping_source_view: 'Этот раздел может повторять месячные записи. Его суммы нельзя прибавлять к месячным итогам.',
  date_header_inferred: 'Столбец даты определён по типу исходных значений. Исходный заголовок сохранён.',
  main_boundary_uncertain: 'Не найдена исходная формула промежуточного итога по цене. Все строки сохранены для проверки.',
  missing_price: 'Для записи не указана базовая цена. Пустая цена остаётся неизвестной.',
  date_outside_sheet_period: 'Исходная дата отличается от месяца в названии листа.',
  subtotal_excludes_described_rows: 'Исходная формула SUM не включает некоторые заполненные строки перед итогом.',
  cached_subtotal_mismatch: 'Сохранённый исходный итог не совпадает с суммой числовых значений в его диапазоне.'
};
export const ledgerLabel = value => LABELS[value] || value;
export function ledgerSectionLabel(section) {
  if (section?.label && section.label !== section.id) return ledgerLabel(section.label);
  return ({ ledger: 'Основные записи', entries: 'Основные записи', source_headers: 'Заголовки', template: 'Пустые строки шаблона',
    ledger_totals: 'Исходный итог', expenses: 'Расходы', advances: 'Авансы', summary: 'Итоги', stock: 'Плёнка',
    unclassified: 'Дополнительные записи', staff_extract: 'Выписка сотрудника', quarterly: 'Квартальный отчёт' })[section?.kind || section?.id] || 'Раздел';
}
export function ledgerWarning(warning) {
  const message = typeof warning === 'string' ? warning : warning?.message || '';
  const translated = WARNINGS[warning?.code] || (/[А-Яа-яЁё]/.test(message) ? message : 'Исходные данные требуют проверки.');
  const details = [warning?.cell, warning?.count != null ? `Количество: ${warning.count}` : '',
    warning?.rows?.length ? `Строки: ${warning.rows.join(', ')}` : '', /^#[A-Z0-9/!?]+$/.test(message) ? message : ''].filter(Boolean);
  return `${translated}${details.length ? ` · ${details.join(' · ')}` : ''}`;
}
export function ledgerReadOnly(sheet, section, row) {
  const selected = sheet.metadata?.sections?.find(item => item.id === section);
  return /^(header|template)$/.test(row?.metadata?.role || row?.role || '')
    || /header|template/i.test(selected?.kind || '') || /(^|_)(headers?|templates?)($|_)/i.test(section);
}
export function ledgerHeaders(sheet, section, rows = []) {
  const selected = sheet.metadata?.sections?.find(item => item.id === section);
  const base = selected?.headers || sheet.metadata?.section_headers?.[section] || sheet.metadata?.headers || [];
  const headers = new Map(base.filter(item => /^[A-Z]{1,3}$/.test(item.column))
    .map(item => [item.column, { ...item, sourceLabel: item.label, label: ledgerLabel(item.label) }]));
  for (const row of rows) for (const column of Object.keys(row.cells || {})) {
    if (!headers.has(column)) headers.set(column, { column, label: column });
  }
  return [...headers.values()].sort((a, b) => columnOrder(a.column) - columnOrder(b.column));
}
export function ledgerValue(value, type) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (typeof value === 'number') return Number.isFinite(value)
    ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 }).format(value) : 'Недоступно';
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
    if (!Number.isNaN(date.getTime())) return String(value).length === 10 ? date.toLocaleDateString('ru-RU') : date.toLocaleString('ru-RU');
  }
  return String(value);
}
export function resultFor(sheet, row, column, calculator) {
  const cell = row.cells?.[column];
  if (!cell) return { value: null, status: 'blank' };
  if (cell.formula && !cell.override) {
    try { return calculator?.getCell(sheet.name, column, row.source_row)
      || { value: null, status: 'error', error: 'Данные для расчёта недоступны.' }; }
    catch { return { value: null, status: 'error', error: 'Не удалось вычислить исходную формулу.' }; }
  }
  if (cell.type === 'error') return { value: null, status: 'error', error: String(cell.value || 'Ошибка в исходной книге') };
  return { value: cell.value ?? null, status: cell.override ? 'override' : cell.value == null ? 'blank' : 'ok' };
}
export function resultLabel(result, type) { return result.status === 'error' ? 'Недоступно' : ledgerValue(result.value, type); }
export function ledgerIssues(sheet, row, headers, calculator) {
  const source = [row.warnings || [], row.metadata?.warnings || [], sheet.metadata?.row_warnings?.[row.source_row] || []].flat();
  const issues = source.map(ledgerWarning).filter(Boolean);
  const price = headers.find(header => /^(price|цена)(\b|\s|$)/i.test(header.label));
  if (price && !row.archived) {
    const result = resultFor(sheet, row, price.column, calculator);
    if (result.status === 'blank' || result.value === null && result.status !== 'error') issues.push('Цена не указана. Пустая цена остаётся неизвестной.');
  }
  return [...new Set(issues)];
}
export function rowDescription(row, headers) {
  const descriptive = headers.find(item => /description|описан|назван|наименован|назначен|комментар|товар/i.test(item.label));
  const candidates = [descriptive?.column, 'C', ...headers.map(item => item.column)];
  for (const column of candidates) {
    const cell = row.cells?.[column];
    if (cell && !cell.formula && cell.type === 'string' && String(cell.value || '').trim()) return String(cell.value);
  }
  return row.source_row ? `Исходная строка ${row.source_row}` : 'Ручная запись';
}
export function ledgerFailure(error) {
  if (error?.code === '42501') return 'Открывать и изменять этот журнал может только владелец с действующим доступом.';
  if (['PGRST202', '42883', '42P01'].includes(error?.code)) return 'Журнал пока недоступен. Обновите страницу после завершения настройки.';
  if (error?.code === '40001' || /version|conflict|changed/i.test(error?.message || '')) return 'Запись изменена в другом сеансе. Ваш ввод сохранён в форме; проверьте последние значения перед повторным сохранением.';
  if (error?.code === '23514' || error?.code === '22023') return 'Проверьте значения полей и укажите причину изменения.';
  return 'Не удалось подтвердить запрос. Ваш ввод сохранён в форме. Проверьте соединение и повторите попытку.';
}
