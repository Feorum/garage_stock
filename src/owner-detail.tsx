import { useState, useRef, useEffect } from 'preact/hooks';
import {
  participants,
  participantLabel,
  taskName,
  instantLabel,
  dayLabel,
  type Task,
  type GarageClient,
} from './shift-model';
import {
  statusText,
  errorText,
  read,
  type Staff,
  type Money,
  type OwnerOrder,
  type OwnerIntake,
  type Mutate,
} from './owner-model';
import { Price, SourceReference } from './owner-summary';

interface DetailProps {
  order: OwnerOrder;
  intake?: OwnerIntake;
  staff: Staff[];
  client: GarageClient;
  mutate: Mutate;
  reload: () => Promise<void>;
  edit: () => void;
  omit: () => void;
  back: () => void;
  notify: (s: string) => void;
}
function OwnerTask({
  task,
  order,
  staff,
  mutate,
  reload,
  notify,
}: Pick<DetailProps, 'order' | 'staff' | 'mutate' | 'reload' | 'notify'> & { task: Task }) {
  const [action, choose] = useState(''),
    [person, setPerson] = useState(''),
    [replacement, setReplacement] = useState(''),
    [reason, setReason] = useState('');
  const [version, setVersion] = useState(task.version),
    [err, setErr] = useState(''),
    [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const members = participants(task),
    adjustable = members.filter((m) => m.status !== 'confirmed'),
    others = staff.filter((s) => !members.some((m) => m.mechanic_id === s.id));
  function select(value: string) {
    choose(value);
    setPerson(value === 'assign' ? '' : adjustable.length === 1 ? adjustable[0].mechanic_id : '');
    setReplacement('');
    setReason('');
    setErr('');
    setVersion(task.version);
  }
  const labels: Record<string, string> = {
    assign: 'Добавить исполнителя',
    remove: 'Снять исполнителя',
    replace: 'Переназначить',
    cancel: 'Отменить работу',
  };
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (sending.current || !reason.trim() || task.version !== version) return;
    sending.current = true;
    setBusy(true);
    setErr('');
    try {
      if (action === 'cancel')
        await mutate('garage_task_action', {
          p_task_id: task.id,
          p_action: 'cancel',
          p_expected_version: version,
          p_note: reason.trim(),
          p_assignee: null,
        });
      else
        await mutate('garage_team_action', {
          p_task_id: task.id,
          p_action: action,
          p_expected_version: version,
          p_note: reason.trim(),
          p_mechanic_id: person,
          p_replacement_id: action === 'replace' ? replacement : null,
        });
      choose('');
      notify(action === 'cancel' ? 'Работа отменена.' : 'Состав команды обновлён.');
      await reload();
    } catch (error) {
      setErr(errorText(error));
      await reload();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <section class="task-row" data-task-id={task.id}>
      <div class="task-detail">
        <h3>{taskName(task)}</h3>
        <p class={'task-status status-' + task.status}>{statusText[task.status]}</p>
        {task.instructions && <p>{task.instructions}</p>}
        {task.blocker_reason && task.status === 'blocked' && <p>Приостановлено: {task.blocker_reason}</p>}
        {members.map((m) => (
          <p key={m.mechanic_id}>
            {m.name} · {participantLabel[m.status]}
          </p>
        ))}
        {task.completed_at && <p>Выполнено: {instantLabel(task.completed_at)}</p>}
        {members.some(
          (m) => (m as { confirmation_origin?: string }).confirmation_origin === 'owner_recorded',
        ) && <p>Выполнение записано владельцем</p>}
        {task.notes?.length ? (
          <details>
            <summary>История работы</summary>
            {task.notes
              .filter((n) => n.note)
              .map((n) => (
                <p key={n.id}>
                  {instantLabel(n.created_at)} · {n.name}: {n.note}
                </p>
              ))}
          </details>
        ) : null}
      </div>
      {order.status === 'published' && !['completed', 'cancelled'].includes(task.status) && (
        <div class="task-actions">
          <a class="button" href={'#shift/' + encodeURIComponent(task.id)}>
            Заметки команды
          </a>
          {others.length > 0 && order.source === 'owner' && !task.roster_locked && (
            <button type="button" class="button" onClick={() => select('assign')}>
              {labels.assign}
            </button>
          )}
          {adjustable.length > 0 && others.length > 0 && (
            <button type="button" class="button" onClick={() => select('replace')}>
              {labels.replace}
            </button>
          )}
          {adjustable.length > 0 && (members.length > 1 || order.source === 'manager') && (
            <button type="button" class="button" onClick={() => select('remove')}>
              {labels.remove}
            </button>
          )}
          <button type="button" class="button" onClick={() => select('cancel')}>
            {labels.cancel}
          </button>
        </div>
      )}
      {action && (
        <form class="inline-action" onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>{labels[action]}</legend>
            {action !== 'cancel' && (
              <label>
                {action === 'assign' ? 'Новый механик' : 'Участник команды'}
                <select required value={person} onChange={(e) => setPerson(e.currentTarget.value)}>
                  <option value="">Выберите механика</option>
                  {(action === 'assign'
                    ? others
                    : adjustable.map((m) => ({ id: m.mechanic_id, name: m.name }))
                  ).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {action === 'replace' && (
              <label>
                Новый механик
                <select required value={replacement} onChange={(e) => setReplacement(e.currentTarget.value)}>
                  <option value="">Выберите механика</option>
                  {others.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Причина
              <textarea
                required
                maxLength={1000}
                value={reason}
                onInput={(e) => setReason(e.currentTarget.value)}
              />
            </label>
            {version !== task.version && (
              <div class="notice">
                <p>Состояние работы изменилось. Проверьте участников.</p>
                <button type="button" class="button" onClick={() => setVersion(task.version)}>
                  Использовать актуальную версию
                </button>
              </div>
            )}
            {err && <p role="alert">{err}</p>}
            <button type="submit" class="button button-primary" disabled={version !== task.version}>
              {action === 'replace'
                ? 'Подтвердить переназначение'
                : action === 'cancel'
                  ? 'Подтвердить отмену'
                  : 'Сохранить изменение'}
            </button>{' '}
            <button type="button" class="button" onClick={() => choose('')}>
              Оставить без изменений
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
export function OwnerDetail({
  order,
  intake,
  staff,
  client,
  mutate,
  reload,
  edit,
  omit,
  back,
  notify,
}: DetailProps) {
  const [price, setPrice] = useState<Money | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [cancelVersion, setCancel] = useState<number | null>(null),
    [reason, setReason] = useState('');
  const sending = useRef(false),
    epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setPrice(null);
    return () => {
      epoch.current++;
    };
  }, [order.id, order.version]);
  async function financials() {
    const at = epoch.current;
    setError('');
    try {
      const data = await read<Money>(client, 'garage_order_financials', { p_order_id: order.id });
      if (at === epoch.current) setPrice(data);
    } catch {
      if (at === epoch.current) setError('Не удалось загрузить стоимость работ. Повторите попытку.');
    }
  }
  async function finish(action: string, version: number, note: string) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate('garage_order_action', {
        p_order_id: order.id,
        p_action: action,
        p_expected_version: version,
        p_note: note,
      });
      setCancel(null);
      notify(action === 'close' ? 'Заказ закрыт.' : 'Оставшиеся работы отменены.');
      await reload();
    } catch (err) {
      setError(errorText(err));
      await reload();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const canClose =
    order.tasks.some((t) => t.status === 'completed') &&
    order.tasks.every((t) => ['completed', 'cancelled'].includes(t.status));
  return (
    <article class="owner-order-detail" aria-label={'Заказ ' + order.order_number}>
      <button class="button" type="button" onClick={back}>
        К списку заказов
      </button>
      <header>
        <p>
          {order.order_number} · {statusText[order.status]} ·{' '}
          {order.source === 'owner' ? 'Назначение владельца' : 'Очередь менеджеров'}
        </p>
        <h2>{order.vehicle}</h2>
      </header>
      <p>
        {[order.vehicle_group_name, order.colour, order.vin && 'VIN: ' + order.vin, order.manager_label]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p>
        {[
          order.planned_date && 'План: ' + dayLabel(order.planned_date),
          order.due_date && 'Срок: ' + dayLabel(order.due_date),
          order.priority === 'urgent' ? 'Срочный' : order.priority === 'high' ? 'Высокий приоритет' : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {(order.source_changed || intake?.source_changed) && (
        <p class="notice">
          {order.source_missing
            ? 'Строки больше нет в подключённой таблице. Сохранённый заказ остаётся в приложении.'
            : intake?.owner_managed || order.owner_managed
              ? 'Текст таблицы изменился после проверки владельцем. Выбранные работы сохранены.'
              : 'Текст таблицы менеджеров изменился. Проверьте актуальную заявку перед редактированием заказа.'}
        </p>
      )}
      {order.instructions &&
        order.instructions !== order.manager_comment &&
        !(order.instructions_from_manager && order.manager_comment_updated_at) && <p>{order.instructions}</p>}
      {order.manager_comment && (
        <section class="order-manager-comment" aria-label="Комментарий менеджера">
          <h3>Комментарий менеджера</h3>
          <p>{order.manager_comment}</p>
          {order.manager_comment_updated_at && (
            <small>{instantLabel(order.manager_comment_updated_at)}</small>
          )}
        </section>
      )}
      <SourceReference intake={intake} />
      <div class="order-tasks">
        {order.tasks.map((t) => (
          <OwnerTask
            key={t.id}
            task={t}
            order={order}
            staff={staff}
            mutate={mutate}
            reload={reload}
            notify={notify}
          />
        ))}
      </div>
      <div class="order-actions">
        {order.status === 'published' && (
          <button type="button" class="button button-primary" onClick={edit}>
            Изменить заказ
          </button>
        )}
        <button type="button" class="button" onClick={financials}>
          Посмотреть стоимость
        </button>
        {order.status !== 'cancelled' && (
          <button type="button" class="button" onClick={omit}>
            Добавить пропущенную выполненную работу
          </button>
        )}
        {order.status === 'published' && canClose && (
          <button
            type="button"
            class="button"
            disabled={busy}
            onClick={() => finish('close', order.version, '')}
          >
            Закрыть заказ
          </button>
        )}
        {order.status === 'published' && (
          <button
            type="button"
            class="button"
            onClick={() => {
              setCancel(order.version);
              setReason('');
            }}
          >
            Отменить заказ
          </button>
        )}
      </div>
      {price && <Price value={price} />}
      {cancelVersion !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) finish('cancel', cancelVersion, reason.trim());
          }}
        >
          <fieldset disabled={busy}>
            <legend>Отмена заказа</legend>
            <label>
              Причина
              <textarea
                required
                maxLength={2000}
                value={reason}
                onInput={(e) => setReason(e.currentTarget.value)}
              />
            </label>
            <p>Оставшиеся работы будут отменены. Выполненные сохранятся в истории.</p>
            {cancelVersion !== order.version && (
              <button type="button" class="button" onClick={() => setCancel(order.version)}>
                Проверить актуальную версию
              </button>
            )}
            <button class="button" disabled={cancelVersion !== order.version} type="submit">
              Подтвердить отмену
            </button>{' '}
            <button type="button" class="button" onClick={() => setCancel(null)}>
              Оставить без изменений
            </button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
