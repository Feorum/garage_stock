import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ExecutorMarker } from './executor-marker';
import { formatOrderDay, orderDay, weekdayClass } from './order-calendar';
import { errorText, isConflict, type OwnerOrder } from './owner-model';
import { money } from './pay-model';
import { participants, taskName } from './shift-model';
import type { Client } from './workspace-types';
import './owner-review.css';

export interface ReviewRate {
  task_id: string;
  net_kopeks: number | null;
  effective_kopeks: number | null;
}

type Action = 'close' | 'return';
interface Decision {
  action: Action;
  version: number;
  note: string;
  requestId: string;
}

interface Props {
  order: OwnerOrder;
  rates?: ReviewRate[];
  loadingPrices: boolean;
  current: boolean;
  client: Client;
  refresh(message?: string): void;
}

function displayPrice(value: number | null | undefined, loading: boolean) {
  if (loading) return 'Загрузка…';
  if (value === null) return 'Цена не указана';
  return value !== undefined && Number.isSafeInteger(value) ? money(value) : 'Цена недоступна';
}

export function ReviewCard({ order, rates, loadingPrices, current, client, refresh }: Props) {
  const flow = order.vehicle_workflow!;
  const jobs = order.tasks.filter(task => task.status === 'completed');
  const amounts = new Map(rates?.map(rate => [rate.task_id, rate.effective_kopeks]));
  const day = orderDay(order);
  const handoffNote = flow.handoff_note?.trim();
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<Decision | null>(null);
  const [acceptedVersion, setAcceptedVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const returning = draftVersion !== null;
  const stale = (returning && draftVersion !== order.version) || conflict !== null;
  const locked = busy || !current || acceptedVersion === order.version;
  const complete = flow.can_close && flow.completed_count > 0 && flow.unfinished_count === 0;

  useLayoutEffect(() => {
    if (returning) noteField.current?.focus();
    else if (restoreFocus.current) returnButton.current?.focus();
    restoreFocus.current = false;
  }, [returning]);

  async function send(decision: Decision) {
    if (sending.current || !navigator.onLine) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await client.rpc('garage_vehicle_action', {
        p_order_id: order.id, p_action: decision.action, p_expected_version: decision.version,
        p_note: decision.note, p_request_id: decision.requestId,
      });
      if (result.error) throw { ...result.error, status: result.status };
      setAcceptedVersion(decision.version);
      setUncertain(null);
      setDraftVersion(null);
      setNote('');
      refresh(decision.action === 'close' ? 'Заказ закрыт.' : 'Заказ возвращён в работу.');
    } catch (failure) {
      const issue = failure as { code?: string; status?: number; message?: string };
      if (!issue?.code || (issue.status ?? 0) >= 500 || /network|fetch|timeout|connection|lost/i.test(issue.message || '')) {
        setUncertain(decision);
        setError('Ответ не получен. Проверьте отправку.');
      } else {
        setUncertain(null);
        if (isConflict(issue)) setConflict(decision.version);
        else setError(/without financial information/i.test(issue.message || '')
          ? 'Укажите в комментарии только сведения о работе.' : errorText(issue));
      }
      refresh();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function decide(action: Action) {
    if (locked || stale || uncertain || (action === 'close' ? !complete : !flow.can_return)) return;
    void send({ action, version: order.version, note: action === 'return' ? note.trim() : '', requestId: crypto.randomUUID() });
  }

  return <article class={'owner-board-card owner-review-card ' + weekdayClass(day)} data-order-id={order.id}>
    <a class="owner-review-title" href={'#orders/' + encodeURIComponent(order.id)}>
      <h2>{order.vehicle}</h2>
      <p class="owner-review-meta">
        {order.colour && <span>{order.colour}</span>}
        {day ? <span>{day === order.planned_date ? 'Запись' : 'Срок'} · <time dateTime={day}>{formatOrderDay(day)}</time></span>
          : <span>Дата записи не указана</span>}
      </p>
      {flow.unfinished_count > 0 && <p class="owner-review-incomplete">Осталось работ · {flow.unfinished_count}</p>}
    </a>
    {jobs.length ? <ul class="owner-review-jobs" aria-label="Выполненные работы и цены">
      {jobs.map(task => {
        const team = participants(task).filter(person => person.status === 'confirmed');
        return <li key={task.id}>
          <div class="owner-review-service">
            <span>{taskName(task)}</span>
            <div class="owner-review-executors">
              {team.length ? team.map(person => <ExecutorMarker key={person.mechanic_id} id={person.mechanic_id}
                name={person.name} color={person.color} />)
                : <small>{task.working_name || 'Исполнитель не указан'}</small>}
            </div>
          </div>
          <span class="owner-review-amount">{displayPrice(amounts.get(task.id), loadingPrices)}</span>
        </li>;
      })}
    </ul> : <p class="owner-review-no-jobs">Выполненных работ пока нет.</p>}
    {handoffNote && <section class="owner-review-note">
      <h3>Комментарий механика</h3>
      <p>{handoffNote}</p>
    </section>}
    <fieldset class="owner-review-controls" disabled={locked} aria-busy={busy}>
      <legend class="sr-only">Решение по заказу {order.vehicle}</legend>
      {uncertain ? <button type="button" class="button" onClick={() => void send(uncertain)}>Проверить отправку</button> :
        returning ? <form onSubmit={event => { event.preventDefault(); decide('return'); }}>
          <label>Комментарий механику (необязательно)
            <textarea ref={noteField} maxLength={1000} value={note} onInput={event => setNote(event.currentTarget.value)} />
          </label>
          <div class="work-decisions">
            <button class="button" type="button" onClick={() => {
              restoreFocus.current = true;
              setDraftVersion(null); setNote(''); setError('');
            }}>Отмена</button>
            <button class="button button-primary" type="submit" disabled={stale || !flow.can_return}>Вернуть в работу</button>
          </div>
        </form> : <div class="work-decisions">
          {flow.can_return && <button ref={returnButton} type="button" class="button" disabled={stale}
            onClick={() => { setError(''); setDraftVersion(order.version); }}>На доработку</button>}
          {complete && <button type="button" class="button button-primary" disabled={stale}
            onClick={() => decide('close')}>Подтвердить</button>}
        </div>}
      {stale && !uncertain && <div class="owner-review-warning" role="alert">
        <p>Заказ изменился. Проверьте обновлённые работы.</p>
        <button class="button" type="button" onClick={() => {
          if (conflict === order.version) { refresh(); return; }
          setConflict(null);
          if (returning) setDraftVersion(order.version);
        }}>{conflict === order.version ? 'Обновить заказ' : 'Использовать актуальную версию'}</button>
      </div>}
      {busy && <p role="status">Сохраняем решение…</p>}
      {error && <p class="owner-review-warning" role="alert">{error}</p>}
    </fieldset>
  </article>;
}
