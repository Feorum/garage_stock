import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { OwnerOrders } from './owner-orders';
import { ReviewCard } from './owner-review';
import { orderAuthor, orderPhase, type OwnerOrder } from './owner-model';
import { Reports } from './reports';
import { participants, taskName, type Task } from './shift-model';
import { ExecutorMarker } from './executor-marker';
import { useDashboardRows, useOwnerData, useResource, type Prices } from './owner-data';
import { OwnerTabWidgets } from './owner-tab-widgets';
import { workshopDay, type Client, type Navigate, type Profile } from './workspace-types';
import { compareOrderDays, formatOrderDay, newestFirst, orderDay, weekdayClass, workshopOrderDay } from './order-calendar';
import './owner-workspace.css';
import { CustomOrderError, CustomOrderPage } from './owner-custom-orders';
import { lastDayOfWeek, parseDashboardScope } from './dashboard-model';
import { ManagerIntakes } from './owner-intakes';
import { DashboardHome } from './dashboard-home';
import { DashboardOrderList } from './dashboard-order-list';

interface Props {
  client: Client;
  profile: Profile;
  section: string;
  recordId?: string;
  query?: string;
  viewId?: string;
  title?: string;
  navigate: Navigate;
}
type Total = number | 'missing' | 'unavailable' | 'loading';

const monthFormat = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'Europe/Minsk' });
const numberFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function catalogueTotal(orders: OwnerOrder[], prices: Prices | null): Total {
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
    <span><strong>По прайсу</strong></span>
    {typeof total === 'number'
      ? <b>{numberFormat.format(total / 100)} <small>BYN</small></b>
      : <span class="unpriced">{total === 'missing' ? 'Ставка не указана' : total === 'loading' ? 'Загрузка…' : 'Стоимость недоступна'}</span>}
  </div>;
}

function closedDay(order: OwnerOrder) { return workshopOrderDay(order.closed_at); }

function MonthlyReport({ closed, prices, priceError, title, metric }: {
  closed: OwnerOrder[]; prices: Prices | null; priceError: boolean; title: string; metric: 'both' | 'count' | 'amount';
}) {
  const [month, setMonth] = useState('');
  const todayMonth = workshopDay().slice(0, 7);
  const months = [...new Set([todayMonth, ...closed.map(o => closedDay(o).slice(0, 7)).filter(Boolean)])].sort().reverse();
  const selected = months.includes(month) ? month : todayMonth;
  const monthly = closed.filter(o => closedDay(o).slice(0, 7) === selected);
  const monthLabel = (value: string) => {
    const label = monthFormat.format(new Date(value + '-15T12:00:00Z')).replace(/\s*г\.$/u, '');
    return label.charAt(0).toLocaleUpperCase('ru') + label.slice(1);
  };
  return <section class="owner-board-card owner-month" aria-label={title}>
    <h2>{title}</h2>
    {months.length > 1 ? <select aria-label="Месяц отчёта" value={selected} onChange={e => setMonth(e.currentTarget.value)}>
      {months.map(key => <option key={key} value={key}>{monthLabel(key)}</option>)}</select> : <span>{monthLabel(selected)}</span>}
    {metric !== 'amount' && <div class="owner-month-count">Закрыто заказов <b>{monthly.length}</b></div>}
    {metric !== 'count' && <BoardPrice total={priceError ? 'unavailable' : catalogueTotal(monthly, prices)} />}
  </section>;
}

