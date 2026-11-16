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
          controls.append(taskButton('Начать работу', 'start'));
        }
        if (ownWork && task.status === 'in_progress') {
          controls.append(button('Приостановить работу', () => reasonForm(inline, 'Приостановить работу', 'Сохранить причину', note => performTask('block', note))),
            taskButton('Завершить работу', 'complete'));
        }
        if (ownWork && task.status === 'blocked') controls.append(taskButton('Продолжить работу', 'resume'));
        if (ownWork && order.source === 'manager' && ['in_progress', 'blocked'].includes(task.status)) {
          controls.append(button('Вернуть в очередь', () => reasonForm(inline, 'Вернуть в очередь', 'Подтвердить возврат', note => performTask('release', note))));
        }
      } else if (!TERMINAL_TASKS.has(task.status)) {
        if (getStaff().length && (order.source === 'owner' || (task.working_mechanic_id && ['in_progress', 'blocked'].includes(task.status)))) {
          controls.append(button('Переназначить', () => reassignmentForm(inline, task, assignee => note => performTask('reassign', note, assignee))));
        }
        controls.append(button('Отменить работу', () => reasonForm(inline, 'Отменить работу', 'Подтвердить отмену', note => performTask('cancel', note))));
      }
    }

    function taskButton(text, action) {
      return button(text, () => performTask(action), action === 'start' || action === 'complete' ? 'button button-small button-primary' : 'button button-small');
    }

    function performTask(action, note = '', assignee = null) {
      return mutate('garage_task_action', {
        p_task_id: task.id, p_action: action, p_expected_version: task.version, p_note: note, p_assignee: assignee
      }, action === 'complete' ? 'Выполненная работа записана.' : 'Работа обновлена.');
    }

    const tint = task.work_code === 'W19' && [5, 15].includes(Number(task.options?.tint_percent)) ? ` · ${task.options.tint_percent}%` : '';
    return element('div', { class: 'task-row', 'data-task-id': task.id },
      element('div', { class: 'task-detail' }, element('div', { class: 'task-title-line' },
        element('h3', { lang: 'ru' }, `${task.work_name}${tint}`), statusBadge(task.status)),
        element('p', { class: 'task-owner' }, task.working_name ? `Механик: ${task.working_name}`
          : task.assigned_name ? `Назначено: ${task.assigned_name}` : 'Доступно в общей очереди'),
        task.instructions ? element('p', { class: 'task-instructions' }, task.instructions) : null,
        task.blocker_reason && task.status === 'blocked' ? element('p', { class: 'task-blocker' }, `Приостановлено: ${task.blocker_reason}`) : null,
        task.completed_at ? element('p', { class: 'task-owner' }, `Выполнено: ${displayDate(task.completed_at)}`) : null), controls, inline);
  }

  function reasonForm(target, heading, submitLabel, submit, explanation = '') {
    const reason = element('textarea', { id: `reason-${crypto.randomUUID()}`, rows: '2', maxlength: '1000', required: true });
    const fields = element('fieldset', { 'data-mutation-fields': '' }, element('legend', {}, heading),
      explanation ? element('p', { class: 'field-hint' }, explanation) : null,
      field('Причина', reason), element('div', { class: 'button-row inline-buttons' },
        element('button', { class: 'button button-small button-primary', type: 'submit', 'data-order-action': '' }, submitLabel),
        button('Оставить без изменений', () => target.replaceChildren())));
    target.replaceChildren(element('form', { onsubmit: async event => {
      event.preventDefault();
      if (!reason.value.trim()) return reason.focus();
      await submit(reason.value.trim());
    } }, fields));
    reason.focus();
  }

  function reassignmentForm(target, task, createSubmit) {
    const next = element('select', { id: `assignee-${task.id}`, required: true },
      element('option', { value: '' }, 'Выберите механика'), getStaff().map(member => element('option', { value: member.id }, member.name)));
    const reason = element('textarea', { id: `transfer-reason-${task.id}`, rows: '2', maxlength: '1000', required: true });
    target.replaceChildren(element('form', { onsubmit: async event => {
      event.preventDefault();
      if (!next.value || !reason.value.trim()) return;
      await createSubmit(next.value)(reason.value.trim());
    } }, element('fieldset', { 'data-mutation-fields': '' }, element('legend', {}, 'Переназначение работы'),
      field('Новый механик', next), field('Причина', reason), element('div', { class: 'button-row inline-buttons' },
        element('button', { class: 'button button-small button-primary', type: 'submit', 'data-order-action': '' }, 'Подтвердить переназначение'),
        button('Оставить назначение', () => target.replaceChildren())))));
    next.focus();
  }

  return { taskRow, reasonForm };
}
