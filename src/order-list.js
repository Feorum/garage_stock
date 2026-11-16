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
        .some(value => String(value || '').toLocaleLowerCase('ru-RU').includes(needle));
    });

    if (section === 'reports' && owner) {
      list.replaceChildren(reportSummary(shown), ...shown.map(orderCard));
      return;
    }
    const drafts = owner && section === 'orders' && statusFilter !== 'closed' ? intakes.filter(intake => {
      if (intake.order_id || intake.status !== 'pending') return false;
      const source = intake.latest || intake.original || {};
      return !needle || [source.vehicle, source.vin, source.manager_label, intake.source_name]
        .some(value => String(value || '').toLocaleLowerCase('ru-RU').includes(needle));
    }) : [];
    if (!shown.length && !drafts.length) {
      const empty = section === 'manager-orders'
        ? ['Нет доступных работ от менеджеров', 'Здесь появятся доступные работы из опубликованных заказов менеджеров.']
        : section === 'assigned'
          ? ['Нет незавершённых назначений владельца', 'Здесь появятся работы, назначенные вам напрямую.']
          : section === 'my-work'
            ? ['У вас пока нет учтённых работ', 'Начните назначенную работу или выберите доступную в заказах менеджеров.']
            : ['Подходящие заказы не найдены', needle ? 'Попробуйте другой автомобиль, VIN или номер заказа.' : 'Создайте заказ и назначьте работы механику или опубликуйте их в общей очереди менеджеров.'];
      list.replaceChildren(element('div', { class: 'empty-state' }, element('span', { class: 'empty-icon' }, icon('orders')),
        element('h2', {}, empty[0]), element('p', {}, empty[1])));
      return;
    }
    const entries = [...shown.map(order => ({ order, source: order.source_id || '', row: Number(order.source_row_number) || Number.MAX_SAFE_INTEGER })),
      ...drafts.map(intake => ({ intake, source: intake.source_id || intake.source_name || '', row: (intake.row_numbers || []).filter(Number.isFinite).sort((a,b) => a-b)[0] || Number.MAX_SAFE_INTEGER }))];
    const sourceNames = new Map();
    for (const entry of entries) if (entry.source) sourceNames.set(entry.source, entry.order?.source_name || entry.intake?.source_name || 'Таблица менеджеров');
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
        const name = entry.source ? sourceNames.get(entry.source) : 'Другие заказы';
        const headingId = `order-group-${crypto.randomUUID()}`;
        rows = element('div', { class: 'order-group-rows' }, element('div', { class: 'order-column-headings', 'aria-hidden': 'true' },
          ...['Дата', 'Менеджер', 'Автомобиль / строка', 'VIN', 'Работы', 'Статус', ''].map(label => element('span', {}, label))));
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
      element('span', { class: 'summary-date' }, displayDate(date) || 'Укажите дату'),
      element('span', { class: 'summary-manager' }, manager || '—'),
      element('span', { class: 'summary-vehicle' }, element('strong', {}, vehicle || 'Укажите автомобиль'),
        element('small', {}, date ? element('span', { class: 'summary-mobile-date' }, `${displayDate(date).slice(0,5)} · `) : null,
          row ? `Строка ${row}` : '', element('span', { class: 'summary-order-number' }, `${row && number ? ' · ' : ''}${number || (!row ? 'Заявка менеджера' : '')}`))),
      element('span', { class: 'summary-vin' }, vin || '—'),
      element('span', { class: 'summary-works', lang: 'ru' }, works || 'Выберите работы'),
      element('span', { class: `task-status ${draft ? 'status-review' : `status-${status}`}` }, draft ? 'На проверке' : STATUS_LABELS[status] || 'Неизвестный статус'),
      element('span', { class: 'disclosure-chevron', 'aria-hidden': 'true' }, '⌄'));
  }

  function intakeCard(intake) {
    const source = intake.latest || intake.original || {};
    const suggested = intake.suggested_order || {};
    const row = (intake.row_numbers || [])[0];
    const messages = {
      NO_APPROVED_TASKS: 'Выберите запрошенные менеджером работы из каталога.', INVALID_PLANNED_DATE: 'Укажите полную плановую дату.',
      INVALID_VIN: 'Подтвердите VIN автомобиля.', INVALID_MANAGER: 'Подтвердите имя менеджера.', INVALID_VEHICLE: 'Укажите автомобиль.',
      UNKNOWN_VEHICLE_GROUP: 'Выберите подходящую группу автомобилей.', DUPLICATE_SOURCE_KEY: 'Проверьте повторяющиеся строки таблицы перед публикацией.'
    };
    return disclosure(`intake-${intake.id}`, { class: 'order-card compact-order intake-row', 'data-intake-id': intake.id },
      rowSummary({ ...source, date: suggested.planned_date || source.date, manager: source.manager_label, row,
        works: [source.wrapping, source.tint].filter(Boolean).join(' · '), draft: true }),
      element('div', { class: 'order-expanded' },
        element('h3', { class: 'expanded-vehicle' }, `Автомобиль: ${source.vehicle || 'Укажите автомобиль'}`),
        element('p', { class: 'order-meta' }, 'Заявка менеджера · ожидает выбора работ'),
        element('p', { class: 'order-meta' }, [source.date, source.manager_label, source.vin ? `VIN: ${source.vin}` : '', source.colour].filter(Boolean).join(' · ')),
        element('ul', { class: 'intake-issues' }, ...[...new Set((intake.issues || []).map(code => messages[code] || 'Проверьте заявку менеджера и выберите работы для публикации.'))].map(message => element('li', {}, message))),
        managerReference(intake), element('div', { class: 'order-actions' }, button('Изменить заказ', () => openEditor('intake', intake)))));
  }

  function reportSummary(source) {
    const tasks = source.flatMap(order => order.tasks || []);
    const completed = tasks.filter(task => task.status === 'completed');
    const byMechanic = new Map();
    for (const task of completed) {
      const id = task.working_mechanic_id || 'unknown';
      const entry = byMechanic.get(id) || { name: task.working_name || 'Механик не указан', count: 0 };
      entry.count += 1;
      byMechanic.set(id, entry);
    }
    return element('section', { class: 'operational-report', 'aria-label': 'Сводка работ' },
      element('div', { class: 'report-statistics' },
        element('div', {}, element('strong', {}, source.filter(order => order.status === 'published').length.toLocaleString('ru-RU')), element('span', {}, 'Открытые заказы')),
        element('div', {}, element('strong', {}, completed.length.toLocaleString('ru-RU')), element('span', {}, 'Выполненные работы')),
        element('div', {}, element('strong', {}, tasks.filter(task => task.status === 'blocked').length.toLocaleString('ru-RU')), element('span', {}, 'Приостановленные работы'))),
      byMechanic.size ? element('div', { class: 'mechanic-totals' }, [...byMechanic.values()].map(entry => element('p', {},
        element('strong', {}, entry.name), element('span', {}, `Выполнено: ${entry.count.toLocaleString('ru-RU')}`)))) : element('p', { class: 'muted' }, 'Выполненные работы будут сгруппированы по исполнителям.'));
  }

  function orderCard(order) {
    const tasks = visibleTasks(order);
    const actions = element('div', { class: 'order-actions' });
    const actionForm = element('div', { class: 'inline-action' });
    const financial = element('div', { class: 'private-amounts' });
    if (owner) {
      if (section === 'orders' && order.status === 'published') actions.append(button('Изменить заказ', () => openEditor('edit', order)));
      actions.append(button('Посмотреть стоимость', () => loadFinancials(order, financial)));
      if (order.status !== 'cancelled') actions.append(button('Добавить пропущенную выполненную работу', () => openEditor('completion', order)));
      if (order.status === 'published') {
        if ((order.tasks || []).some(task => task.status === 'completed') && (order.tasks || []).every(task => TERMINAL_TASKS.has(task.status))) {
          actions.append(button('Закрыть заказ', () => mutate('garage_order_action', {
            p_order_id: order.id, p_action: 'close', p_expected_version: order.version, p_note: ''
          }, 'Заказ закрыт.')));
        }
        actions.append(button('Отменить заказ', () => reasonForm(actionForm, 'Отменить заказ', 'Подтвердить отмену', note => mutate('garage_order_action', {
          p_order_id: order.id, p_action: 'cancel', p_expected_version: order.version, p_note: note
        }, 'Оставшиеся работы отменены. Выполненные работы сохранены в истории.'), 'Выполненные работы сохранятся в истории. Остальные работы будут отменены.')));
      }
    }
    const intake = owner ? intakes.find(item => item.order_id === order.id) : null;
    const uncancelled = tasks.filter(task => task.status !== 'cancelled');
    const card = disclosure(`order-${order.id}`, { class: 'order-card compact-order', 'data-order-id': order.id },
      rowSummary({ vehicle: order.vehicle, date: order.planned_date, manager: order.manager_label, vin: order.vin,
        row: order.source_row_number, number: order.order_number, status: order.status,
        works: `Работ: ${uncancelled.length.toLocaleString('ru-RU')} · ${uncancelled.map(task => `${task.work_name}${task.work_code === 'W19' ? ` ${task.options?.tint_percent || ''}%` : ''}`).join(' · ')}` }),
      element('div', { class: 'order-expanded' },
      element('h3', { class: 'expanded-vehicle' }, `Автомобиль: ${order.vehicle}`),
      element('div', { class: 'order-detail-heading' },
        element('p', { class: 'order-meta' }, `${order.order_number} · ${order.source === 'owner' ? 'Назначение владельца' : 'Очередь менеджеров'}`),
        order.priority !== 'normal' ? element('span', { class: `priority priority-${order.priority}` }, order.priority === 'urgent' ? 'Срочный' : 'Высокий приоритет') : null),
      element('p', { class: 'order-meta' }, [order.vehicle_group_name || order.vehicle_group_code,
        order.vin ? `VIN: ${order.vin}` : '', order.colour || '', order.planned_date ? `План: ${displayDate(order.planned_date)}` : '',
        order.due_date ? `Срок: ${displayDate(order.due_date)}` : ''].filter(Boolean).join(' · ')),
      order.manager_label ? element('p', { class: 'order-meta' }, `Менеджер: ${order.manager_label}`) : null,
      owner && (intake?.source_changed || order.source_changed) ? element('p', { class: 'source-change-notice' }, order.source_missing
        ? 'Строки больше нет в подключённой таблице. Сохранённый заказ остаётся в приложении.'
        : intake?.owner_managed || order.owner_managed ? 'Текст таблицы изменился после проверки владельцем. Выбранные работы сохранены.'
          : 'Текст таблицы менеджеров изменился. Проверьте актуальную заявку перед редактированием заказа.') : null,
      order.instructions && order.instructions !== order.manager_comment
        && !(order.instructions_from_manager === true && order.manager_comment_updated_at)
        ? element('p', { class: 'order-instructions' }, order.instructions) : null,
      order.manager_comment ? element('section', { class: 'order-manager-comment', 'aria-label': 'Комментарий менеджера' },
        element('h4', {}, 'Комментарий менеджера'), element('p', { class: 'order-instructions' }, order.manager_comment),
        order.manager_comment_updated_at && Number.isFinite(new Date(order.manager_comment_updated_at).getTime())
          ? element('p', { class: 'order-meta' }, `Обновлено: ${new Date(order.manager_comment_updated_at).toLocaleString('ru-RU')}`) : null) : null,
      managerReference(intake), element('div', { class: 'order-tasks' }, tasks.map(task => taskRow(order, task))), actions, actionForm, financial));
    if (owner && financialViews.has(order.id)) financial.append(financialSummary(financialViews.get(order.id)));
    return card;
  }

  drawOrders();
}
