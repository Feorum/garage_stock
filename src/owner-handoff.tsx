import { useRef, useState } from 'preact/hooks';
import { instantLabel, taskName, type HandoffTask } from './shift-model';
import { errorText, isConflict, statusText, type Mutate, type OwnerOrder } from './owner-model';

function SnapshotList({ title, tasks }: { title: string; tasks: HandoffTask[] }) {
  return (
    <div>
      <h4>{title}</h4>
      {tasks.length ? (
        <ul>
          {tasks.map((t) => (
            <li key={t.id}>
              {taskName(t)} · {statusText[t.status] || t.status}
            </li>
          ))}
        </ul>
      ) : (
        <p>Нет работ</p>
      )}
    </div>
  );
}

export function OwnerHandoff({
  order,
  mutate,
  reload,
  notify,
}: {
  order: OwnerOrder;
  mutate: Mutate;
  reload(): Promise<void>;
  notify(text: string): void;
}) {
  const [note, setNote] = useState('');
  const [base, setBase] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const workflow = order.vehicle_workflow;
  if (!workflow) return null;
  const review = workflow.state === 'review';
  const snapshot = workflow.handoff_tasks || [];
  const version = base ?? order.version;
  async function decide(action: 'return' | 'close') {
    if (sending.current || version !== order.version || stale) return;
    sending.current = true;
    setBusy(true);
    setError('');
    setBase(version);
    try {
      await mutate('garage_vehicle_action', {
        p_order_id: order.id,
        p_action: action,
        p_expected_version: version,
        p_note: note.trim(),
      });
      setNote('');
      setBase(null);
      notify(action === 'return' ? 'Автомобиль возвращён в работу.' : 'Автомобиль принят. Заказ закрыт.');
      await reload();
    } catch (failure) {
      setError(errorText(failure));
      setStale(isConflict(failure));
      await reload();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const caption = {
    available: 'Ожидает механика',
    active: 'Автомобиль в работе',
    review: 'Передан владельцу',
    closed: 'Заказ закрыт',
    cancelled: 'Заказ отменён',
  }[workflow.state];
  return (
    <section class="owner-handoff" aria-label="Передача автомобиля">
      <h3>{caption}</h3>
      {(workflow.holder_name || workflow.taken_at) && (
        <p>
          {[workflow.holder_name, workflow.taken_at && 'Принято в работу ' + instantLabel(workflow.taken_at)]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {workflow.handed_at && <p>Передача · {instantLabel(workflow.handed_at)}</p>}
      {workflow.handoff_note && (
        <div class="handoff-note">
          <strong>От механика</strong>
          <p>{workflow.handoff_note}</p>
        </div>
      )}
      {workflow.returned_at && <p>Последний возврат · {instantLabel(workflow.returned_at)}</p>}
      {workflow.return_note && <p class="handoff-note">Механику при возврате · {workflow.return_note}</p>}
      {snapshot.length > 0 && (
        <details class="order-handoff-history">
          <summary>Состав работ при передаче</summary>
          <div class="handoff-snapshot">
          <SnapshotList
            title="Выполнено при передаче"
            tasks={snapshot.filter((t) => t.status === 'completed')}
          />
          <SnapshotList
            title="Осталось при передаче"
            tasks={snapshot.filter((t) => !['completed', 'cancelled'].includes(t.status))}
          />
          {snapshot.some((t) => t.status === 'cancelled') && (
            <SnapshotList
              title="Отменено при передаче"
              tasks={snapshot.filter((t) => t.status === 'cancelled')}
            />
          )}
          </div>
        </details>
      )}
      {(workflow.can_return || workflow.can_close) && (
        <fieldset disabled={busy}>
          <legend class="sr-only">Решение владельца</legend>
          <label>
            {workflow.can_close
              ? workflow.can_return ? 'Комментарий к решению (необязательно)' : 'Комментарий к закрытию (необязательно)'
              : 'Механику при возврате (необязательно)'}
            <textarea
              maxLength={1000}
              value={note}
              onInput={(e) => {
                setBase(version);
                setNote(e.currentTarget.value);
              }}
            />
          </label>
          {workflow.can_close && workflow.can_return && <p class="field-hint">При возврате комментарий увидит механик.</p>}
          {review && !workflow.can_close && (
            <p class="muted">
              {workflow.unfinished_count
                ? 'Чтобы закрыть заказ, завершите или отмените оставшиеся работы.'
                : 'Для закрытия нужна хотя бы одна выполненная работа.'}
            </p>
          )}
          {(version !== order.version || stale) && (
            <p class="notice">
              Заказ изменился. Проверьте передачу и список работ.{' '}
              <button
                class="button"
                type="button"
                onClick={() => {
                  setBase(order.version);
                  setStale(false);
                  setError('');
                }}
              >
                Использовать актуальную версию
              </button>
            </p>
          )}
          <div class="work-decisions">
            {workflow.can_return && (
              <button
                class="button"
                type="button"
                disabled={stale || version !== order.version}
                onClick={() => decide('return')}
              >
                Вернуть в работу
              </button>
            )}
            {workflow.can_close && (
              <button
                class="button button-primary"
                type="button"
                disabled={stale || version !== order.version}
                onClick={() => decide('close')}
              >
                Принять и закрыть заказ
              </button>
            )}
          </div>
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
