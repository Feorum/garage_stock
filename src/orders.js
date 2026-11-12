import { element, icon, renderNotice } from './ui.js';
import { WORKS, VEHICLE_GROUPS, AVAILABLE_WORKS } from './catalogue.js';

const STATUS_LABELS = {
  pending: 'Pending', in_progress: 'In progress', blocked: 'Blocked',
  completed: 'Completed', cancelled: 'Cancelled', published: 'Open', closed: 'Closed'
};
const TERMINAL_TASKS = new Set(['completed', 'cancelled']);

function field(label, control, hint = '') {
  return element('div', { class: 'order-field' }, element('label', { for: control.id }, label), control,
    hint ? element('p', { class: 'field-hint' }, hint) : null);
}

function statusBadge(status) {
  return element('span', { class: `task-status status-${status}` }, STATUS_LABELS[status] || status);
}

function displayDate(value) {
  if (!value) return '';
  const parts = String(value).slice(0, 10).split('-');
  return parts.length === 3 ? parts.reverse().join('.') : String(value);
}

function actionError(error, creating = false) {
  if (['PGRST202', '42883', '42P01'].includes(error?.code)) return 'The order workspace is not available yet. Ask the Owner to finish setup, then retry.';
  if (error?.code === '42501') return 'Your account cannot perform this action. Refresh to check your current access.';
  if (error?.code === '40001' || /version|changed|conflict|already|no longer/i.test(error?.message || '')) return 'This work has changed. Refresh and check its latest state before trying again.';
  if (!error?.code || /fetch|network|timeout/i.test(error?.message || '')) return 'We couldn’t confirm the change. Check your connection and refresh before retrying.';
  return creating
    ? 'The order could not be sent. Check its vehicle, selected works and mechanic assignment, then retry.'
    : 'The change could not be saved. Refresh to check the latest task state, then retry.';
}

