import { useEffect, useState } from 'preact/hooks';
import { workshopDay, type Client, type Navigate } from './workspace-types';
import { readRpc } from './workspace-rpc';

interface Person {
  mechanic_id: string;
  name: string;
  status: string;
}
interface Task {
  id: string;
  work_name: string;
  status: string;
  completed_at?: string;
  working_mechanic_id?: string;
  working_name?: string;
  participants?: Person[];
}
interface Order {
  id: string;
  order_number: string;
  vehicle: string;
  status: string;
  tasks: Task[];
}
function contributors(task: Task): Person[] {
  if (task.participants?.length) return task.participants;
  return task.working_mechanic_id
    ? [{ mechanic_id: task.working_mechanic_id, name: task.working_name || 'Механик', status: 'confirmed' }]
    : [];
}
export function Reports({ client, navigate }: { client: Client; navigate: Navigate }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [worker, setWorker] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const scope = new AbortController();
    setStatus('loading');
    readRpc<Order[]>(client, 'garage_list_orders', {}, scope.signal)
      .then((data) => {
        if (scope.signal.aborted) return;
        setOrders(data);
        setStatus('ready');
      })
      .catch(() => {
        if (!scope.signal.aborted) setStatus('error');
      });
    return () => scope.abort();
  }, [client, refresh]);
  const all = (orders ?? []).flatMap((order) => order.tasks.map((task) => ({ order, task })));
  const staff = new Map(
    all.flatMap(({ task }) => contributors(task).map((p) => [p.mechanic_id, p.name] as const)),
  );
  const valid = !start || !end || start <= end;
  const inScope = all.filter(
    ({ task }) => !worker || contributors(task).some((p) => p.mechanic_id === worker),
  );
  const results = inScope
    .filter(({ task }) => {
      if (!valid || task.status !== 'completed' || !task.completed_at) return false;
      const day = workshopDay(task.completed_at);
      return day && (!start || start <= day) && (!end || day <= end);
    })
    .sort((a, b) => Date.parse(b.task.completed_at!) - Date.parse(a.task.completed_at!));
  const counts = new Map<string, number>();
  for (const { task } of results)
    for (const p of contributors(task)) counts.set(p.mechanic_id, (counts.get(p.mechanic_id) || 0) + 1);
  const backlogged = inScope.filter(
    ({ order, task }) => order.status === 'published' && !['completed', 'cancelled'].includes(task.status),
  );
  return (
    <section class="reports-workspace">
      <div class="order-toolbar">
        <button class="button" onClick={() => setRefresh((v) => v + 1)}>
          Обновить отчёт
        </button>
      </div>
      <div class="form-grid">
        <label>
          С даты
          <input type="date" value={start} onInput={(e) => setStart(e.currentTarget.value)} />
        </label>
        <label>
          По дату
          <input type="date" value={end} onInput={(e) => setEnd(e.currentTarget.value)} />
        </label>
        <label>
          Механик
          <select value={worker} onChange={(e) => setWorker(e.currentTarget.value)}>
            <option value="">Вся команда</option>
            {[...staff]
              .sort((a, b) => a[1].localeCompare(b[1], 'ru'))
              .map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p class="field-hint">Даты выполнения по времени мастерской · Минск.</p>
      {!valid && <p role="alert">Дата начала должна быть раньше даты окончания или совпадать с ней.</p>}
      {status === 'loading' && <p role="status">Загружаем результаты…</p>}
      {status === 'error' && (
        <p role="alert">
          Не удалось обновить отчёт. {orders && 'Показаны последние загруженные данные. '}
          Проверьте подключение и повторите попытку.
        </p>
      )}
      {orders && valid && (
        <>
          <section class="operational-report">
            <h2>Выполненные работы</h2>
            <p>
              <strong>{results.length}</strong> за выбранный период
            </p>
            {[...counts]
              .filter(([id]) => !worker || worker === id)
              .map(([id, n]) => (
                <p key={id}>
                  {staff.get(id)} · участий: {n}
                </p>
              ))}
          </section>
          <div class="order-list">
            {results.length === 0 && <p>За выбранный период завершённых работ нет.</p>}
            {results.map(({ order, task }) => (
              <article key={task.id} class="order-card">
                <strong>
                  {order.vehicle} · {task.work_name}
                </strong>
                <p>
                  {new Date(task.completed_at!).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })} ·{' '}
                  {contributors(task)
                    .map((p) => p.name)
                    .join(', ')}
                </p>
                <button class="button button-small" onClick={() => navigate('orders', order.id)}>
                  Открыть {order.order_number}
                </button>
              </article>
            ))}
          </div>
        </>
      )}
      {orders && (
        <section class="operational-report">
          <h2>Сейчас в работе</h2>
          <p>
            Незавершённых работ: {backlogged.length} · с приостановкой:{' '}
            {
              backlogged.filter(
                ({ task }) => task.status === 'blocked' || contributors(task).some((p) => p.status === 'blocked'),
              ).length
            }
          </p>
        </section>
      )}
    </section>
  );
}
