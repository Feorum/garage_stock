import { useEffect, useRef, useState } from 'preact/hooks';
import { decimal, hundredths, money } from './pay-model';
import { errorText, isConflict, read } from './owner-model';
import { workshopDay, type Client, type Navigate } from './workspace-types';
import { formatOrderDay } from './order-calendar';
import { readRpc } from './workspace-rpc';
import { OrderSectionBar, PhotoShortcut, type OrderSection } from './order-section-bar';
import { OwnerOrderNote } from './owner-order-note';
import { OrderPhotos } from './order-photos';
import './owner-detail.css';
import type { CustomOrderSummary as Summary } from './dashboard-model';

type Item = { name: string; kopeks: number };
type CustomOrder = Summary & {
  services: string;
  customer_kopeks: number | null;
  payments: Item[];
  allocations: Item[];
  version: number;
};
type Line = { key: string; name: string; amount: string };

export function OrderType({ custom, change }: { custom: boolean; change: (custom: boolean) => void }) {
  return <label class="order-field">Тип заказа
    <select value={custom ? 'custom' : 'standard'} onChange={e => change(e.currentTarget.value === 'custom')}>
      <option value="standard">Стандарт</option><option value="custom">Кастомный</option>
    </select>
  </label>;
}

export function useCustomOrders(client: Client, refreshWith: object | null) {
  const [orders, setOrders] = useState<Summary[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const scope = new AbortController();
    readRpc<Summary[]>(client, 'garage_custom_orders', {}, scope.signal).then(rows => {
      if (!Array.isArray(rows)) throw new Error('Invalid custom order list');
      if (!scope.signal.aborted) { setOrders(rows); setError(false); }
    }).catch(() => {
      if (!scope.signal.aborted) { setOrders(null); setError(true); }
    });
    return () => scope.abort();
  }, [client, attempt, refreshWith]);
  return { orders, error, retry: () => setAttempt(n => n + 1) };
}

export function CustomOrderError({ retry }: { retry: () => void }) {
  return <p role="alert" class="notice">Не удалось загрузить кастомные заказы.{' '}
    <button type="button" class="button" onClick={retry}>Повторить</button></p>;
}

export function CustomOrderList({ client, refreshWith, search = '', filter = 'all' }: {
  client: Client; refreshWith: object | null; search?: string; filter?: string;
}) {
  const { orders, error, retry } = useCustomOrders(client, refreshWith);
  if (error) return <CustomOrderError retry={retry} />;
  if (!orders) return null;
  const matches = orders.filter(o => (filter === 'all' || filter === o.status)
    && o.vehicle.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')));
  if (!matches.length) return null;
  return <section aria-label="Кастомные заказы">
    <h2 class="owner-history-title">Кастомные заказы</h2>
    <div class="owner-board-list">{matches.map(o => <article class="owner-board-card" key={o.id}>
      <a class="owner-board-open" href={'#orders/custom-' + o.id}>
        <h3>{o.vehicle}</h3><span class="owner-board-meta">{formatOrderDay(o.visit_date)} · {o.status === 'open' ? 'Открыт' : 'Закрыт'}</span>
      </a>
    </article>)}</div>
  </section>;
}

function lines(items: Item[]): Line[] {
  return items.map(i => ({ key: crypto.randomUUID(), name: i.name, amount: decimal(i.kopeks) }));
}
function items(rows: Line[]): Item[] | null {
  const result: Item[] = [];
  for (const row of rows) {
    const kopeks = hundredths(row.amount), name = row.name.trim();
    if (!name || kopeks === null) return null;
    result.push({ name, kopeks });
  }
  return result;
}
function AmountLines({ title, nameLabel, rows, change, addLabel }: {
  title: string; nameLabel: string; rows: Line[]; change: (rows: Line[]) => void; addLabel: string;
}) {
  const edit = (key: string, values: Partial<Line>) => change(rows.map(r => r.key === key ? { ...r, ...values } : r));
  return <fieldset><legend>{title}</legend>
    {rows.map((r, i) => <div class="form-grid" key={r.key}>
      <label>{nameLabel} {i + 1}<input value={r.name} required maxLength={240}
        onInput={e => edit(r.key, { name: e.currentTarget.value })} /></label>
      <label>Сумма, BYN<input inputMode="decimal" value={r.amount} required
        onInput={e => edit(r.key, { amount: e.currentTarget.value })} /></label>
      <button class="button" type="button" aria-label={'Убрать строку ' + (i + 1) + ' · ' + title}
        onClick={() => change(rows.filter(row => row.key !== r.key))}>Убрать</button>
    </div>)}
    <button class="button" type="button" onClick={() => change([...rows, { key: crypto.randomUUID(), name: '', amount: '' }])}>{addLabel}</button>
  </fieldset>;
}

export function CustomOrderPage({ client, record, navigate }: { client: Client; record: string; navigate: Navigate }) {
  const creating = record === 'new';
  const [loaded, setLoaded] = useState<CustomOrder | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (creating) return;
    let live = true;
    read<CustomOrder>(client, 'garage_custom_orders', { p_order_id: record })
      .then(row => { if (live) { setLoaded(row); setError(''); } })
      .catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [client, record, creating, attempt]);
  if (!creating && !loaded) return <div><a href="#orders">К списку заказов</a>
    {error ? <p role="alert">{error} <button type="button" class="button" onClick={() => setAttempt(n => n + 1)}>Повторить</button></p>
      : <p role="status">Загрузка заказа…</p>}</div>;
  return <CustomOrderEditor client={client} seed={loaded} navigate={navigate} />;
}

