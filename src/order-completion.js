import { element, renderNotice } from './ui.js';
import { WORKS, AVAILABLE_WORKS } from './catalogue.js';
import { field, button, HOOD_WORKS, financialSummary } from './order-shared.js';

// A supplement records an omission; it never rewrites existing task history.
export function createCompletionEditor({ record, staff, rpc, mutate, isActive, closeEditor }) {
  let disposed = false, quoteVersion = 0;
  const existing = (record.tasks || []).filter(task => task.status !== 'cancelled');
  const available = new Set(AVAILABLE_WORKS[record.vehicle_group_code] || []);
  const work = element('select', { id: 'completion-work', required: true, onchange: updateWork },
    element('option', { value: '' }, 'Выберите пропущенную работу из каталога'),
    WORKS.filter(item => available.has(item.code)).map(item => {
      const duplicate = existing.some(task => task.work_code === item.code);
      const incompatible = HOOD_WORKS.has(item.code) && existing.some(task => HOOD_WORKS.has(task.work_code) && task.work_code !== item.code);
      return element('option', { value: item.code, disabled: duplicate || incompatible }, `${item.name}${duplicate ? ' · уже учтено' : incompatible ? ' · уже учтён другой вариант оклейки капота' : ''}`);
    }));
  const mechanic = element('select', { id: 'completion-mechanic', required: true },
    element('option', { value: '' }, 'Выберите выполнившего работу механика'),
    staff.map(member => element('option', { value: member.id }, member.name)));
  const completed = element('input', { id: 'completion-time', type: 'datetime-local', required: true });
  const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  completed.max = localNow;
  const note = element('textarea', { id: 'completion-reason', rows: '3', required: true, maxlength: '2000' });
  const tint = element('select', { id: 'completion-tint', onchange: quote }, element('option', { value: '' }, 'Выберите светопропускание'),
    ...[5, 15].map(percent => element('option', { value: String(percent), disabled: existing.some(task => task.work_code === 'W19' && task.options?.tint_percent === percent) }, `${percent}%`)));
  const tintField = field('Светопропускание', tint);
  tintField.hidden = true; tint.disabled = true;
  const quoteArea = element('div', { class: 'order-price-preview', 'aria-live': 'polite', 'aria-label': 'Стоимость работ для владельца' });
  const feedback = element('p', { class: 'form-feedback', role: 'status' });
  const save = button('Записать выполненную работу', () => {}, 'button button-primary');
  save.type = 'submit';
  const fields = element('fieldset', { 'data-mutation-fields': '', class: 'order-form-fields' },
    element('legend', {}, `Добавление пропущенной выполненной работы · ${record.order_number}`),
    element('p', { class: 'field-hint' }, `Автомобиль: ${record.vehicle}${record.vin ? ` · VIN: ${record.vin}` : ''}`),
    element('p', { class: 'field-hint' }, 'Добавляйте только уже выполненные работы, пропущенные в заказе. История выполнения и статус заказа сохранятся.'),
    element('div', { class: 'form-grid' }, field('Пропущенная работа из каталога', work), tintField,
      field('Исполнитель', mechanic), field('Дата и время выполнения', completed, 'Укажите фактическое время. Если оно неизвестно, укажите время подтверждения владельцем и поясните это в причине. Используется ваш местный часовой пояс.')),
    field('Причина исправления', note, 'Объясните, почему выполненная работа отсутствовала в заказе. Автор и время записи сохранятся в истории.'),
    element('p', { class: 'field-hint' }, 'Для добавленной работы применяется действующая утверждённая расценка. Суммы ниже видны только владельцу.'),
    quoteArea, feedback, element('div', { class: 'button-row form-actions' }, save, button('Отмена', closeEditor)));
  const form = element('form', { class: 'new-order-form completion-form', onsubmit: submit }, fields);

  function options() { return work.value === 'W19' ? { tint_percent: Number(tint.value) } : {}; }
  function updateWork() {
    tintField.hidden = work.value !== 'W19'; tint.disabled = tintField.hidden; tint.required = !tintField.hidden;
    if (tintField.hidden) tint.value = '';
    quote();
  }
  async function quote() {
    const version = ++quoteVersion;
    if (!work.value || (work.value === 'W19' && !['5', '15'].includes(tint.value))) {
      quoteArea.replaceChildren(element('p', { class: 'field-hint' }, 'Выберите пропущенную работу для предварительного расчёта стоимости.')); return;
    }
    quoteArea.replaceChildren(element('p', { class: 'field-hint' }, 'Рассчитываем пропущенную работу…'));
    try {
      const result = await rpc('garage_quote_order', { p_vehicle_group_code: record.vehicle_group_code,
        p_tasks: [{ work_code: work.value, options: options() }], p_order_id: null });
      if (!disposed && isActive() && version === quoteVersion) quoteArea.replaceChildren(financialSummary(result, true));
    } catch {
      if (!disposed && isActive() && version === quoteVersion) quoteArea.replaceChildren(
        renderNotice('Стоимость недоступна', 'Введённые данные сохранены. Повторите расчёт стоимости.', 'error'), button('Повторить расчёт', quote));
    }
  }
  async function submit(event) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const actual = new Date(completed.value);
    if (!Number.isFinite(actual.getTime()) || actual.getTime() > Date.now() || !note.value.trim()) {
      feedback.textContent = 'Укажите корректное время выполнения в прошлом и причину исправления.'; return;
    }
    const saved = await mutate('garage_record_omitted_completion', { p_order_id: record.id, p_expected_version: record.version,
      p_work_code: work.value, p_options: options(), p_mechanic_id: mechanic.value,
      p_completed_at: actual.toISOString(), p_note: note.value.trim() }, 'Пропущенная выполненная работа добавлена. История остальных работ сохранена.');
    if (saved && isActive()) closeEditor();
  }
  return { element: form, mode: 'completion', quote, dispose() { disposed = true; quoteVersion += 1; } };
}
