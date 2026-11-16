import { element, renderNotice } from './ui.js';
import { WORKS, AVAILABLE_WORKS } from './catalogue.js';
import { field, button, HOOD_WORKS, financialSummary } from './order-shared.js';

// A supplement records an omission; it never rewrites existing task history.
export function createCompletionEditor({ record, staff, rpc, mutate, isActive, closeEditor }) {
  let disposed = false, quoteVersion = 0;
  const existing = (record.tasks || []).filter(task => task.status !== 'cancelled');
  const available = new Set(AVAILABLE_WORKS[record.vehicle_group_code] || []);
  const work = element('select', { id: 'completion-work', required: true, onchange: updateWork },
    element('option', { value: '' }, 'Choose omitted catalogue work'),
    WORKS.filter(item => available.has(item.code)).map(item => {
      const duplicate = existing.some(task => task.work_code === item.code);
      const incompatible = HOOD_WORKS.has(item.code) && existing.some(task => HOOD_WORKS.has(task.work_code) && task.work_code !== item.code);
      return element('option', { value: item.code, disabled: duplicate || incompatible }, `${item.name}${duplicate ? ' · already recorded' : incompatible ? ' · another hood package recorded' : ''}`);
    }));
  const mechanic = element('select', { id: 'completion-mechanic', required: true },
    element('option', { value: '' }, 'Choose the mechanic who performed it'),
    staff.map(member => element('option', { value: member.id }, member.name)));
  const completed = element('input', { id: 'completion-time', type: 'datetime-local', required: true });
  const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  completed.max = localNow;
  const note = element('textarea', { id: 'completion-reason', rows: '3', required: true, maxlength: '2000' });
  const tint = element('select', { id: 'completion-tint', onchange: quote }, element('option', { value: '' }, 'Choose tint level'),
    ...[5, 15].map(percent => element('option', { value: String(percent), disabled: existing.some(task => task.work_code === 'W19' && task.options?.tint_percent === percent) }, `${percent}%`)));
  const tintField = field('Tint level', tint);
  tintField.hidden = true; tint.disabled = true;
  const quoteArea = element('div', { class: 'order-price-preview', 'aria-live': 'polite', 'aria-label': 'Owner work amounts' });
  const feedback = element('p', { class: 'form-feedback', role: 'status' });
  const save = button('Record completed work', () => {}, 'button button-primary');
  save.type = 'submit';
  const fields = element('fieldset', { 'data-mutation-fields': '', class: 'order-form-fields' },
    element('legend', {}, `Record omitted completed work · ${record.order_number}`),
    element('p', { class: 'field-hint' }, `Vehicle: ${record.vehicle}${record.vin ? ` · VIN: ${record.vin}` : ''}`),
    element('p', { class: 'field-hint' }, 'Use this only for work already performed but missing from this order. Existing completions and the order status stay recorded.'),
    element('div', { class: 'form-grid' }, field('Omitted catalogue work', work), tintField,
      field('Performed by', mechanic), field('Recorded completion date and time', completed, 'Use the actual time when known. Otherwise use the Owner confirmation time and state that the exact time is unknown in the reason. Times use your local timezone.')),
    field('Reason for the correction', note, 'Explain why this completed task was missing. Your account and the recording time are saved in the history.'),
    element('p', { class: 'field-hint' }, 'The omitted task receives the currently approved rate. The amounts below are private to the Owner.'),
    quoteArea, feedback, element('div', { class: 'button-row form-actions' }, save, button('Cancel', closeEditor)));
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
      quoteArea.replaceChildren(element('p', { class: 'field-hint' }, 'Choose the omitted work to preview its Owner amount.')); return;
    }
    quoteArea.replaceChildren(element('p', { class: 'field-hint' }, 'Calculating the omitted work…'));
    try {
      const result = await rpc('garage_quote_order', { p_vehicle_group_code: record.vehicle_group_code,
        p_tasks: [{ work_code: work.value, options: options() }], p_order_id: null });
      if (!disposed && isActive() && version === quoteVersion) quoteArea.replaceChildren(financialSummary(result, true));
    } catch {
      if (!disposed && isActive() && version === quoteVersion) quoteArea.replaceChildren(
        renderNotice('Amounts unavailable', 'Your entries are kept. Retry the private calculation.', 'error'), button('Retry calculation', quote));
    }
  }
  async function submit(event) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const actual = new Date(completed.value);
    if (!Number.isFinite(actual.getTime()) || actual.getTime() > Date.now() || !note.value.trim()) {
      feedback.textContent = 'Enter a valid past recorded completion time and explain this correction.'; return;
    }
    const saved = await mutate('garage_record_omitted_completion', { p_order_id: record.id, p_expected_version: record.version,
      p_work_code: work.value, p_options: options(), p_mechanic_id: mechanic.value,
      p_completed_at: actual.toISOString(), p_note: note.value.trim() }, 'The omitted completion was added. Existing task history is preserved.');
    if (saved && isActive()) closeEditor();
  }
  return { element: form, mode: 'completion', quote, dispose() { disposed = true; quoteVersion += 1; } };
}
