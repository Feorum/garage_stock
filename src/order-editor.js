import { element, renderNotice } from './ui.js';
import { WORKS, VEHICLE_GROUPS, AVAILABLE_WORKS } from './catalogue.js';
import { field, button, PROTECTED_TASKS, HOOD_WORKS, financialSummary, managerReference } from './order-shared.js';

export function createOrderEditor({ mode, record, intakes, staff, rpc, mutate, isActive, closeEditor }) {
  const editing = mode === 'edit', resolving = mode === 'intake';
  const seed = editing ? record : resolving ? { ...(record.latest || record.original || {}), ...(record.suggested_order || {}), source: 'manager' } : {};
  const originalTasks = (editing ? record.tasks || [] : resolving ? record.suggested_tasks || [] : []).filter(task => task.status !== 'cancelled');
  const protectedTasks = editing ? originalTasks.filter(task => PROTECTED_TASKS.has(task.status) || task.working_mechanic_id) : [];
  const reference = resolving ? record : editing ? intakes.find(item => item.order_id === record.id) : null;
  let quoteVersion = 0, disposed = false;
  const vehicle = element('input', { id: 'new-vehicle', name: 'vehicle', required: true, maxlength: '200', placeholder: 'Vehicle model / plate', value: seed.vehicle || '' });
  const vin = element('input', { id: 'new-vin', name: 'vin', maxlength: '64', required: resolving, value: seed.vin || '' });
  const colour = element('input', { id: 'new-colour', name: 'colour', maxlength: '80', value: seed.colour || '' });
  const group = element('select', { id: 'new-group', required: true, onchange: drawChoices }, element('option', { value: '' }, 'Choose vehicle group'),
    VEHICLE_GROUPS.map(item => element('option', { value: item.code }, item.name)));
  const source = element('select', { id: 'new-source', onchange: updateSource }, element('option', { value: 'owner' }, 'Owner assignment'), element('option', { value: 'manager' }, 'Manager shared queue'));
  const assigned = element('select', { id: 'new-assigned', required: true }, element('option', { value: '' }, 'Choose mechanic'),
    staff.map(member => element('option', { value: member.id }, member.name)));
  const manager = element('input', { id: 'new-manager', maxlength: '120', required: resolving, value: seed.manager_label || '' });
  const planned = element('input', { id: 'new-planned', type: 'date', required: resolving, value: seed.planned_date || '' });
  const due = element('input', { id: 'new-due', type: 'date', value: seed.due_date || '' });
  const priority = element('select', { id: 'new-priority' }, element('option', { value: 'normal' }, 'Normal'), element('option', { value: 'high' }, 'High'), element('option', { value: 'urgent' }, 'Urgent'));
  const instructions = element('textarea', { id: 'new-instructions', rows: '3', maxlength: '4000', value: seed.instructions || '' });
  const assignmentField = field(editing ? 'Mechanic for new works' : 'Assign mechanic', assigned,
    editing ? 'Existing assignments stay unchanged. This mechanic receives any newly added works.' : 'This mechanic receives every selected task as a mandatory assignment.');
  const managerField = field(resolving ? 'Manager reference' : 'Manager label (optional)', manager, 'A source reference; it does not verify the person who submitted the request.');
  const choices = element('div', { class: 'work-choices' });
  const selected = new Set(originalTasks.map(task => task.work_code));
  const tint = element('select', { id: 'new-tint', disabled: true }, element('option', { value: '' }, 'Choose tint level'),
    element('option', { value: '5' }, '5%'), element('option', { value: '15' }, '15%'));
  const tintField = field('Tint level', tint);
  tintField.hidden = true;
  const formFeedback = element('p', { class: 'form-feedback', role: 'status' });
  const quoteArea = element('div', { class: 'order-price-preview', 'aria-live': 'polite', 'aria-label': 'Owner work amounts' });
  group.value = seed.vehicle_group_code || '';
  group.disabled = protectedTasks.length > 0;
  source.value = seed.source || 'owner'; source.disabled = mode !== 'new';
  priority.value = seed.priority || 'normal';
  const assignments = [...new Set(originalTasks.map(task => task.assigned_to).filter(Boolean))];
  if (assignments.length === 1) assigned.value = assignments[0];

  function taskPayload() {
    return WORKS.filter(work => selected.has(work.code)).map(work => {
      const previous = originalTasks.find(task => task.work_code === work.code);
      return { ...(editing && previous?.id ? { id: previous.id } : {}), work_code: work.code,
        assigned_to: editing && previous ? previous.assigned_to || null : source.value === 'owner' ? assigned.value || null : null,
        instructions: previous?.instructions || '',
        options: work.code === 'W19' ? { tint_percent: Number(tint.value) } : {} };
    });
  }

  async function quote() {
    const version = ++quoteVersion;
    if (!group.value || !selected.size || (selected.has('W19') && !['5', '15'].includes(tint.value))) {
      quoteArea.replaceChildren(element('p', { class: 'field-hint' }, 'Select works to calculate Owner amounts.')); return;
    }
    quoteArea.replaceChildren(element('p', { class: 'field-hint' }, 'Calculating selected works…'));
    try {
      const result = await rpc('garage_quote_order', { p_vehicle_group_code: group.value, p_tasks: taskPayload(), p_order_id: editing ? record.id : null });
      if (isActive() && !disposed && version === quoteVersion) quoteArea.replaceChildren(financialSummary(result, true));
    } catch {
      if (isActive() && !disposed && version === quoteVersion) quoteArea.replaceChildren(
        renderNotice('Amounts unavailable', 'Your selections are kept. Amounts could not be calculated; retry before saving.', 'error'),
        button('Retry calculation', quote));
    }
  }

  function updateSource() {
    const mandatory = source.value === 'owner';
    assignmentField.hidden = !mandatory;
    assigned.disabled = !mandatory;
    assigned.required = mandatory && !editing;
    managerField.hidden = mandatory;
    manager.disabled = mandatory;
  }

  function updateTint() {
    const required = selected.has('W19');
    tintField.hidden = !required;
    tint.disabled = !required;
    tint.required = required;
    if (!required) tint.value = '';
    tint.disabled = !required || protectedTasks.some(task => task.work_code === 'W19');
  }

  function drawChoices() {
    const available = new Set(AVAILABLE_WORKS[group.value] || []);
    for (const code of selected) if (!available.has(code) && !protectedTasks.some(task => task.work_code === code)) selected.delete(code);
    choices.replaceChildren(...WORKS.map(work => {
      const allowed = available.has(work.code);
      const protectedTask = protectedTasks.find(task => task.work_code === work.code);
      const conflictsWithProtected = HOOD_WORKS.has(work.code) && protectedTasks.some(task => HOOD_WORKS.has(task.work_code) && task.work_code !== work.code);
      const checkbox = element('input', { type: 'checkbox', id: `new-work-${work.code}`, value: work.code, disabled: !allowed || Boolean(protectedTask) || conflictsWithProtected, checked: selected.has(work.code), onchange: () => {
        checkbox.checked ? selected.add(work.code) : selected.delete(work.code);
        if (checkbox.checked && HOOD_WORKS.has(work.code)) for (const other of HOOD_WORKS) if (other !== work.code) {
          selected.delete(other);
          const control = choices.querySelector(`input[value="${other}"]`); if (control) control.checked = false;
        }
        updateTint();
        quote();
      } });
      return element('label', { class: `work-choice ${allowed ? '' : 'is-unavailable'}`, for: checkbox.id }, checkbox,
        element('span', { lang: 'ru' }, work.name), protectedTask ? element('small', {}, 'Recorded work · preserved') : !allowed && group.value ? element('small', {}, 'Unavailable') : null);
    }));
    updateTint();
  }

  updateSource();
  drawChoices();
  tint.value = originalTasks.find(task => task.work_code === 'W19')?.options?.tint_percent ? String(originalTasks.find(task => task.work_code === 'W19').options.tint_percent) : '';
  group.addEventListener('change', quote); tint.addEventListener('change', quote);
  const fields = element('fieldset', { 'data-mutation-fields': '', class: 'order-form-fields' },
    element('legend', {}, mode === 'new' ? 'New vehicle order' : resolving ? 'Review Manager order' : `Edit ${record.order_number}`),
    managerReference(reference),
    protectedTasks.length ? element('p', { class: 'field-hint editor-protection' }, 'Work already started or completed stays recorded. Its package, assignment and rate are preserved.') : null,
    element('div', { class: 'form-grid' }, field('Vehicle', vehicle), field('Vehicle group', group), field(resolving ? 'VIN' : 'VIN (optional)', vin), field('Colour (optional)', colour),
      field('Order source', source), assignmentField, managerField, field(resolving ? 'Planned date' : 'Planned date (optional)', planned), field('Due date (optional)', due), field('Priority', priority)),
    element('fieldset', { class: 'ordered-works' }, element('legend', {}, 'Ordered works'), element('p', { class: 'field-hint' }, 'Select one or more works. Choose one hood coverage and an explicit tint level when needed.'), choices, tintField),
    field('Instructions (optional)', instructions, 'Visible to mechanics. Keep private commercial notes out of this field.'),
    quoteArea,
    element('div', { class: 'button-row form-actions' }, element('button', { type: 'submit', class: 'button button-primary', 'data-order-action': '' }, resolving ? 'Publish order' : editing ? 'Save changes' : 'Send order'),
      button('Close form', closeEditor)), formFeedback);
  const form = element('form', { class: 'new-order-form', onsubmit: async event => {
    event.preventDefault();
    if (!selected.size) { formFeedback.textContent = 'Select at least one available work.'; return; }
    if (!vehicle.value.trim()) { formFeedback.textContent = 'Enter the vehicle.'; return vehicle.focus(); }
    if (source.value === 'owner' && ((!editing && !assigned.value) || taskPayload().some(task => !task.assigned_to))) { formFeedback.textContent = 'Choose the mechanic who will receive new work.'; return assigned.focus(); }
    if (selected.has('W19') && !['5', '15'].includes(tint.value)) { formFeedback.textContent = 'Choose 5% or 15% for the tinting task.'; return tint.focus(); }
    formFeedback.textContent = '';
    const orderFields = { vehicle: vehicle.value.trim(), vin: vin.value.trim(), colour: colour.value.trim(), vehicle_group_code: group.value,
      manager_label: source.value === 'manager' ? manager.value.trim() : '', instructions: instructions.value.trim(), due_date: due.value || null,
      priority: priority.value, planned_date: planned.value || null };
    const sent = mode !== 'new' ? await mutate(resolving ? 'garage_publish_manager_intake' : 'garage_edit_order', {
      ...(resolving ? { p_intake_id: record.id } : { p_order_id: record.id }), p_expected_version: record.version, p_order: orderFields, p_tasks: taskPayload()
    }, resolving ? 'The selected works were published to the Manager queue.' : 'The order was updated. Your work selection is preserved against later table changes.') : await mutate('garage_create_order', {
      p_vehicle: vehicle.value.trim(), p_vin: vin.value.trim(), p_colour: colour.value.trim(), p_vehicle_group_code: group.value,
      p_source: source.value, p_manager_label: source.value === 'manager' ? manager.value.trim() : '',
      p_tasks: taskPayload(),
      p_instructions: instructions.value.trim(), p_due_date: due.value || null, p_priority: priority.value, p_planned_date: planned.value || null
    }, source.value === 'owner' ? 'The order was sent to the assigned mechanic.' : 'The order was published to the Manager queue.', true);
    if (sent && isActive()) {
      closeEditor();
    }
  } }, fields);
  return { element: form, mode, quote, dispose() { disposed = true; quoteVersion += 1; } };
}
