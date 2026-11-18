import { useEffect, useState } from 'preact/hooks';
import { OwnerOrders } from './owner-orders';
import type { OwnerOrder } from './owner-model';
import { Reports } from './reports';
import { ShiftView } from './shift';
import { participants, taskName, type Task } from './shift-model';
import { ExecutorMarker } from './executor-marker';
import { subscribeBoardUpdates } from './board-updates';
import { readRpc } from './workspace-rpc';
import { workshopDay, type Client, type Navigate, type Profile } from './workspace-types';
import './owner-workspace.css';

interface Props {
  client: Client;
  profile: Profile;
  section: string;
  recordId?: string;
  navigate: Navigate;
}
interface BoardOrder extends OwnerOrder {
  created_at?: string;
  closed_at?: string | null;
}
interface PriceRow {
  order_id: string;
  created_at: string;
  closed_at: string | null;
  tasks: { task_id: string; net_kopeks: number | null }[];
}
type Prices = Map<string, PriceRow>;
type Total = number | 'missing' | 'unavailable' | 'loading';

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Minsk' });
const monthFormat = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'Europe/Minsk' });
const numberFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function boardDay(order: BoardOrder) {
  return order.planned_date || (order.created_at && workshopDay(order.created_at)) || '';
}

function displayDay(day: string) {
  if (!day) return '';
  const date = new Date(day + 'T12:00:00Z');
  return Number.isFinite(date.valueOf()) ? dateFormat.format(date) : '';
}

function catalogueTotal(orders: BoardOrder[], prices: Prices | null): Total {
  if (!prices) return 'loading';
  let total = 0;
  for (const order of orders) {
    const row = prices.get(order.id);
    if (!row) return 'unavailable';
    const rates = new Map(row.tasks.map(t => [t.task_id, t.net_kopeks]));
    for (const task of order.tasks) {
      if (task.status === 'cancelled') continue;
      const amount = rates.get(task.id);
      if (amount === null) return 'missing';
      if (amount === undefined || !Number.isSafeInteger(amount)) return 'unavailable';
      total += amount;
    }
  }
  return Number.isSafeInteger(total) ? total : 'unavailable';
}

function BoardPrice({ total }: { total: Total }) {
  return <div class="owner-board-price">
    <span><strong>По прайсу</strong><small>Без НДС</small></span>
    {typeof total === 'number'
      ? <b>{numberFormat.format(total / 100)} <small>BYN</small></b>
      : <span class="unpriced">{total === 'missing' ? 'Ставка не указана' : total === 'loading' ? 'Загрузка…' : 'Стоимость недоступна'}</span>}
  </div>;
}

function completedReview(order: BoardOrder) {
  const flow = order.vehicle_workflow;
  return order.status === 'published' && flow?.state === 'review' &&
    flow.completed_count > 0 && flow.unfinished_count === 0;
}

function orderState(order: BoardOrder) {
  if (order.status === 'closed') return { label: 'Закрыт', tone: 'closed' };
  if (order.status === 'cancelled') return { label: 'Отменён', tone: 'closed' };
  if (order.vehicle_workflow?.state === 'review') {
    const left = order.vehicle_workflow.unfinished_count;
    return completedReview(order) ? { label: 'На проверке', tone: 'review' } :
      { label: left > 0 ? `На проверке · осталось ${left}` : 'На проверке', tone: 'partial' };
  }
  if (order.vehicle_workflow?.state === 'active') return { label: 'В работе', tone: 'active' };
  return { label: 'Ожидает начала', tone: 'pending' };
}

function ServiceCredits({ tasks }: { tasks: Task[] }) {
  const services = tasks.filter(task => task.status === 'completed');
  if (!services.length) return null;
  return <ul class="owner-board-services">{services.map(task => {
    const people = participants(task).filter(person => person.status === 'confirmed');
    return <li key={task.id}>
      <span>{taskName(task)}</span>
      {people.length > 0 && <span class="owner-board-markers">{people.map(person =>
        <ExecutorMarker key={person.mechanic_id} id={person.mechanic_id} name={person.name || 'Механик'} color={person.color} />
      )}</span>}
    </li>;
  })}</ul>;
}

