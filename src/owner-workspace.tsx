import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { OwnerOrders } from './owner-orders';
import { ReviewCard, type ReviewRate } from './owner-review';
import { orderAuthor, orderPhase, type OwnerOrder } from './owner-model';
import { Reports } from './reports';
import { ShiftView } from './shift';
import { participants, taskName, type Task } from './shift-model';
import { ExecutorMarker } from './executor-marker';
import { subscribeBoardUpdates } from './board-updates';
import { readRpc } from './workspace-rpc';
import { workshopDay, type Client, type Navigate, type Profile } from './workspace-types';
import { compareOrderDays, formatOrderDay, newestFirst, orderDay, weekdayClass, workshopOrderDay } from './order-calendar';
import './owner-workspace.css';
import { CustomOrderError, CustomOrderPage, useCustomOrders } from './owner-custom-orders';
import { dashboardOrders } from './dashboard-model';
import { DashboardHome } from './dashboard-home';
import { isOwnerOrderDetail } from './navigation.js';
import { DashboardOrderList } from './dashboard-order-list';

interface Props {
  client: Client;
  profile: Profile;
  section: string;
  recordId?: string;
  backgroundSection?: string;
  navigate: Navigate;
}
interface PriceRow {
  order_id: string;
  created_at: string;
  closed_at: string | null;
  tasks: ReviewRate[];
}
type Prices = Map<string, PriceRow>;
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

function OrderViews({ client, orders, prices, home }: {
  client: Client; orders: OwnerOrder[] | null; prices: Prices | null; home: boolean;
}) {
  const custom = useCustomOrders(client, orders);
  const rows = useMemo(() => dashboardOrders(orders || [], custom.orders || [], prices), [orders, custom.orders, prices]);
  return <>
    {custom.error && <CustomOrderError retry={custom.retry} />}
    {orders || custom.orders?.length
      ? home ? <DashboardHome orders={rows} /> : <DashboardOrderList orders={rows} />
      : !home && <a class="button button-primary" href="#orders/new">Новый заказ</a>}
  </>;
}