function CustomOrderEditor({ client, seed, navigate }: { client: Client; seed: CustomOrder | null; navigate: Navigate }) {
  const [vehicle, setVehicle] = useState(seed?.vehicle ?? '');
  const [visitDate, setDate] = useState(seed?.visit_date ?? workshopDay());
  const [services, setServices] = useState(seed?.services ?? '');
  const [status, setStatus] = useState<Summary['status']>(seed?.status ?? 'open');
  const [customer, setCustomer] = useState(seed?.customer_kopeks == null ? '' : decimal(seed.customer_kopeks));
  const [payments, setPayments] = useState<Line[]>(() => lines(seed?.payments ?? []));
  const [allocations, setAllocations] = useState<Line[]>(() => lines(seed?.allocations ?? []));
  const [savedOrder, setSavedOrder] = useState(seed);
  const [section, setSection] = useState<OrderSection>(seed ? 'overview' : 'create');
  const [photosVisited, setPhotosVisited] = useState(false);
  const photoPanel = useRef<HTMLDivElement>(null);
  function choose(next: OrderSection) {
    if (next === 'photos') setPhotosVisited(true);
    setSection(next);
  }
  const editSection = seed ? 'edit' : 'create';
  const version = savedOrder?.version ?? 0;
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef(true), lock = useRef(false);
  const request = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const price = customer.trim() ? hundredths(customer) : null;
  const pay = items(payments), expenses = items(allocations);
  const balance = price !== null && pay && expenses
    ? price - [...pay, ...expenses].reduce((sum, row) => sum + row.kopeks, 0) : null;
  const draft = { vehicle: vehicle.trim(), visit_date: visitDate, services, status, customer_kopeks: price, payments: pay, allocations: expenses };
  const dirty = !savedOrder || vehicle.trim() !== savedOrder.vehicle || visitDate !== savedOrder.visit_date ||
    services !== savedOrder.services || status !== savedOrder.status || price !== savedOrder.customer_kopeks ||
    (customer.trim() !== '' && price === null) ||
    JSON.stringify(pay) !== JSON.stringify(savedOrder.payments.map(({name, kopeks}) => ({name, kopeks}))) ||
    JSON.stringify(expenses) !== JSON.stringify(savedOrder.allocations.map(({name, kopeks}) => ({name, kopeks})));
  async function save(nextStatus = status) {
    if (lock.current || conflict) return;
    setFailed(true);
    if (!vehicle.trim() || !visitDate || (customer.trim() && price === null) || !pay || !expenses) {
      if (!vehicle.trim() || !visitDate) {
        setSection(editSection);
        setMessage('Укажите автомобиль и дату заказа.');
      } else if (!pay) {
        setSection('payroll');
        setMessage('Для каждой выплаты укажите исполнителя и сумму с точностью до копейки.');
      } else {
        setSection('prices');
        setMessage('Проверьте сумму для клиента, названия и суммы расходов.');
      }
      return;
    }
    lock.current = true; setSaving(true); setMessage('');
    const args = { p_order_id: seed?.id ?? null, p_expected_version: version, p_order: { ...draft, status: nextStatus } };
    const payload = JSON.stringify(args);
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    try {
      const result = await read<CustomOrder>(client, 'garage_save_custom_order', { ...args, p_request_id: request.current.id });
      if (!live.current) return;
      request.current = null;
      setFailed(false); setMessage(nextStatus === status ? 'Кастомный заказ сохранён.' : 'Заказ принят и закрыт.');
      setSavedOrder(result); setStatus(result.status);
      if (!seed) navigate('orders', 'custom-' + result.id);
    } catch (e) {
      if (live.current) { setConflict(isConflict(e)); setMessage(errorText(e)); }
    } finally {
      lock.current = false;
      if (live.current) setSaving(false);
    }
  }
  return <article class="owner-order-detail order-sheet custom-order-form">
    <a class="order-back" href="#orders">К списку заказов</a>
    {seed ? <div class="order-sheet-title"><span>Кастомный заказ</span></div> :
      <OrderType custom change={() => navigate('orders', 'new')} />}
    <OrderSectionBar selected={section} change={choose}
      sections={seed ? ['overview', 'prices', 'payroll', 'edit', 'photos'] : ['create', 'prices', 'payroll']} />
    <header class="order-detail-head"><h2>{savedOrder?.vehicle || 'Новый кастомный заказ'}</h2>
      {savedOrder && <span class={'owner-board-phase phase-' + (savedOrder.status === 'closed' ? 'closed' : 'active')}>
        {savedOrder.status === 'closed' ? 'Закрыт' : 'Открыт'}
      </span>}
    </header>
    {seed && <div class="order-section-body" hidden={section !== 'overview'}>
      <dl class="order-facts"><div><dt>Дата заказа</dt><dd>{formatOrderDay(savedOrder!.visit_date)}</dd></div></dl>
      <section class="order-scope"><h3>Состав работ</h3>
        <p class="order-detail-instructions">{savedOrder?.services || 'Работы пока не указаны.'}</p>
      </section>
      <footer class="order-sheet-footer">
        {savedOrder?.status === 'open' && <div class="order-accept-row">
          <button class="button button-primary" type="button" disabled={saving || conflict || dirty} onClick={() => void save('closed')}>
            Принять и закрыть заказ
          </button>
          {dirty && <span class="field-hint">Сохраните изменения перед закрытием заказа.</span>}
        </div>}
        <OwnerOrderNote client={client} orderId={seed.id} custom />
        <div class="order-footer-actions"><PhotoShortcut open={() => {
          choose('photos');
          requestAnimationFrame(() => photoPanel.current?.focus());
        }} /></div>
      </footer>
    </div>}
    {savedOrder && photosVisited && <div class="order-section-body" hidden={section !== 'photos'} ref={photoPanel} tabIndex={-1}>
      <OrderPhotos client={client} orderId={savedOrder.id} upload={savedOrder.status === 'open'} initialLoad custom />
    </div>}
    <form class="custom-order-editor" noValidate onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset class="order-section-body" disabled={saving} hidden={section !== editSection}>
        <legend>Данные заказа</legend>
        <div class="form-grid">
          <label>Автомобиль<input required maxLength={240} value={vehicle} onInput={e => setVehicle(e.currentTarget.value)} /></label>
          <label>Дата заказа<input type="date" required value={visitDate} onInput={e => setDate(e.currentTarget.value)} /></label>
          <label>Состояние<select value={status} onChange={e => setStatus(e.currentTarget.value as Summary['status'])}>
            <option value="open">Открыт</option><option value="closed">Закрыт</option>
          </select></label>
        </div>
        <label class="order-field">Работы<textarea rows={3} maxLength={12000} value={services} onInput={e => setServices(e.currentTarget.value)} /></label>
      </fieldset>
      <fieldset disabled={saving} class="order-section-body custom-distribution" hidden={section !== 'prices'}>
        <legend>Цены и расходы</legend>
        <label class="order-field">Сумма для клиента, BYN<input inputMode="decimal" value={customer} onInput={e => setCustomer(e.currentTarget.value)} /></label>
        <AmountLines title="Расходы и прочее распределение" nameLabel="Назначение (например, плёнка)" addLabel="Добавить расход или распределение" rows={allocations} change={setAllocations} />
        {balance !== null && <p>Свободный остаток <strong>{money(balance)}</strong></p>}
      </fieldset>
      <fieldset disabled={saving} class="order-section-body custom-distribution" hidden={section !== 'payroll'}>
        <legend>Оплата механиков</legend>
        <AmountLines title="Выплаты исполнителям" nameLabel="Имя исполнителя" addLabel="Добавить исполнителя" rows={payments} change={setPayments} />
      </fieldset>
      {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
      {conflict && <button class="button" type="button" onClick={() => window.location.reload()}>Загрузить сохранённую версию</button>}
      {(section !== 'overview' && section !== 'photos' || dirty) && <button type="submit" class="button button-primary" disabled={saving || conflict}>
        {saving ? 'Сохранение…' : 'Сохранить заказ'}
      </button>}
    </form>
  </article>;
}