function ServiceCredits({ tasks }: { tasks: Task[] }) {
  const services = tasks.filter(task => task.status === 'completed').sort((a, b) => newestFirst(a.completed_at, b.completed_at));
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

function HistoryCard({ order, day }: { order: OwnerOrder; day: string }) {
  const state = orderPhase(order);
  return <article class={'owner-board-card ' + weekdayClass(day)} data-order-id={order.id}>
    <a class="owner-board-open" href={'#orders/' + encodeURIComponent(order.id)}>
      <h2>{order.vehicle}</h2>
      <span class="owner-board-meta">
        {order.colour && <>{order.colour} · </>}
        {day && 'Закрыт '}
        {day ? <time dateTime={day}>{formatOrderDay(day)}</time> : 'Дата закрытия не указана'}
        {' · '}{orderAuthor(order)} · Стандарт
      </span>
      <span class={'owner-board-phase phase-' + state.tone}>{state.label}</span>
    </a>
    <ServiceCredits tasks={order.tasks} />
  </article>;
}

export function TabWidgets({ tab }: { tab: string }) {
  const orders = useDashboardRows();
  return <OwnerTabWidgets key={tab} tab={tab} orders={orders} />;
}

function Board({ client, section, query = '', viewId, title }: Props) {
  const store = useOwnerData();
  const { data: orders, failed: error } = useResource(store.orders);
  const { data: intakes, failed: intakeError } = useResource(store.intakes);
  const { data: prices, failed: priceError } = useResource(store.prices);
  const custom = useResource(store.custom);
  const rows = useDashboardRows();
  const [online, setOnline] = useState(navigator.onLine);
  const [feedback, setFeedback] = useState('');
  const { week, day, metric } = parseDashboardScope(query);
  const review = section === 'shift';
  const scoped = Boolean(week || day || metric !== 'orders');
  const showIntakes = (review && !week) || (section === 'orders' && !viewId && !scoped);
  useEffect(() => {
    const connection = () => setOnline(navigator.onLine);
    window.addEventListener('online', connection);
    window.addEventListener('offline', connection);
    return () => { window.removeEventListener('online', connection); window.removeEventListener('offline', connection); };
  }, []);
  function refreshReview(message?: string) {
    if (message) setFeedback(message);
    void store.refreshBoard();
  }
  const all = orders || [];
  const scheduled = [...all].sort((a, b) =>
    compareOrderDays(orderDay(a), orderDay(b)) || a.order_number.localeCompare(b.order_number, 'ru', { numeric: true }) || a.id.localeCompare(b.id));
  const closed = all.filter(o => o.status === 'closed').sort((a, b) =>
    newestFirst(a.closed_at, b.closed_at) || a.id.localeCompare(b.id));
  const weekEnd = week && lastDayOfWeek(week);
  const queue = review ? scheduled.filter(order => {
    if (order.status !== 'published' || order.vehicle_workflow?.state !== 'review') return false;
    if (!week) return true;
    const date = orderDay(order);
    return date >= week && date <= weekEnd;
  }) : closed;
  const journal = section === 'orders' || section === 'home';
  const intakeList = showIntakes && <ManagerIntakes intakes={intakes} failed={intakeError}
    retry={refreshReview} attention={review} />;

  return <div class="owner-board">
    <div class="owner-board-heading">
      <h1 data-route-heading tabIndex={-1}>{section === 'home' ? 'Главная' : review ? 'На проверке'
        : section === 'orders' ? title || 'Все заказы' : 'Отчёты и история'}</h1>
    </div>
    {feedback && <p role="status" class="owner-review-feedback">{feedback}</p>}
    {(error || priceError) && <p role="alert" class="notice">{error ? 'Не удалось загрузить заказы.' : 'Не удалось загрузить цены работ.'}{' '}
      <button class="button" type="button" onClick={() => refreshReview()}>Повторить</button></p>}
    {!orders && !error && <p role="status">Загружаем заказы…</p>}
    {section !== 'home' && !(section === 'orders' && scoped) && <OwnerTabWidgets key={viewId || section} tab={viewId ? 'view-' + viewId : section} orders={rows}
      renderMonthly={section === 'reports' ? opts => orders && <MonthlyReport {...opts} closed={closed}
        prices={prices} priceError={priceError} /> : undefined} />}
    {journal && <>
      {intakeList}
      {custom.failed && <CustomOrderError retry={refreshReview} />}
      {(orders || custom.data?.length) ? (section === 'home' ? <DashboardHome orders={rows} query={query} />
        : <DashboardOrderList orders={rows} query={query} />)
        : section === 'orders' && <a class="button button-primary" href="#orders/new">Новый заказ</a>}
    </>}
    {review && <section class="owner-attention" aria-labelledby="owner-attention-heading">
      <header class="owner-attention-heading">
        <h2 id="owner-attention-heading">Требует внимания</h2>
        <div class="owner-attention-period">{week ? <>
          <span><time dateTime={week}>{formatOrderDay(week)}</time> — <time dateTime={weekEnd}>{formatOrderDay(weekEnd)}</time></span>
          <a href="#shift">За все даты</a>
        </> : <span>За все даты</span>}</div>
      </header>
      <section class="owner-attention-group" aria-labelledby="owner-transfers-heading">
        <h3 id="owner-transfers-heading">Передачи механиков</h3>
        {orders && (queue.length ? <div class="owner-board-list">{queue.map(order =>
          <ReviewCard key={order.id} order={order} rates={prices?.get(order.id)?.tasks} loadingPrices={!priceError && !prices}
            client={client} current={!error && online} refresh={refreshReview} />)}</div>
          : <p class="owner-board-empty">Нет заказов на проверке.</p>)}
      </section>
      {intakeList}
    </section>}
    {orders && section === 'reports' && <>
      <h2 class="owner-history-title">История заказов</h2>
      {closed.length ? <div class="owner-board-list">{closed.map(order =>
        <HistoryCard key={order.id} order={order} day={closedDay(order)} />)}</div>
        : <p class="owner-board-empty">Закрытых заказов пока нет.</p>}
    </>}
    {section === 'reports' && <nav class="owner-board-tools" aria-label="Инструменты отчётов">
      <a href="#reports/activity">Отчёт по работам</a><a href="#pay">Распределение оплаты</a>
      <a href="#ledger">Учёт бизнеса</a><a href="#sheets">Подключения таблиц</a>
    </nav>}
  </div>;
}

function OrderDrawer({ children, dismiss, behind }: {
  children: ComponentChildren; dismiss: () => void; behind: RefObject<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = behind.current;
    dialog.showModal();
    if (background) {
      background.inert = true;
      background.setAttribute('aria-hidden', 'true');
    }
    return () => {
      if (background) {
        background.inert = false;
        background.removeAttribute('aria-hidden');
      }
      dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return <dialog class="owner-order-drawer" ref={ref} aria-label="Карточка заказа"
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClick={event => { if (event.target === event.currentTarget) dismiss(); }}>
    <div class="owner-drawer-sheet">
      <div class="owner-drawer-caption">
        <span>Карточка заказа</span>
        <button type="button" class="owner-drawer-close" aria-label="Закрыть карточку заказа" onClick={dismiss}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      {children}
    </div>
  </dialog>;
}

export function OwnerOrderDialog({ client, profile, navigate, recordId, directReview, dismiss, behind, returnHash }: {
  client: Client; profile: Profile; navigate: Navigate; recordId: string; directReview: boolean;
  dismiss(): void; behind: RefObject<HTMLDivElement>; returnHash: string;
}) {
  return <OrderDrawer behind={behind} dismiss={dismiss}>
    {recordId.startsWith('custom-')
      ? <CustomOrderPage key={recordId} client={client} record={recordId.slice(7)} navigate={navigate} close={dismiss} returnHash={returnHash} />
      : <OwnerOrders client={client} profile={profile} navigate={navigate} recordId={recordId}
          directReview={directReview} closeDetail={dismiss} />}
  </OrderDrawer>;
}

export function OwnerWorkspace(props: Props) {
  const { section, recordId, profile, navigate, client } = props;
  if (profile.role !== 'admin') return null;
  if (!recordId) return <Board key={section} {...props} />;
  let title;
  let view;
  if (section === 'orders') {
    title = 'Новый заказ';
    view = recordId === 'custom-new'
      ? <CustomOrderPage key={recordId} client={client} record="new" navigate={navigate} />
      : <OwnerOrders {...props} recordId={recordId} />;
  } else {
    title = 'Отчёт по работам';
    view = <Reports navigate={navigate} />;
  }
  return <div class="owner-board-detail">
    <h1 data-route-heading tabIndex={-1}>{title}</h1>
    {view}
  </div>;
}