function OrderCard({ order, mode, price, repeated }: {
  order: BoardOrder; mode: 'review' | 'orders' | 'history'; price?: Total; repeated: boolean;
}) {
  const source = order.source === 'manager' ? 'Заказ менеджера' : 'Заказ владельца';
  const state = orderState(order);
  const meta = [displayDay(boardDay(order)), source, repeated && order.order_number].filter(Boolean).join(' · ');
  return <article class="owner-board-card" data-order-id={order.id}>
    <a class="owner-board-open" href={'#orders/' + encodeURIComponent(order.id)}
      aria-label={`${order.vehicle} · ${order.order_number} · ${state.label}`}>
      <h2>{order.vehicle}</h2>
      <span class="owner-board-meta">{meta}</span>
      {mode === 'review' ? <span class="owner-board-chevron" aria-hidden="true">›</span> :
        <span class={'owner-board-phase phase-' + state.tone}>{state.label}</span>}
    </a>
    {mode !== 'orders' && <ServiceCredits tasks={order.tasks} />}
    {price !== undefined && <BoardPrice total={price} />}
  </article>;
}

function Board({ client, profile, section }: Props) {
  const [orders, setOrders] = useState<BoardOrder[] | null>(null);
  const [pricing, setPricing] = useState<{ key: string; rates: Prices | null } | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [month, setMonth] = useState('');
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let again = false;
    const scope = new AbortController();
    async function refresh() {
      if (pending) { again = true; return; }
      pending = true;
      try {
        const result = await readRpc<BoardOrder[]>(client, 'garage_list_orders', {}, scope.signal);
        if (disposed) return;
        if (!Array.isArray(result)) throw new Error('Invalid order list');
        setOrders(result);
        setError('');
      } catch {
        if (disposed) return;
        setOrders(null);
        setError('Не удалось загрузить заказы.');
      } finally {
        pending = false;
      }
      if (again) { again = false; void refresh(); }
    }
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    const unsubscribe = subscribeBoardUpdates(client, profile.id, visible);
    const timer = window.setInterval(visible, 30000);
    window.addEventListener('online', visible);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      scope.abort();
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('online', visible);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client, profile.id, revision]);

  const all = orders || [];
  const closedDay = (order: BoardOrder) => {
    const timestamp = order.closed_at;
    return timestamp ? workshopDay(timestamp) : '';
  };
  const closed = all.filter(o => o.status === 'closed').sort((a, b) => closedDay(b).localeCompare(closedDay(a)) || a.id.localeCompare(b.id));
  const todayMonth = workshopDay().slice(0, 7);
  const months = [...new Set([todayMonth, ...closed.map(o => closedDay(o).slice(0, 7)).filter(Boolean)])].sort().reverse();
  const selected = months.includes(month) ? month : todayMonth;
  const monthly = closed.filter(o => closedDay(o).slice(0, 7) === selected);
  const monthLabel = (value: string) => {
    const label = monthFormat.format(new Date(value + '-15T12:00:00Z')).replace(/\s*г\.$/u, '');
    return label.charAt(0).toLocaleUpperCase('ru') + label.slice(1);
  };
  const queue = section === 'shift' ? all.filter(completedReview).sort((a, b) =>
    (a.vehicle_workflow?.handed_at || '').localeCompare(b.vehicle_workflow?.handed_at || '') || a.id.localeCompare(b.id)) :
    section === 'reports' ? closed : [...all].sort((a, b) =>
      boardDay(b).localeCompare(boardDay(a)) || (b.created_at || '').localeCompare(a.created_at || '') || a.id.localeCompare(b.id));
  // Versions and service membership identify the frozen catalogue rows that can
  // affect this view. Unrelated board invalidations need no financial request.
  const pricedOrders = section === 'shift' ? queue : section === 'reports' ? monthly : [];
  const pricingKey = JSON.stringify(pricedOrders.map(o => [o.id, o.version,
    o.tasks.filter(t => t.status !== 'cancelled').map(t => t.id).sort()]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  useEffect(() => {
    const scope = new AbortController();
    const ids = (JSON.parse(pricingKey) as [string, number, string[]][]).map(row => row[0]);
    async function loadPrices() {
      const rates: Prices = new Map();
      try {
        for (let i = 0; i < ids.length; i += 100) {
          const batch = await readRpc<PriceRow[]>(client, 'garage_owner_review_prices', {
            p_order_ids: ids.slice(i, i + 100),
          }, scope.signal);
          if (scope.signal.aborted) return;
          if (!Array.isArray(batch)) throw new Error('Invalid price list');
          for (const row of batch) rates.set(row.order_id, row);
        }
        if (!scope.signal.aborted) setPricing({ key: pricingKey, rates });
      } catch {
        if (!scope.signal.aborted) setPricing({ key: pricingKey, rates: null });
      }
    }
    void loadPrices();
    return () => scope.abort();
  }, [client, pricingKey, revision]);
  const priceError = pricing?.key === pricingKey && !pricing.rates;
  const prices = pricing?.key === pricingKey ? pricing.rates : null;
  const totalFor = (list: BoardOrder[]): Total => priceError ? 'unavailable' : catalogueTotal(list, prices);
  const cardKey = (o: BoardOrder) => [o.vehicle, boardDay(o), o.source].join('\x1f');
  const frequencies = new Map<string, number>();
  for (const order of queue) frequencies.set(cardKey(order), (frequencies.get(cardKey(order)) || 0) + 1);
  const mode = section === 'shift' ? 'review' : section === 'reports' ? 'history' : 'orders';

  return <div class="owner-board">
    <h1 data-route-heading tabIndex={-1}>{section === 'shift' ? 'На проверке' : section === 'orders' ? 'Все заказы' : 'Отчёты и история'}</h1>
    {(error || priceError) && <p role="alert" class="notice">{error || 'Не удалось загрузить ставки по прайсу.'}{' '}
      <button class="button" type="button" onClick={() => setRevision(n => n + 1)}>Повторить</button></p>}
    {!orders && !error && <p role="status">Загружаем заказы…</p>}
    {orders && <>
      {section === 'reports' && <>
        <section class="owner-board-card owner-month" aria-label="Итог за месяц">
          {months.length > 1 ? <select aria-label="Месяц отчёта" value={selected} onChange={e => setMonth(e.currentTarget.value)}>
            {months.map(key => <option key={key} value={key}>{monthLabel(key)}</option>)}</select> : <h2>{monthLabel(selected)}</h2>}
          <div class="owner-month-count">Закрыто заказов <b>{monthly.length}</b></div>
          <BoardPrice total={totalFor(monthly)} />
        </section>
        <h2 class="owner-history-title">История заказов</h2>
      </>}
      {queue.length ? <div class="owner-board-list">{queue.map(order => <OrderCard key={order.id} order={order} mode={mode}
        repeated={frequencies.get(cardKey(order))! > 1} price={mode === 'review' ? totalFor([order]) : undefined} />)}</div> :
        <p class="owner-board-empty">{mode === 'review' ? 'Нет полностью выполненных заказов, переданных на проверку.' :
          mode === 'history' ? 'Закрытых заказов пока нет.' : 'Заказов пока нет.'}</p>}
    </>}
    {section === 'orders' && <nav class="owner-board-tools" aria-label="Инструменты заказов">
      <a href="#orders/tools">Управление заказами</a><a href="#shift/attention">Смена и заявки</a>
    </nav>}
    {section === 'reports' && <nav class="owner-board-tools" aria-label="Инструменты отчётов">
      <a href="#reports/activity">Отчёт по работам</a><a href="#pay">Распределение оплаты</a>
      <a href="#ledger">Учёт бизнеса</a><a href="#sheets">Подключения таблиц</a>
    </nav>}
  </div>;
}

export function OwnerWorkspace(props: Props) {
  const { section, recordId, profile } = props;
  if (profile.role !== 'admin') return null;
  if (!recordId) return <Board key={profile.id + '/' + section} {...props} />;
  let title;
  let view;
  if (section === 'orders') {
    title = recordId === 'tools' ? 'Управление заказами' : 'Заказ';
    view = <OwnerOrders {...props} recordId={recordId === 'tools' ? undefined : recordId} />;
  } else if (section === 'reports') {
    title = 'Отчёт по работам';
    view = <Reports client={props.client} navigate={props.navigate} />;
  } else {
    title = 'Смена и заявки';
    view = <ShiftView {...props} section="shift" recordId={recordId === 'attention' ? undefined : recordId} />;
  }
  return <div class="owner-board-detail">
    <h1 data-route-heading tabIndex={-1}>{title}</h1>
    {view}
  </div>;
}
