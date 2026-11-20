import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { WorkRow, Instructions, HandoffForm, type Draft } from './mechanic-vehicle';
import { useBoardChanges, useBoardOrders, type BoardOrder, type ChangeState } from './mechanic-board-data';
import { instantLabel, mine, participants, taskName, visibleProgress, type ShiftProps } from './shift-model';
import type { Client } from './workspace-types';
import './mechanic-board.css';

type BoardProps = Omit<ShiftProps, 'client'> & { client: Client };
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Minsk' });

function dateLabel(order: BoardOrder) {
  const raw = order.planned_date || order.due_date;
  const day = raw && new Date(raw.slice(0, 10) + 'T12:00:00Z');
  if (!day || !Number.isFinite(day.getTime())) return 'Дата не указана';
  return (order.planned_date ? 'План · ' : 'План не указан · Срок ') + shortDate.format(day);
}

function editable(order: BoardOrder) {
  const state = order.vehicle_workflow?.state;
  return order.status === 'published' && (!state || state === 'available' || state === 'active');
}

function isInHistory(order: BoardOrder, profileId: string) {
  const flow = order.vehicle_workflow;
  return (
    order.tasks.some((task) => mine(task, profileId) === 'confirmed') ||
    flow?.handed_by === profileId ||
    (!!flow?.handed_at && flow.holder_id === profileId)
  );
}

function historyTime(order: BoardOrder, profileId: string) {
  const times = order.tasks.flatMap((task) =>
    participants(task)
      .filter((person) => person.mechanic_id === profileId && person.status === 'confirmed')
      .map((person) => person.confirmed_at || task.completed_at || ''),
  );
  if (order.vehicle_workflow?.handed_at) times.push(order.vehicle_workflow.handed_at);
  return times.sort().pop() || '';
}

function listOrders(orders: BoardOrder[], source: string, profileId: string, history: boolean) {
  if (history)
    return orders
      .filter((order) => isInHistory(order, profileId))
      .sort(
        (a, b) => historyTime(b, profileId).localeCompare(historyTime(a, profileId)) || a.id.localeCompare(b.id),
      );
  return orders
    .filter((order) => order.source === source && editable(order))
    .sort(
      (a, b) =>
        (a.planned_date || '9999').localeCompare(b.planned_date || '9999') ||
        a.order_number.localeCompare(b.order_number, 'ru', { numeric: true }) ||
        a.id.localeCompare(b.id),
    );
}

