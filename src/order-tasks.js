import { element } from './ui.js';
import { field, button, statusBadge, displayDate, TERMINAL_TASKS } from './order-shared.js';

export function createTaskViews({ owner, profile, mutate, getStaff }) {
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
        if (getStaff().length && (order.source === 'owner' || (task.working_mechanic_id && ['in_progress', 'blocked'].includes(task.status)))) {
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
      element('option', { value: '' }, 'Choose mechanic'), getStaff().map(member => element('option', { value: member.id }, member.name)));
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

  return { taskRow, reasonForm };
}
