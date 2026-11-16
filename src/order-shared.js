import { element, renderNotice } from './ui.js';

export const STATUS_LABELS = {
  pending: 'Ожидает', in_progress: 'В работе', blocked: 'Приостановлено',
  completed: 'Выполнено', cancelled: 'Отменено', published: 'Открыт', closed: 'Закрыт'
};
export const TERMINAL_TASKS = new Set(['completed', 'cancelled']);
export const PROTECTED_TASKS = new Set(['in_progress', 'blocked', 'completed']);
export const HOOD_WORKS = new Set(['W01', 'W03', 'W04']);

export function field(label, control, hint = '') {
  return element('div', { class: 'order-field' }, element('label', { for: control.id }, label), control,
    hint ? element('p', { class: 'field-hint' }, hint) : null);
}

export function statusBadge(status) {
  return element('span', { class: `task-status status-${status}` }, STATUS_LABELS[status] || 'Неизвестный статус');
}

export function displayDate(value) {
  if (!value) return '';
  const parts = String(value).slice(0, 10).split('-');
  return parts.length === 3 ? parts.reverse().join('.') : String(value);
}

export function actionError(error, creating = false) {
  if (['PGRST202', '42883', '42P01'].includes(error?.code)) return 'Раздел заказов ещё не настроен. Попросите владельца завершить настройку и повторите попытку.';
  if (error?.code === '42501') return 'У вас нет доступа к этому действию. Обновите страницу, чтобы проверить права.';
  if (error?.code === '40001' || /version|changed|conflict|already|no longer/i.test(error?.message || '')) return 'Работа изменилась. Обновите список и проверьте её состояние перед повторной попыткой.';
  if (!error?.code || /fetch|network|timeout/i.test(error?.message || '')) return 'Не удалось подтвердить изменение. Проверьте подключение и обновите список перед повторной попыткой.';
  return creating
    ? 'Не удалось отправить заказ. Проверьте автомобиль, выбранные работы и назначение механика.'
    : 'Не удалось сохранить изменение. Обновите список, проверьте состояние работы и повторите попытку.';
}

export function button(text, handler, className = 'button button-small') {
  return element('button', { type: 'button', class: className, 'data-order-action': '', onclick: handler }, text);
}

export function managerReference(intake) {
  if (!intake) return null;
  function snapshot(title, value) {
    if (!value) return null;
    return element('section', {}, element('h4', {}, title), element('dl', { class: 'manager-reference-fields' },
      ...[['Дата', 'date'], ['Менеджер', 'manager_label'], ['Автомобиль', 'vehicle'], ['VIN', 'vin'], ['Цвет', 'colour'],
        ['Заявка на оклейку', 'wrapping'], ['Заявка на тонировку', 'tint'], ['Отметка выполнения в таблице', 'completion'], ['Примечания менеджера', 'notes']].map(([label, key]) => {
        const raw = value[key] == null ? '' : String(value[key]);
        const display = key === 'completion' && /^(true|false)$/i.test(raw)
          ? `${raw.toLowerCase() === 'true' ? 'Отмечено как выполненное (да)' : 'Не отмечено как выполненное (нет)'}` : raw || '—';
        return element('div', {}, element('dt', {}, label), element('dd', {}, display));
      })));
  }
  const originals = Array.isArray(intake.original_observations) && intake.original_observations.length
    ? intake.original_observations : [{ raw: intake.original }];
  const latest = Array.isArray(intake.observations) && intake.observations.length ? intake.observations : [{ raw: intake.latest }];
  return element('details', { class: 'manager-reference' }, element('summary', {}, 'Исходная заявка менеджера · только владельцу'),
    ...originals.map(item => snapshot(`Исходный текст таблицы${item.row_number ? ` · Строка ${item.row_number}` : ''}`, item.raw)),
    ...(intake.source_changed ? latest.map(item => snapshot(`Актуальный текст таблицы${item.row_number ? ` · Строка ${item.row_number}` : ''}`, item.raw)) : []));
}

export function financialSummary(values, preview = false) {
  if (!values || values.status !== 'priced' || [values.net_amount, values.vat_amount, values.gross_amount].some(value => value == null || !Number.isFinite(Number(value)))) {
    return renderNotice('Требуется проверка владельца', 'Стоимость части работ ещё не подтверждена. Неизвестные суммы не считаются нулевыми.');
  }
  const money = value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'BYN' }).format(Number(value));
  return element('div', { class: 'financial-summary', 'aria-label': 'Стоимость · только владельцу' },
    element('p', { class: 'eyebrow' }, preview ? 'Выбранные работы · только владельцу · BYN' : 'Сохранённые расценки · только владельцу · BYN'),
    element('p', { class: 'field-hint financial-scope' }, preview ? 'Расчёт по выбранным работам. Для учтённых работ сохраняются прежние расценки.' : 'Суммы включают все неотменённые работы заказа.'),
    element('dl', {}, element('div', {}, element('dt', {}, 'Без НДС'), element('dd', {}, money(values.net_amount))),
      element('div', {}, element('dt', {}, 'НДС'), element('dd', {}, money(values.vat_amount))),
      element('div', {}, element('dt', {}, 'С НДС'), element('dd', {}, money(values.gross_amount)))));
}
