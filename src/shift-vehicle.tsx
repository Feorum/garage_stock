import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  dayLabel,
  instantLabel,
  mine,
  participants,
  primaryAction,
  taskLabel,
  taskName,
  vehicleLabel,
  visibleProgress,
} from './shift-model';
import type { HandoffTask, Order, Section } from './shift-model';

interface RowProps {
  order: Order;
  selected: boolean;
  locked: boolean;
  open(): void;
  take(): void;
}
export function VehicleRow({ order, selected, locked, open, take }: RowProps) {
  const flow = order.vehicle_workflow;
  const progress = visibleProgress(order);
  return (
    <li class={'vehicle-index-row' + (selected ? ' is-selected' : '')} data-vehicle-id={order.id}>
      <button
        type="button"
        class="shift-row vehicle-index-button"
        data-shift-target={order.id}
        aria-current={selected ? 'true' : undefined}
        onClick={open}
      >
        <span class="shift-row-main">
          <small class="shift-code">
            {order.order_number}
            {order.vin && ` · VIN …${order.vin.slice(-6)}`}
            {order.priority === 'urgent' ? ' · Срочно' : order.priority === 'high' ? ' · Высокий приоритет' : ''}
          </small>
          <strong>{order.vehicle}</strong>
          <span>
            {flow?.holder_name
              ? `Ответственный: ${flow.holder_name}`
              : order.source === 'owner'
                ? 'Поручение владельца'
                : 'Заказ менеджера'}
          </span>
          <small>
            Выполнено: {progress.completed} · Осталось: {progress.unfinished}
            {order.due_date && ` · Срок ${dayLabel(order.due_date)}`}
          </small>
        </span>
        {!flow?.can_take && (
          <span class="shift-row-end">
            <span class={`vehicle-status vehicle-${flow?.state || 'unknown'}`}>{vehicleLabel(order)}</span>
          </span>
        )}
      </button>
      {flow?.can_take && (
        <button type="button" class="button button-primary vehicle-take" disabled={locked} onClick={take}>
          Взять автомобиль
        </button>
      )}
    </li>
  );
}