export function MechanicBoard({ client, profile, section, recordId, navigate }: BoardProps) {
  const board = useBoardOrders(client, profile.id);
  const actions = useBoardChanges(client, board.refresh);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [notice, setNotice] = useState('');
  const region = useRef<HTMLDivElement>(null);
  const history = section === 'history';
  const source = section === 'manager-orders' ? 'manager' : 'owner';
  const title = history ? 'История' : source === 'owner' ? 'Заказы владельца' : 'Заказы менеджеров';
  const rows = useMemo(
    () => listOrders(board.orders || [], source, profile.id, history),
    [board.orders, source, profile.id, history],
  );
  const selected = recordId
    ? board.orders?.find((order) => order.id === recordId || order.tasks.some((task) => task.id === recordId))
    : undefined;
  const currentRoute = useRef({ section, recordId });
  currentRoute.current = { section, recordId };
  const expandedRoute = useRef('');
  useLayoutEffect(() => {
    if (!recordId || !board.orders) {
      expandedRoute.current = '';
      return;
    }
    const key = section + '/' + recordId;
    if (selected && rows.includes(selected)) {
      expandedRoute.current = key;
      return;
    }
    if (!selected || key === expandedRoute.current) {
      expandedRoute.current = '';
      navigate(section);
      return;
    }
    // Existing task links can point to a different source, or to a visit now in history.
    const destination = editable(selected)
      ? selected.source === 'manager'
        ? 'manager-orders'
        : 'shift'
      : isInHistory(selected, profile.id)
        ? 'history'
        : undefined;
    if (destination && destination !== section) navigate(destination, selected.id);
    else navigate(section);
  }, [selected, section, recordId, rows, board.orders, profile.id]);
  const locked = !board.online || !!board.error;
  function editDraft(id: string, draft?: Draft) {
    setDrafts((previous) => {
      const next = { ...previous };
      if (draft) next[id] = draft;
      else delete next[id];
      return next;
    });
  }
  function completedSubmission(id: string) {
    editDraft(id);
    setNotice('Автомобиль передан владельцу.');
    const route = currentRoute.current;
    if (route.recordId === id || (selected && route.recordId === recordId && selected.id === id))
      navigate(route.section);
  }
  async function repeat(state: ChangeState) {
    const accepted = await actions.retry(state);
    if (accepted && !state.change.taskId) completedSubmission(state.change.orderId);
    if (accepted && state.change.taskId) focusWork(state.change.taskId);
  }
  function feedback(inPanel: boolean) {
    return Object.entries(actions.changes).map(([id, state]) => {
      const onSelectedOrder = !!selected && rows.includes(selected) && selected.id === state.change.orderId;
      if (state.status === 'pending' || inPanel !== onSelectedOrder) return null;
      const order = board.orders?.find((item) => item.id === state.change.orderId);
      const task = order?.tasks.find((item) => item.id === state.change.taskId);
      return (
        <div key={id} class="mb-feedback" role="status">
          {task ? taskName(task) + ' · ' : order ? order.vehicle + ' · ' : ''}
          {state.message}{' '}
          {state.status === 'unknown' ? (
            <button type="button" class="button" disabled={!board.online} onClick={() => void repeat(state)}>
              Проверить отправку
            </button>
          ) : (
            <button type="button" class="button" onClick={() => actions.dismiss(id)}>
              Закрыть
            </button>
          )}
        </div>
      );
    });
  }
  function restoreFocus(selector: string, scroll = false) {
    requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === region.current)
        region.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: !scroll });
    });
  }
  function focusWork(id: string) {
    restoreFocus(`[data-task-id="${CSS.escape(id)}"] .mb-work`);
  }

  return (
    <div ref={region} class="mechanic-board">
      <h1 tabIndex={-1} data-route-heading>
        {title}
      </h1>
      {board.error && (
        <p class="mb-feedback" role="alert">
          {board.error}{' '}
          <button type="button" class="button" disabled={!board.online} onClick={() => void board.refresh()}>
            Обновить
          </button>
        </p>
      )}
      {feedback(false)}
      {notice && (
        <p role="status" class="mb-notice">
          {notice}
        </p>
      )}
      {!board.orders ? (
        !board.error && (
          <p class="shift-hint" role="status">
            {board.online ? 'Загружаем заказы…' : 'Для загрузки заказов требуется подключение.'}
          </p>
        )
      ) : !rows.length ? (
        <p class="shift-hint">{history ? 'История пока пуста.' : 'Заказов пока нет.'}</p>
      ) : (
        rows.map((order) => {
          const expanded = !!selected && selected.id === order.id;
          const flow = order.vehicle_workflow;
          const progress = visibleProgress(order);
          const orderChange = actions.changes[order.id];
          const pending = Object.values(actions.changes).some(
            (item) => item.change.orderId === order.id && item.status !== 'rejected',
          );
          const sending = !!orderChange && orderChange.status !== 'rejected';
          const canSubmit = !history && editable(order) && !!flow?.can_submit;
          const draft = canSubmit && drafts[order.id];
          const panelId = 'mb-works-' + order.id;
          return (
            <article class={'mb-card' + (expanded ? ' mb-open' : '')} key={order.id} data-vehicle-id={order.id}>
              <button
                type="button"
                class="mb-order"
                data-shift-target={order.id}
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => {
                  setNotice('');
                  navigate(section, expanded ? undefined : order.id);
                }}
              >
                <strong>{order.vehicle}</strong>
                <span class="mb-date">{dateLabel(order)}</span>
                <span aria-hidden="true" class="mb-chevron" />
                {!expanded && order.tasks.length > 0 && (
                  <span class="mb-summary">{order.tasks.map(taskName).join(' · ')}</span>
                )}
              </button>
              <div id={panelId} hidden={!expanded}>
                {expanded && (
                  <div class="mb-panel">
                    {feedback(true)}
                    {!draft && (
                      <>
                        <ul class="mb-work-list">
                          {order.tasks.map((task) => {
                            const change = actions.changes[task.id];
                            return (
                              <WorkRow
                                key={task.id}
                                task={task}
                                ownId={profile.id}
                                readOnly={history || !editable(order)}
                                disabled={locked || sending || change?.status === 'unknown'}
                                pending={change?.status === 'pending'}
                                toggle={async (checked) => {
                                  setNotice('');
                                  const saved = checked ? await actions.check(order.id, task.id) :
                                    await actions.uncheck(order.id, task.id, task.version);
                                  if (saved) focusWork(task.id);
                                }}
                              />
                            );
                          })}
                        </ul>
                        {!order.tasks.length && <p class="shift-hint">Нет доступных работ.</p>}
                        <Instructions order={order} />
                      </>
                    )}
                    {history && flow?.handed_at && (
                      <p class="mb-history-note">Передан владельцу · {instantLabel(flow.handed_at)}</p>
                    )}
                    {history && flow?.handoff_note && <p class="mb-history-note">{flow.handoff_note}</p>}
                    {canSubmit &&
                      (draft ? (
                        <HandoffForm
                          order={order}
                          draft={draft}
                          disabled={locked || pending}
                          sending={sending}
                          update={(next) => editDraft(order.id, next)}
                          cancel={() => {
                            editDraft(order.id);
                            restoreFocus('[data-submit-vehicle="' + CSS.escape(order.id) + '"]', true);
                          }}
                          confirm={async () => {
                            if (await actions.submit(order.id, draft.version, draft.note))
                              completedSubmission(order.id);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          class={
                            'button mb-handoff' +
                            (progress.completed > 0 && !progress.unfinished ? ' button-primary' : '')
                          }
                          data-submit-vehicle={order.id}
                          disabled={locked || pending}
                          onClick={() => editDraft(order.id, { version: order.version, note: '' })}
                        >
                          Передать владельцу
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </article>
          );
        })
      )}
    </div>
  );
}