function Board({ client, profile, section, drawerOpen }: Props & { drawerOpen: boolean }) {
  const [orders, setOrders] = useState<OwnerOrder[] | null>(null);
  const [pricing, setPricing] = useState<{ key: string; rates: Prices | null } | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [month, setMonth] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [feedback, setFeedback] = useState('');
  const wasDrawerOpen = useRef(drawerOpen);
  useEffect(() => {
    if (wasDrawerOpen.current && !drawerOpen) setRevision(current => current + 1);
    wasDrawerOpen.current = drawerOpen;
  }, [drawerOpen]);
  function refreshReview(message?: string) {
    if (message) setFeedback(message);
    setRevision(n => n + 1);
  }
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let again = false;
    const scope = new AbortController();
    async function refresh() {
      if (pending) { again = true; return; }
      pending = true;
      try {
        const result = await readRpc<OwnerOrder[]>(client, 'garage_list_orders', {}, scope.signal);
        if (disposed) return;
        if (!Array.isArray(result)) throw new Error('Invalid order list');
        setOrders(result);
        setError('');
      } catch (failure) {
        if (disposed) return;
        const code = (failure as { code?: string })?.code || '';
        if (code === '42501' || code.startsWith('PGRST30')) {
          setOrders(null);
          setPricing(null);
        }
        setError('Не удалось загрузить заказы.');
      } finally {
        pending = false;
      }
      if (again) { again = false; void refresh(); }
    }
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const connection = () => { setOnline(navigator.onLine); if (navigator.onLine) visible(); };
    void refresh();
    const unsubscribe = subscribeBoardUpdates(client, profile.id, visible);
    const timer = window.setInterval(visible, 30000);
    window.addEventListener('online', connection);
    window.addEventListener('offline', connection);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      scope.abort();
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('online', connection);
      window.removeEventListener('offline', connection);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client, profile.id, revision]);

  const all = orders || [];
  const closedDay = (order: OwnerOrder) => workshopOrderDay(order.closed_at);
  const scheduled = [...all].sort((a, b) =>
    compareOrderDays(orderDay(a), orderDay(b)) || a.order_number.localeCompare(b.order_number, 'ru', { numeric: true }) || a.id.localeCompare(b.id));
  const closed = all.filter(o => o.status === 'closed').sort((a, b) =>
    newestFirst(a.closed_at, b.closed_at) || a.id.localeCompare(b.id));
  const todayMonth = workshopDay().slice(0, 7);
  const months = [...new Set([todayMonth, ...closed.map(o => closedDay(o).slice(0, 7)).filter(Boolean)])].sort().reverse();
  const selected = months.includes(month) ? month : todayMonth;
  const monthly = closed.filter(o => closedDay(o).slice(0, 7) === selected);
  const monthLabel = (value: string) => {
    const label = monthFormat.format(new Date(value + '-15T12:00:00Z')).replace(/\s*г\.$/u, '');
    return label.charAt(0).toLocaleUpperCase('ru') + label.slice(1);
  };
  const queue = section === 'shift' ? scheduled.filter(o => o.status === 'published' && o.vehicle_workflow?.state === 'review') : closed;
  // Review uses the current customer overrides. The journal and monthly report
  // use the catalogue amounts captured on the individual work items.
  const reviewSnapshot = section === 'shift' ? orders : null;
  const journal = section === 'orders' || section === 'home';
  const pricedOrders = journal ? all.filter(order => order.status !== 'cancelled')
    : section === 'reports' ? monthly : queue;
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
  }, [client, pricingKey, revision, reviewSnapshot]);
  const priceError = pricing?.key === pricingKey && !pricing.rates;
  const prices = pricing?.key === pricingKey ? pricing.rates : null;
  const totalFor = (list: OwnerOrder[]): Total => priceError ? 'unavailable' : catalogueTotal(list, prices);
  const review = section === 'shift';

  return <div class="owner-board">
    <div class="owner-board-heading">
      <h1 data-route-heading tabIndex={-1}>{section === 'home' ? 'Главная' : review ? 'На проверке'
        : section === 'orders' ? 'Все заказы' : 'Отчёты и история'}</h1>
    </div>
    {feedback && <p role="status" class="owner-review-feedback">{feedback}</p>}
    {(error || priceError) && <p role="alert" class="notice">{error || 'Не удалось загрузить цены работ.'}{' '}
      <button class="button" type="button" onClick={() => setRevision(n => n + 1)}>Повторить</button></p>}
    {!orders && !error && <p role="status">Загружаем заказы…</p>}
    {journal && <OrderViews client={client} orders={orders} prices={prices} home={section === 'home'} />}
    {orders && !journal && <>
      {section === 'reports' && <>
        <section class="owner-board-card owner-month" aria-label="Итог за месяц">
          {months.length > 1 ? <select aria-label="Месяц отчёта" value={selected} onChange={e => setMonth(e.currentTarget.value)}>
            {months.map(key => <option key={key} value={key}>{monthLabel(key)}</option>)}</select> : <h2>{monthLabel(selected)}</h2>}
          <div class="owner-month-count">Закрыто заказов <b>{monthly.length}</b></div>
          <BoardPrice total={totalFor(monthly)} />
        </section>
        <h2 class="owner-history-title">История заказов</h2>
      </>}
      {queue.length ? <div class="owner-board-list">{queue.map(order => review
          ? <ReviewCard key={order.id} order={order} rates={prices?.get(order.id)?.tasks} loadingPrices={!priceError && !prices}
              client={client} current={!error && online} refresh={refreshReview} />
          : <HistoryCard key={order.id} order={order} day={closedDay(order)} />)}</div>
        : <p class="owner-board-empty">{review ? 'Нет заказов на проверке.' : 'Закрытых заказов пока нет.'}</p>}
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

export function OwnerWorkspace(props: Props) {
  const { section, recordId, profile, navigate, client, backgroundSection } = props;
  const drawer = isOwnerOrderDetail(section, recordId);
  const behind = useRef<HTMLDivElement>(null);
  if (profile.role !== 'admin') return null;
  if (!recordId || drawer) {
    const boardSection = drawer ? backgroundSection ?? 'orders' : section;
    return <>
      <div ref={behind}>
        <Board key={profile.id + '/' + boardSection} {...props} section={boardSection} recordId={undefined} drawerOpen={drawer} />
      </div>
      {drawer && recordId && <OrderDrawer behind={behind} dismiss={() => navigate(boardSection)}>
        {recordId.startsWith('custom-')
          ? <CustomOrderPage key={recordId} client={client} record={recordId.slice(7)} navigate={navigate} close={() => navigate(boardSection)} />
          : <OwnerOrders {...props} standalone closeDetail={() => navigate(boardSection)} />}
      </OrderDrawer>}
    </>;
  }
  let title;
  let view;
  if (section === 'orders') {
    title = recordId === 'tools' ? 'Управление заказами' : 'Заказ';
    view = recordId === 'custom-new'
      ? <CustomOrderPage key={recordId} client={client} record="new" navigate={navigate} />
      : <OwnerOrders {...props} recordId={recordId === 'tools' ? undefined : recordId} />;
  } else if (section === 'reports') {
    title = 'Отчёт по работам';
    view = <Reports client={client} navigate={navigate} />;
  } else {
    title = 'Смена и заявки';
    view = <ShiftView {...props} section="shift" recordId={recordId === 'attention' ? undefined : recordId} />;
  }
  return <div class="owner-board-detail">
    <h1 data-route-heading tabIndex={-1}>{title}</h1>
    {view}
  </div>;
}