function WorkChecklist({ tasks }: { tasks: HandoffTask[] }) {
  const complete = tasks.filter((task) => task.status === 'completed');
  const open = tasks.filter((task) => !['completed', 'cancelled'].includes(task.status));
  return (
    <div class="vehicle-checklist">
      {[
        { title: 'Выполнено', items: complete },
        { title: 'Осталось выполнить', items: open },
      ].map((group) => (
        <section key={group.title}>
          <h4>
            {group.title} · {group.items.length}
          </h4>
          {!!group.items.length && (
            <ul>
              {group.items.map((task) => (
                <li key={task.id}>
                  <span>{taskName(task)}</span>
                  {task.status !== 'completed' && <small>{taskLabel[task.status] || 'В работе'}</small>}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
function nextService(order: Order, profileId: string) {
  const choices = order.tasks.map(task => ({ task, action: primaryAction({ order, task }, profileId) }));
  for (const action of ['confirm', 'start', 'resume', 'join']) {
    const choice = choices.find(item => item.action === action);
    if (choice) return choice.task;
  }
}

interface DetailProps {
  order: Order;
  profileId: string;
  section: Section;
  locked: boolean;
  saving: boolean;
  openTask(id: string): void;
  close(): void;
  take(): void;
  handoff(version: number, note: string): Promise<boolean>;
}
export function VehicleDetail({
  order,
  profileId,
  section,
  locked,
  saving,
  openTask,
  close,
  take,
  handoff,
}: DetailProps) {
  const flow = order.vehicle_workflow;
  const [draft, setDraft] = useState<{ version: number; note: string } | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const checklistTitle = useRef<HTMLHeadingElement>(null);
  const handoffButton = useRef<HTMLButtonElement>(null);
  const wasDraft = useRef(false);
  useLayoutEffect(() => {
    title.current?.focus({ preventScroll: true });
  }, [order.id]);
  const canTake = order.status === 'published' && flow?.state === 'available' && flow.can_take;
  const canHandoff = order.status === 'published' && flow?.state === 'active' && flow.can_handoff;
  const showDraft = !!draft && !!canHandoff;
  useLayoutEffect(() => {
    if (showDraft) checklistTitle.current?.focus();
    else if (wasDraft.current) {
      if (handoffButton.current) handoffButton.current.focus();
      else title.current?.focus({ preventScroll: true });
    }
    wasDraft.current = showDraft;
  }, [showDraft]);
  const tasks = order.tasks || [];
  const counted = visibleProgress(order);
  const total = counted.completed + counted.unfinished;
  const stale = !!draft && draft.version !== order.version;
  const history = section === 'history';
  const next = !history && !showDraft && !locked && counted.unfinished > 0 ? nextService(order, profileId) : undefined;
  const orderedTasks = next && next !== tasks[0] ? [next, ...tasks.filter(task => task !== next)] : tasks;
  const readyToHandoff = !history && counted.completed > 0 && counted.unfinished === 0;
  const handoffControl = canHandoff && !showDraft && (
    <div class="vehicle-controls">
      <button
        type="button"
        ref={handoffButton}
        class={readyToHandoff ? 'button button-primary' : 'button vehicle-secondary-action'}
        disabled={locked}
        onClick={() => setDraft({ version: order.version, note: '' })}
      >
        Передать владельцу
      </button>
    </div>
  );
  return (
    <article
      class="shift-detail vehicle-detail"
      data-vehicle-detail={order.id}
      aria-labelledby="vehicle-visit-title"
    >
      <div class="shift-detail-top">
        <button type="button" class="button shift-back" onClick={close}>
          ← К списку
        </button>
        <span class="shift-code">{order.order_number}</span>
      </div>
      <div class="vehicle-visit-heading">
        <h2 ref={title} tabIndex={-1} data-route-heading id="vehicle-visit-title">
          {order.vehicle}
        </h2>
        <div class="shift-priority-line">
          <span class={`vehicle-status vehicle-${flow?.state || 'unknown'}`}>{vehicleLabel(order)}</span>
          {order.priority === 'urgent' && <span class="priority priority-urgent">Срочно</span>}
        </div>
      </div>
      {flow?.holder_name && (
        <p class="shift-hint">
          Ответственный: {flow.holder_name}
          {flow.holder_id === profileId ? ' · Вы' : ''}
        </p>
      )}
      {canTake && (
        <div class="vehicle-controls">
          <button type="button" class={history ? 'button' : 'button button-primary'} disabled={locked} onClick={take}>
            Взять автомобиль
          </button>
        </div>
      )}
      {readyToHandoff && handoffControl}
      {showDraft && draft && (
        <form
          class="vehicle-handoff"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!stale && (await handoff(draft.version, draft.note))) setDraft(null);
          }}
        >
          <h3 tabIndex={-1} ref={checklistTitle}>
            Передача владельцу
          </h3>
          <p>Проверьте состояние доступных вам работ перед передачей автомобиля.</p>
          <WorkChecklist tasks={tasks} />
          <label>
            Комментарий владельцу <span class="shift-hint">(необязательно)</span>
            <textarea
              value={draft.note}
              maxLength={2000}
              onInput={(event) => setDraft({ ...draft, note: event.currentTarget.value })}
            />
          </label>
          {stale && (
            <p class="shift-alert" role="status">
              Список работ изменился. Проверьте обновлённый список и комментарий.{' '}
              <button
                type="button"
                class="button"
                disabled={locked}
                onClick={() => setDraft({ ...draft, version: order.version })}
              >
                Я проверил изменения
              </button>
            </p>
          )}
          <div class="shift-button-strip">
            <button class="button button-primary" disabled={locked || stale}>
              Подтвердить передачу
            </button>
            <button type="button" class="button" disabled={saving} onClick={() => setDraft(null)}>
              Отмена
            </button>
          </div>
        </form>
      )}
      {flow?.state === 'review' && (
        <section class="vehicle-receipt">
          <h3>Передача на проверку</h3>
          {flow.handed_at && <p>{instantLabel(flow.handed_at)}</p>}
          {flow.handoff_note && <p>{flow.handoff_note}</p>}
          {!!flow.handoff_tasks?.length && <WorkChecklist tasks={flow.handoff_tasks} />}
        </section>
      )}
      {flow?.state === 'active' && flow.returned_at && (
        <section class="vehicle-receipt">
          <h3>Владелец вернул автомобиль в работу</h3>
          <p>{instantLabel(flow.returned_at)}</p>
          {flow.return_note && <p>{flow.return_note}</p>}
        </section>
      )}
      {!flow && order.status === 'published' && (
        <p class="shift-alert">Статус автомобиля недоступен. Обновите смену.</p>
      )}
      <section class="shift-detail-section vehicle-services">
        <div class="shift-section-heading">
          <h3>Работы по автомобилю</h3>
          {total > 0 && (
            <span class="shift-count">{`Выполнено ${counted.completed} из ${total}`}</span>
          )}
        </div>
        {tasks.length ? (
          <ul class="shift-list">
            {orderedTasks.map((task) => {
              const team = participants(task);
              const names = team.map((member) => member.name).filter(Boolean);
              return (
                <li key={task.id} data-task-id={task.id}>
                  <button
                    type="button"
                    class="shift-row vehicle-task-row"
                    data-shift-target={task.id}
                    onClick={() => openTask(task.id)}
                  >
                    <span class="shift-row-main">
                      <strong>{taskName(task)}</strong>
                      {names.length > 0 && <small>Команда: {names.join(', ')}</small>}
                      {history && mine(task, profileId) === 'confirmed' && <small>Ваше выполнение учтено</small>}
                    </span>
                    <span class={`task-status status-${task.status}`}>
                      {taskLabel[task.status] || 'Состояние уточняется'}
                    </span>
                    {task === next ? (
                      <span class="button button-primary vehicle-open-task">Открыть работу</span>
                    ) : (
                      <span aria-hidden="true" class="shift-arrow">→</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p class="shift-hint">В этом посещении нет доступных работ.</p>
        )}
      </section>
      {!readyToHandoff && handoffControl}
      {order.manager_comment && (
        <section class="shift-detail-section">
          <h3>Комментарий менеджера</h3>
          <p>{order.manager_comment}</p>
        </section>
      )}
      {(order.vin || order.colour || order.planned_date || order.due_date) && (
        <dl class="shift-facts">
          {[
            ['VIN', order.vin],
            ['Цвет', order.colour],
            ['План', dayLabel(order.planned_date)],
            ['Срок', dayLabel(order.due_date)],
          ]
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      )}
    </article>
  );
}