// Every mount owns its pending requests and private responses. Navigation/logout
// must call dispose so a late response cannot restore a previous workspace.
export function mountOrders({ role, profile, section, client }) {
  const owner = role === 'admin';
  const root = element('section', { class: 'orders-workspace', 'aria-label': owner ? 'Order workspace' : 'Your vehicle orders' });
  const abort = new AbortController();
  const requestIds = new Map();
  const financialViews = new Map();
  let active = true;
  let loadingVersion = 0;
  let pending = false;
  let orders = [];
  let staff = [];
  let staffReady = false;
  let hasLoaded = false;
  let formOpen = false;

  const feedback = element('div', { class: 'orders-feedback', 'aria-live': 'polite' });
  const list = element('div', { class: 'order-list' });
  const formArea = element('div', { hidden: true });
  const filter = element('select', { id: 'order-filter', 'aria-label': 'Order status', onchange: drawOrders },
    element('option', { value: 'open' }, 'Open orders'),
    element('option', { value: 'all' }, 'All orders'),
    element('option', { value: 'closed' }, 'Closed orders'));
  const search = element('input', { id: 'order-search', type: 'search', placeholder: 'Vehicle, VIN or order number', 'aria-label': 'Search orders', oninput: drawOrders });
  const refreshButton = button('Refresh', () => initialize(), 'button');
  const newButton = owner && section === 'orders' ? button('New order', () => {
    formOpen = !formOpen;
    formArea.hidden = !formOpen;
    newButton.setAttribute('aria-expanded', String(formOpen));
    if (formOpen) formArea.querySelector('input')?.focus();
  }, 'button button-primary') : null;
  if (newButton) {
    newButton.setAttribute('aria-expanded', 'false');
    newButton.disabled = true;
  }

  root.append(element('div', { class: 'order-toolbar' },
    element('div', { class: 'order-search-controls' }, search, owner && section === 'orders' ? filter : null),
    element('div', { class: 'button-row toolbar-buttons' }, refreshButton, newButton)), feedback, formArea, list);

  function button(text, handler, className = 'button button-small') {
    return element('button', { type: 'button', class: className, 'data-order-action': '', onclick: handler }, text);
  }

  function tell(title, description, error = false) {
    if (!active) return;
    feedback.replaceChildren(renderNotice(title, description, error ? 'error' : 'info'));
  }

  function lock(value) {
    pending = value;
    root.setAttribute('aria-busy', String(value));
    for (const control of root.querySelectorAll('[data-order-action], [data-mutation-fields]')) control.disabled = value;
    if (newButton) newButton.disabled = value || !staffReady;
  }

  async function rpc(name, parameters = {}) {
    const request = client.rpc(name, parameters);
    const response = await (typeof request.abortSignal === 'function' ? request.abortSignal(abort.signal) : request);
    if (response.error) throw response.error;
    return response.data;
  }

  async function mutate(name, parameters, success, creating = false) {
    if (pending || !active) return false;
    const fingerprint = JSON.stringify([name, parameters]);
    if (!requestIds.has(fingerprint)) requestIds.set(fingerprint, crypto.randomUUID());
    lock(true);
    try {
      await rpc(name, { ...parameters, p_request_id: requestIds.get(fingerprint) });
      if (!active) return false;
      requestIds.delete(fingerprint);
      financialViews.clear();
      await refresh(false);
      tell('Saved', success);
      return true;
    } catch (error) {
      if (active) {
        // Keep the same request ID for an ambiguous retry of this exact action.
        await refresh(false);
        tell(creating ? 'Order not confirmed' : 'Change not confirmed', actionError(error, creating), true);
      }
      return false;
    } finally {
      if (active) lock(false);
    }
  }

  function visibleTasks(order) {
    const tasks = Array.isArray(order.tasks) ? order.tasks : [];
    if (owner) return tasks;
    if (section === 'assigned') return order.source === 'owner' && order.status === 'published'
      ? tasks.filter(task => task.assigned_to === profile.id && !TERMINAL_TASKS.has(task.status)) : [];
    if (section === 'manager-orders') return order.source === 'manager' && order.status === 'published'
      ? tasks.filter(task => task.status === 'pending' && !task.working_mechanic_id) : [];
    return tasks.filter(task => task.working_mechanic_id === profile.id && task.status !== 'cancelled');
  }

  function drawOrders() {
    if (!active || !hasLoaded) return;
    const needle = search.value.trim().toLocaleLowerCase();
    const shown = orders.filter(order => {
      if (!owner && !visibleTasks(order).length) return false;
      if (owner && section === 'orders') {
        if (filter.value === 'open' && order.status !== 'published') return false;
        if (filter.value === 'closed' && order.status === 'published') return false;
      }
      return !needle || [order.vehicle, order.vin, order.order_number, order.vehicle_group_name, order.manager_label]
        .some(value => String(value || '').toLocaleLowerCase().includes(needle));
    });

    if (section === 'reports' && owner) {
      list.replaceChildren(reportSummary(shown), ...shown.map(orderCard));
      return;
    }
    if (!shown.length) {
      const empty = section === 'manager-orders'
        ? ['No available Manager tasks', 'Available work from published Manager orders will appear here.']
        : section === 'assigned'
          ? ['No unfinished Owner assignments', 'Work sent directly to you will appear here.']
          : section === 'my-work'
            ? ['You have no recorded work yet', 'Start an assigned task or choose available work from Manager orders.']
            : ['No matching orders', needle ? 'Try a different vehicle, VIN or order number.' : 'Create a vehicle order to send work to a mechanic or the shared Manager queue.'];
      list.replaceChildren(element('div', { class: 'empty-state' }, element('span', { class: 'empty-icon' }, icon('orders')),
        element('h2', {}, empty[0]), element('p', {}, empty[1])));
      return;
    }
    list.replaceChildren(...shown.map(orderCard));
  }

  function reportSummary(source) {
    const tasks = source.flatMap(order => order.tasks || []);
    const completed = tasks.filter(task => task.status === 'completed');
    const byMechanic = new Map();
    for (const task of completed) {
      const id = task.working_mechanic_id || 'unknown';
      const entry = byMechanic.get(id) || { name: task.working_name || 'Unrecorded mechanic', count: 0 };
      entry.count += 1;
      byMechanic.set(id, entry);
    }
    return element('section', { class: 'operational-report', 'aria-label': 'Work summary' },
      element('div', { class: 'report-statistics' },
        element('div', {}, element('strong', {}, String(source.filter(order => order.status === 'published').length)), element('span', {}, 'Open orders')),
        element('div', {}, element('strong', {}, String(completed.length)), element('span', {}, 'Completed tasks')),
        element('div', {}, element('strong', {}, String(tasks.filter(task => task.status === 'blocked').length)), element('span', {}, 'Blocked tasks'))),
      byMechanic.size ? element('div', { class: 'mechanic-totals' }, [...byMechanic.values()].map(entry => element('p', {},
        element('strong', {}, entry.name), element('span', {}, `${entry.count} completed`)))) : element('p', { class: 'muted' }, 'Completed work will be grouped by the mechanic who performed it.'));
  }

  function orderCard(order) {
    const tasks = visibleTasks(order);
    const actions = element('div', { class: 'order-actions' });
    const actionForm = element('div', { class: 'inline-action' });
    const financial = element('div', { class: 'private-amounts' });
    if (owner) {
      actions.append(button('View Owner amounts', () => loadFinancials(order, financial)));
      if (order.status === 'published') {
        if ((order.tasks || []).some(task => task.status === 'completed') && (order.tasks || []).every(task => TERMINAL_TASKS.has(task.status))) {
          actions.append(button('Close order', () => mutate('garage_order_action', {
            p_order_id: order.id, p_action: 'close', p_expected_version: order.version, p_note: ''
          }, 'The order is closed.')));
        }
        actions.append(button('Cancel order', () => reasonForm(actionForm, 'Cancel order', 'Confirm cancellation', note => mutate('garage_order_action', {
          p_order_id: order.id, p_action: 'cancel', p_expected_version: order.version, p_note: note
        }, 'The remaining work was cancelled. Completed work stays in history.'), 'Completed work stays in history. Remaining tasks will be cancelled.')));
      }
    }
    const card = element('article', { class: 'order-card', 'data-order-id': order.id },
      element('div', { class: 'order-card-heading' },
        element('div', {}, element('p', { class: 'eyebrow' }, `${order.order_number} · ${order.source === 'owner' ? 'Owner assignment' : 'Manager queue'}`),
          element('h2', {}, order.vehicle)),
        element('div', { class: 'order-badges' }, statusBadge(order.status), order.priority !== 'normal' ? element('span', { class: `priority priority-${order.priority}` }, order.priority === 'urgent' ? 'Urgent' : 'High priority') : null)),
      element('p', { class: 'order-meta' }, [order.vehicle_group_name || order.vehicle_group_code,
        order.vin ? `VIN: ${order.vin}` : '', order.colour || '', order.planned_date ? `Planned ${displayDate(order.planned_date)}` : '',
        order.due_date ? `Due ${displayDate(order.due_date)}` : ''].filter(Boolean).join(' · ')),
      order.manager_label ? element('p', { class: 'order-meta' }, `Manager reference: ${order.manager_label}`) : null,
      order.instructions ? element('p', { class: 'order-instructions' }, order.instructions) : null,
      element('div', { class: 'order-tasks' }, tasks.map(task => taskRow(order, task))), actions, actionForm, financial);
    if (owner && financialViews.has(order.id)) financial.append(financialSummary(financialViews.get(order.id)));
    return card;
  }

  function taskRow(order, task) {
    const controls = element('div', { class: 'task-actions' });
    const inline = element('div', { class: 'inline-action' });
    const ownWork = task.working_mechanic_id === profile.id;
    if (order.status === 'published') {
      if (!owner) {
        if (task.status === 'pending' && ((order.source === 'owner' && task.assigned_to === profile.id) || (order.source === 'manager' && !task.working_mechanic_id))) {
          controls.append(taskButton('Start task', 'start'));
        }
        if (ownWork && task.status === 'in_progress') {
          controls.append(button('Block task', () => reasonForm(inline, 'Block task', 'Save reason', note => performTask('block', note))),
            taskButton('Complete task', 'complete'));
        }
        if (ownWork && task.status === 'blocked') controls.append(taskButton('Resume task', 'resume'));
        if (ownWork && order.source === 'manager' && ['in_progress', 'blocked'].includes(task.status)) {
          controls.append(button('Return to queue', () => reasonForm(inline, 'Return to queue', 'Confirm return', note => performTask('release', note))));
        }
      } else if (!TERMINAL_TASKS.has(task.status)) {
        if (staffReady && staff.length && (order.source === 'owner' || (task.working_mechanic_id && ['in_progress', 'blocked'].includes(task.status)))) {
          controls.append(button('Reassign', () => reassignmentForm(inline, task, assignee => note => performTask('reassign', note, assignee))));
        }
        controls.append(button('Cancel task', () => reasonForm(inline, 'Cancel task', 'Confirm cancellation', note => performTask('cancel', note))));
      }
    }

    function taskButton(text, action) {
      return button(text, () => performTask(action), action === 'start' || action === 'complete' ? 'button button-small button-primary' : 'button button-small');
    }

    function performTask(action, note = '', assignee = null) {
      return mutate('garage_task_action', {
        p_task_id: task.id, p_action: action, p_expected_version: task.version, p_note: note, p_assignee: assignee
      }, action === 'complete' ? 'The completed work has been recorded.' : 'The task has been updated.');
    }

    const tint = task.work_code === 'W19' && [5, 15].includes(Number(task.options?.tint_percent)) ? ` · ${task.options.tint_percent}%` : '';
    return element('div', { class: 'task-row', 'data-task-id': task.id },
      element('div', { class: 'task-detail' }, element('div', { class: 'task-title-line' },
        element('h3', { lang: 'ru' }, `${task.work_name}${tint}`), statusBadge(task.status)),
        element('p', { class: 'task-owner' }, task.working_name ? `Working mechanic: ${task.working_name}`
          : task.assigned_name ? `Assigned to ${task.assigned_name}` : 'Available in the shared queue'),
        task.instructions ? element('p', { class: 'task-instructions' }, task.instructions) : null,
        task.blocker_reason && task.status === 'blocked' ? element('p', { class: 'task-blocker' }, `Blocked: ${task.blocker_reason}`) : null,
        task.completed_at ? element('p', { class: 'task-owner' }, `Completed ${displayDate(task.completed_at)}`) : null), controls, inline);
  }

  function reasonForm(target, heading, submitLabel, submit, explanation = '') {
    const reason = element('textarea', { id: `reason-${crypto.randomUUID()}`, rows: '2', maxlength: '1000', required: true });
    const fields = element('fieldset', { 'data-mutation-fields': '' }, element('legend', {}, heading),
      explanation ? element('p', { class: 'field-hint' }, explanation) : null,
      field('Reason', reason), element('div', { class: 'button-row inline-buttons' },
        element('button', { class: 'button button-small button-primary', type: 'submit', 'data-order-action': '' }, submitLabel),
        button('Keep current state', () => target.replaceChildren())));
    target.replaceChildren(element('form', { onsubmit: async event => {
      event.preventDefault();
      if (!reason.value.trim()) return reason.focus();
      await submit(reason.value.trim());
    } }, fields));
    reason.focus();
  }

  function reassignmentForm(target, task, createSubmit) {
    const next = element('select', { id: `assignee-${task.id}`, required: true },
      element('option', { value: '' }, 'Choose mechanic'), staff.map(member => element('option', { value: member.id }, member.name)));
    const reason = element('textarea', { id: `transfer-reason-${task.id}`, rows: '2', maxlength: '1000', required: true });
    target.replaceChildren(element('form', { onsubmit: async event => {
      event.preventDefault();
      if (!next.value || !reason.value.trim()) return;
      await createSubmit(next.value)(reason.value.trim());
    } }, element('fieldset', { 'data-mutation-fields': '' }, element('legend', {}, 'Reassign work'),
      field('New mechanic', next), field('Reason', reason), element('div', { class: 'button-row inline-buttons' },
        element('button', { class: 'button button-small button-primary', type: 'submit', 'data-order-action': '' }, 'Confirm reassignment'),
        button('Keep current assignment', () => target.replaceChildren())))));
    next.focus();
  }

  function createForm() {
    const vehicle = element('input', { id: 'new-vehicle', name: 'vehicle', required: true, maxlength: '200', placeholder: 'Vehicle model / plate' });
    const vin = element('input', { id: 'new-vin', name: 'vin', maxlength: '64' });
    const colour = element('input', { id: 'new-colour', name: 'colour', maxlength: '80' });
    const group = element('select', { id: 'new-group', required: true, onchange: drawChoices }, element('option', { value: '' }, 'Choose vehicle group'),
      VEHICLE_GROUPS.map(item => element('option', { value: item.code }, item.name)));
    const source = element('select', { id: 'new-source', onchange: updateSource }, element('option', { value: 'owner' }, 'Owner assignment'), element('option', { value: 'manager' }, 'Manager shared queue'));
    const assigned = element('select', { id: 'new-assigned', required: true }, element('option', { value: '' }, 'Choose mechanic'),
      staff.map(member => element('option', { value: member.id }, member.name)));
    const manager = element('input', { id: 'new-manager', maxlength: '100' });
    const planned = element('input', { id: 'new-planned', type: 'date' });
    const due = element('input', { id: 'new-due', type: 'date' });
    const priority = element('select', { id: 'new-priority' }, element('option', { value: 'normal' }, 'Normal'), element('option', { value: 'high' }, 'High'), element('option', { value: 'urgent' }, 'Urgent'));
    const instructions = element('textarea', { id: 'new-instructions', rows: '3', maxlength: '2000' });
    const assignmentField = field('Assign mechanic', assigned, 'This mechanic receives every selected task as a mandatory assignment.');
    const managerField = field('Manager label (optional)', manager, 'A source reference; it does not verify the person who submitted the request.');
    const choices = element('div', { class: 'work-choices' });
    const selected = new Set();
    const tint = element('select', { id: 'new-tint', disabled: true }, element('option', { value: '' }, 'Choose tint level'),
      element('option', { value: '5' }, '5%'), element('option', { value: '15' }, '15%'));
    const tintField = field('Tint level', tint);
    tintField.hidden = true;
    const formFeedback = element('p', { class: 'form-feedback', role: 'status' });

    function updateSource() {
      const mandatory = source.value === 'owner';
      assignmentField.hidden = !mandatory;
      assigned.disabled = !mandatory;
      assigned.required = mandatory;
      managerField.hidden = mandatory;
      manager.disabled = mandatory;
    }

    function updateTint() {
      const required = selected.has('W19');
      tintField.hidden = !required;
      tint.disabled = !required;
      tint.required = required;
      if (!required) tint.value = '';
    }

    function drawChoices() {
      const available = new Set(AVAILABLE_WORKS[group.value] || []);
      for (const code of selected) if (!available.has(code)) selected.delete(code);
      choices.replaceChildren(...WORKS.map(work => {
        const allowed = available.has(work.code);
        const checkbox = element('input', { type: 'checkbox', id: `new-work-${work.code}`, value: work.code, disabled: !allowed, checked: selected.has(work.code), onchange: () => {
          checkbox.checked ? selected.add(work.code) : selected.delete(work.code);
          updateTint();
        } });
        return element('label', { class: `work-choice ${allowed ? '' : 'is-unavailable'}`, for: checkbox.id }, checkbox,
          element('span', { lang: 'ru' }, work.name), !allowed && group.value ? element('small', {}, 'Unavailable') : null);
      }));
      updateTint();
    }

    updateSource();
    drawChoices();
    const fields = element('fieldset', { 'data-mutation-fields': '', class: 'order-form-fields' },
      element('legend', {}, 'New vehicle order'),
      element('div', { class: 'form-grid' }, field('Vehicle', vehicle), field('Vehicle group', group), field('VIN (optional)', vin), field('Colour (optional)', colour),
        field('Order source', source), assignmentField, managerField, field('Planned date (optional)', planned), field('Due date (optional)', due), field('Priority', priority)),
      element('fieldset', { class: 'ordered-works' }, element('legend', {}, 'Ordered works'), element('p', { class: 'field-hint' }, 'Choose a vehicle group, then select its authorized work packages.'), choices, tintField),
      field('Instructions (optional)', instructions, 'Visible to mechanics. Keep private commercial notes out of this field.'),
      element('div', { class: 'button-row form-actions' }, element('button', { type: 'submit', class: 'button button-primary', 'data-order-action': '' }, 'Send order'),
        button('Close form', () => { formOpen = false; formArea.hidden = true; newButton.setAttribute('aria-expanded', 'false'); })), formFeedback);
    const form = element('form', { class: 'new-order-form', onsubmit: async event => {
      event.preventDefault();
      if (!selected.size) { formFeedback.textContent = 'Select at least one available work.'; return; }
      if (!vehicle.value.trim()) { formFeedback.textContent = 'Enter the vehicle.'; return vehicle.focus(); }
      if (source.value === 'owner' && !assigned.value) { formFeedback.textContent = 'Choose the mechanic who will receive this order.'; return assigned.focus(); }
      if (selected.has('W19') && !['5', '15'].includes(tint.value)) { formFeedback.textContent = 'Choose 5% or 15% for the tinting task.'; return tint.focus(); }
      formFeedback.textContent = '';
      const sent = await mutate('garage_create_order', {
        p_vehicle: vehicle.value.trim(), p_vin: vin.value.trim(), p_colour: colour.value.trim(), p_vehicle_group_code: group.value,
        p_source: source.value, p_manager_label: source.value === 'manager' ? manager.value.trim() : '',
        p_tasks: WORKS.filter(work => selected.has(work.code)).map(work => ({ work_code: work.code, assigned_to: source.value === 'owner' ? assigned.value : null,
          options: work.code === 'W19' ? { tint_percent: Number(tint.value) } : {} })),
        p_instructions: instructions.value.trim(), p_due_date: due.value || null, p_priority: priority.value, p_planned_date: planned.value || null
      }, source.value === 'owner' ? 'The order was sent to the assigned mechanic.' : 'The order was published to the Manager queue.', true);
      if (sent && active) {
        selected.clear();
        form.reset();
        updateSource();
        drawChoices();
        formOpen = false;
        formArea.hidden = true;
        newButton.setAttribute('aria-expanded', 'false');
      }
    } }, fields);
    return form;
  }

  async function loadFinancials(order, target) {
    if (!owner || pending || !active) return;
    target.replaceChildren(element('p', { class: 'muted' }, 'Loading Owner amounts…'));
    try {
      const values = await rpc('garage_order_financials', { p_order_id: order.id });
      if (!active || !target.isConnected) return;
      financialViews.set(order.id, values);
      target.replaceChildren(financialSummary(values));
    } catch {
      if (active && target.isConnected) target.replaceChildren(renderNotice('Amounts unavailable', 'The private amounts could not be loaded. Please try again.', 'error'));
    }
  }

  function financialSummary(values) {
    if (!values || values.status !== 'priced' || [values.net_amount, values.vat_amount, values.gross_amount].some(value => value == null || !Number.isFinite(Number(value)))) {
      return renderNotice('Owner review needed', 'One or more work amounts have not been confirmed. Unknown amounts are not counted as zero.');
    }
    const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'BYN' }).format(Number(value));
    return element('div', { class: 'financial-summary', 'aria-label': 'Owner-only amounts' },
      element('p', { class: 'eyebrow' }, 'Recorded rates · Owner only · BYN'),
      element('p', { class: 'field-hint financial-scope' }, 'Amounts cover all uncancelled ordered work.'),
      element('dl', {}, element('div', {}, element('dt', {}, 'Excluding VAT'), element('dd', {}, money(values.net_amount))),
        element('div', {}, element('dt', {}, 'VAT'), element('dd', {}, money(values.vat_amount))),
        element('div', {}, element('dt', {}, 'Including VAT'), element('dd', {}, money(values.gross_amount)))));
  }

  async function refresh(showLoading = true) {
    if (!active) return;
    const version = ++loadingVersion;
    if (showLoading && !hasLoaded) list.replaceChildren(element('p', { class: 'orders-loading', role: 'status' }, 'Loading vehicle orders…'));
    if (showLoading) refreshButton.disabled = true;
    try {
      const data = await rpc('garage_list_orders');
      if (!active || version !== loadingVersion) return;
      if (!Array.isArray(data)) throw new Error('Unexpected order response');
      const previousVersions = new Map(orders.map(order => [order.id, order.version]));
      for (const id of financialViews.keys()) {
        const updated = data.find(order => order.id === id);
        if (!updated || previousVersions.get(id) !== updated.version) financialViews.delete(id);
      }
      orders = data;
      hasLoaded = true;
      drawOrders();
      if (showLoading) feedback.replaceChildren();
    } catch (error) {
      if (!active || version !== loadingVersion) return;
      if (!hasLoaded) list.replaceChildren();
      tell('Orders could not be loaded', ['PGRST202', '42883', '42P01'].includes(error?.code)
        ? 'The order workspace is not available yet. Ask the Owner to finish setup, then retry.'
        : hasLoaded ? 'Your last loaded work is still shown. Check your connection and refresh before making changes.' : 'Check your connection and retry. Your orders have not been changed.', true);
      if (!hasLoaded) list.append(button('Retry', () => refresh()));
    } finally {
      if (active && version === loadingVersion) refreshButton.disabled = pending;
    }
  }

  async function initialize() {
    let staffError = false;
    if (owner && section === 'orders' && !staffReady) {
      try {
        const members = await rpc('garage_staff');
        if (!active) return;
        staff = Array.isArray(members) ? members : [];
        staffReady = true;
        formArea.replaceChildren(createForm());
        newButton.disabled = false;
      } catch {
        if (active) {
          newButton.disabled = true;
          staffError = true;
        }
      }
    } else if (owner && !staffReady) {
      try {
        const members = await rpc('garage_staff');
        if (!active) return;
        staff = Array.isArray(members) ? members : [];
        staffReady = true;
      } catch { /* Reports remain usable without reassignment controls. */ }
    }
    await refresh();
    if (staffError) tell('Mechanics could not be loaded', 'Refresh to load the mechanic list before creating an order.', true);
  }

  function refreshOnReturn() {
    if (!pending && !formOpen && document.visibilityState === 'visible') refresh(false);
  }
  const interval = setInterval(refreshOnReturn, 30000);
  window.addEventListener('focus', refreshOnReturn);
  document.addEventListener('visibilitychange', refreshOnReturn);
  initialize();

  return {
    element: root,
    dispose() {
      active = false;
      loadingVersion += 1;
      abort.abort();
      clearInterval(interval);
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
      orders = [];
      staff = [];
      requestIds.clear();
      financialViews.clear();
      root.replaceChildren();
    }
  };
}
