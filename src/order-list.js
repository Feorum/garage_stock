import { element, icon } from './ui.js';
import { button, displayDate, STATUS_LABELS, TERMINAL_TASKS, financialSummary, managerReference } from './order-shared.js';
import { createTaskViews } from './order-tasks.js';

export function renderOrderList({ owner, profile, section, orders, intakes, needle, statusFilter, list, expanded, openEditor, mutate, loadFinancials, financialViews, staff }) {
  const { taskRow, reasonForm } = createTaskViews({ owner, profile, mutate, getStaff: () => staff });
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
    const shown = orders.filter(order => {
      if (!owner && !visibleTasks(order).length) return false;
      if (owner && section === 'orders') {
        if (statusFilter === 'open' && order.status !== 'published') return false;
        if (statusFilter === 'closed' && order.status === 'published') return false;
        if (statusFilter === 'review') return false;
      }
      return !needle || [order.vehicle, order.vin, order.order_number, order.vehicle_group_name, order.manager_label]
        .some(value => String(value || '').toLocaleLowerCase().includes(needle));
    });

    if (section === 'reports' && owner) {
      list.replaceChildren(reportSummary(shown), ...shown.map(orderCard));
      return;
    }
    const drafts = owner && section === 'orders' && statusFilter !== 'closed' ? intakes.filter(intake => {
      if (intake.order_id || intake.status !== 'pending') return false;
      const source = intake.latest || intake.original || {};
      return !needle || [source.vehicle, source.vin, source.manager_label, intake.source_name]
        .some(value => String(value || '').toLocaleLowerCase().includes(needle));
    }) : [];
    if (!shown.length && !drafts.length) {
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
    const entries = [...shown.map(order => ({ order, source: order.source_id || '', row: Number(order.source_row_number) || Number.MAX_SAFE_INTEGER })),
      ...drafts.map(intake => ({ intake, source: intake.source_id || intake.source_name || '', row: (intake.row_numbers || []).filter(Number.isFinite).sort((a,b) => a-b)[0] || Number.MAX_SAFE_INTEGER }))];
    const sourceNames = new Map();
    for (const entry of entries) if (entry.source) sourceNames.set(entry.source, entry.order?.source_name || entry.intake?.source_name || 'Manager table');
    const sourceRank = [...sourceNames.keys()];
    entries.sort((a, b) => {
      if (!a.source && !b.source) return 0;
      if (!a.source) return 1;
      if (!b.source) return -1;
      return sourceRank.indexOf(a.source) - sourceRank.indexOf(b.source) || a.row - b.row;
    });
    const content = [];
    let previousSource = null, rows = null;
    for (const entry of entries) {
      if (entry.source !== previousSource) {
        const name = entry.source ? sourceNames.get(entry.source) : 'Other orders';
        const headingId = `order-group-${crypto.randomUUID()}`;
        rows = element('div', { class: 'order-group-rows' }, element('div', { class: 'order-column-headings', 'aria-hidden': 'true' },
          ...['Date', 'Manager', 'Vehicle / row', 'VIN', 'Works', 'Status', ''].map(label => element('span', {}, label))));
        content.push(element('section', { class: 'order-group', 'aria-labelledby': headingId }, element('h2', { class: 'order-group-heading', id: headingId }, name), rows));
        previousSource = entry.source;
      }
      rows.append(entry.order ? orderCard(entry.order) : intakeCard(entry.intake));
    }
    list.replaceChildren(...content);
  }

  function disclosure(key, attributes, summary, ...body) {
    const details = element('details', { ...attributes, open: expanded.has(key) ? '' : null,
      ontoggle: () => details.open ? expanded.add(key) : expanded.delete(key) }, summary, ...body);
    return details;
  }

  function rowSummary({ vehicle, date, manager, vin, row, number, works, status, draft = false }) {
    return element('summary', { class: 'order-summary' },
      element('span', { class: 'summary-date' }, displayDate(date) || 'Date needed'),
      element('span', { class: 'summary-manager' }, manager || '—'),
      element('span', { class: 'summary-vehicle' }, element('strong', {}, vehicle || 'Vehicle needed'),
        element('small', {}, date ? element('span', { class: 'summary-mobile-date' }, `${displayDate(date).slice(0,5)} · `) : null,
          row ? `Row ${row}` : '', element('span', { class: 'summary-order-number' }, `${row && number ? ' · ' : ''}${number || (!row ? 'Manager request' : '')}`))),
      element('span', { class: 'summary-vin' }, vin || '—'),
      element('span', { class: 'summary-works', lang: 'ru' }, works || 'Choose works'),
      element('span', { class: `task-status ${draft ? 'status-review' : `status-${status}`}` }, draft ? 'Needs review' : STATUS_LABELS[status] || status),
      element('span', { class: 'disclosure-chevron', 'aria-hidden': 'true' }, '⌄'));
  }

  function intakeCard(intake) {
    const source = intake.latest || intake.original || {};
    const suggested = intake.suggested_order || {};
    const row = (intake.row_numbers || [])[0];
    const messages = {
      NO_APPROVED_TASKS: 'Select the catalogue works requested by the Manager.', INVALID_PLANNED_DATE: 'Enter the full planned date.',
      INVALID_VIN: 'Confirm the vehicle VIN.', INVALID_MANAGER: 'Confirm the Manager reference.', INVALID_VEHICLE: 'Enter the vehicle.',
      UNKNOWN_VEHICLE_GROUP: 'Choose the matching vehicle group.', DUPLICATE_SOURCE_KEY: 'Check the duplicate table rows before publishing.'
    };
    return disclosure(`intake-${intake.id}`, { class: 'order-card compact-order intake-row', 'data-intake-id': intake.id },
      rowSummary({ ...source, date: suggested.planned_date || source.date, manager: source.manager_label, row,
        works: [source.wrapping, source.tint].filter(Boolean).join(' · '), draft: true }),
      element('div', { class: 'order-expanded' },
        element('h3', { class: 'expanded-vehicle' }, `Vehicle: ${source.vehicle || 'Vehicle needed'}`),
        element('p', { class: 'order-meta' }, 'Manager request · waiting for your work selection'),
        element('p', { class: 'order-meta' }, [source.date, source.manager_label, source.vin ? `VIN: ${source.vin}` : '', source.colour].filter(Boolean).join(' · ')),
        element('ul', { class: 'intake-issues' }, ...[...new Set((intake.issues || []).map(code => messages[code] || 'Review the Manager request and select the work to publish.'))].map(message => element('li', {}, message))),
        managerReference(intake), element('div', { class: 'order-actions' }, button('Edit order', () => openEditor('intake', intake)))));
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
      if (section === 'orders' && order.status === 'published') actions.append(button('Edit order', () => openEditor('edit', order)));
      actions.append(button('View Owner amounts', () => loadFinancials(order, financial)));
      if (order.status !== 'cancelled') actions.append(button('Record omitted completed work', () => openEditor('completion', order)));
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
    const intake = owner ? intakes.find(item => item.order_id === order.id) : null;
    const uncancelled = tasks.filter(task => task.status !== 'cancelled');
    const card = disclosure(`order-${order.id}`, { class: 'order-card compact-order', 'data-order-id': order.id },
      rowSummary({ vehicle: order.vehicle, date: order.planned_date, manager: order.manager_label, vin: order.vin,
        row: order.source_row_number, number: order.order_number, status: order.status,
        works: `${uncancelled.length} ${uncancelled.length === 1 ? 'work' : 'works'} · ${uncancelled.map(task => `${task.work_name}${task.work_code === 'W19' ? ` ${task.options?.tint_percent || ''}%` : ''}`).join(' · ')}` }),
      element('div', { class: 'order-expanded' },
      element('h3', { class: 'expanded-vehicle' }, `Vehicle: ${order.vehicle}`),
      element('div', { class: 'order-detail-heading' },
        element('p', { class: 'order-meta' }, `${order.order_number} · ${order.source === 'owner' ? 'Owner assignment' : 'Manager queue'}`),
        order.priority !== 'normal' ? element('span', { class: `priority priority-${order.priority}` }, order.priority === 'urgent' ? 'Urgent' : 'High priority') : null),
      element('p', { class: 'order-meta' }, [order.vehicle_group_name || order.vehicle_group_code,
        order.vin ? `VIN: ${order.vin}` : '', order.colour || '', order.planned_date ? `Planned ${displayDate(order.planned_date)}` : '',
        order.due_date ? `Due ${displayDate(order.due_date)}` : ''].filter(Boolean).join(' · ')),
      order.manager_label ? element('p', { class: 'order-meta' }, `Manager reference: ${order.manager_label}`) : null,
      owner && (intake?.source_changed || order.source_changed) ? element('p', { class: 'source-change-notice' }, order.source_missing
        ? 'This row is no longer in the connected table. The saved order is kept.'
        : intake?.owner_managed || order.owner_managed ? 'The table text changed after Owner review. Your saved work selection is preserved.'
          : 'The Manager table text changed. Review the latest request before editing this order.') : null,
      order.instructions && !(order.instructions_from_manager === true && order.manager_comment_updated_at)
        ? element('p', { class: 'order-instructions' }, order.instructions) : null,
      order.manager_comment ? element('section', { class: 'order-manager-comment', 'aria-label': 'Manager comment' },
        element('h4', {}, 'Manager comment'), element('p', { class: 'order-instructions' }, order.manager_comment),
        order.manager_comment_updated_at && Number.isFinite(new Date(order.manager_comment_updated_at).getTime())
          ? element('p', { class: 'order-meta' }, `Updated ${new Date(order.manager_comment_updated_at).toLocaleString()}`) : null) : null,
      managerReference(intake), element('div', { class: 'order-tasks' }, tasks.map(task => taskRow(order, task))), actions, actionForm, financial));
    if (owner && financialViews.has(order.id)) financial.append(financialSummary(financialViews.get(order.id)));
    return card;
  }

  drawOrders();
}
