import { useState } from 'preact/hooks';
import { matchesOrder, type DashboardOrder } from './dashboard-model';
import { formatOrderDay, weekdayClass } from './order-calendar';
import { money } from './pay-model';
import './dashboard-order-list.css';

const icons = {
  search: 'M16 16l4.5 4.5 M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  download: 'M12 3v12 M7.5 10.5L12 15l4.5-4.5 M4 16v4h16v-4',
  chevron: 'm6 9 6 6 6-6',
  sort: 'M12 4v16 M7 15l5 5 5-5',
  open: 'm9 5 7 7-7 7',
  plus: 'M12 5v14 M5 12h14',
  calendar: 'M4 6h16v15H4z M4 11h16 M8 3v6 M16 3v6',
  wrench: 'M14 5a5 5 0 0 0-6 6L3.5 16a2.4 2.4 0 0 0 3.4 3.4l5.1-5A5 5 0 0 0 19 8l-3.1 3-3-2.9 3.1-3.2Z',
  review: 'M2.5 12s3.7-6 9.5-6 9.5 6 9.5 6-3.7 6-9.5 6-9.5-6-9.5-6Z M14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  done: 'M20 12a8 8 0 1 1-4-6.9 M8.3 10.9l3.2 3.2 9-9',
  list: 'M5 5h14v15H5z M9 9h6 M9 13h6 M9 17h4',
};
function ListIcon({ name }: { name: keyof typeof icons }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

const dayFormat = new Intl.DateTimeFormat('ru-RU', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDay = (date: string) => dayFormat.format(new Date(date + 'T12:00:00Z'));
const typeName = (order: DashboardOrder) => order.isCustom ? 'Кастомный' : 'Стандарт';
const noDate = 'undated';

function filteredCsv(orders: DashboardOrder[], period: string) {
  function quote(value: string) {
    const plainText = /^\s*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value;
    return '"' + plainText.replaceAll('"', '""') + '"';
  }
  const lines = [
    ['Номер', 'Автомобиль', 'VIN', 'Тип', 'Дата', 'Состояние', 'Источник', 'Исполнители', 'Работы', 'По прайсу, BYN'],
    ...orders.map(o => [o.number, o.vehicle, o.vin, typeName(o), o.date, o.phaseLabel, o.sourceLabel,
      o.people.map(p => p.name).join(', '), o.works.map(w => w.name).join(', '),
      o.catalogueKopeks === null ? '' : (o.catalogueKopeks / 100).toFixed(2).replace('.', ',')]),
  ];
  const text = lines.map(row => row.map(quote).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'garage-orders' + (period ? '-' + period : '') + '.csv';
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}

type StatusFilter = 'all' | 'active' | 'planned' | 'working' | 'review' | 'completed' | 'closed' | 'cancelled';
const filters: Record<StatusFilter, string> = {
  all: 'Все статусы', active: 'Активные', planned: 'Запланированные', working: 'В работе',
  review: 'На проверке', completed: 'Выполненные', closed: 'Закрытые', cancelled: 'Отменённые',
};
function matchesStatus(order: DashboardOrder, status: StatusFilter) {
  switch (status) {
    case 'active': return !order.archived;
    case 'planned': return order.tone === 'pending';
    case 'working': return order.tone === 'active';
    case 'review': return order.inReview;
    case 'completed': return order.tone === 'completed';
    case 'closed': return order.status === 'closed';
    case 'cancelled': return order.status === 'cancelled';
    default: return true;
  }
}

function Summary({ orders }: { orders: DashboardOrder[] }) {
  const metrics: { label: string; icon: keyof typeof icons; count: number }[] = [
    { label: 'Всего заказов', icon: 'list', count: orders.length },
    { label: 'Активные заказы', icon: 'wrench', count: orders.filter(o => matchesStatus(o, 'active')).length },
    { label: 'На проверке', icon: 'review', count: orders.filter(o => matchesStatus(o, 'review')).length },
    { label: 'Закрытые заказы', icon: 'done', count: orders.filter(o => matchesStatus(o, 'closed')).length },
  ];
  return <dl class="od-stats" aria-label="Сводка по всем заказам">{metrics.map(m =>
    <div key={m.icon} class={'od-stat od-stat-' + m.icon}>
      <dt>{m.label}<ListIcon name={m.icon} /></dt><dd>{m.count}</dd>
    </div>)}</dl>;
}

function OrderRow({ order }: { order: DashboardOrder }) {
  const workers = order.people.map(p => p.name).join(', ');
  const subtitle = [order.colour, order.sourceLabel].filter(Boolean).join(' · ');
  const dateText = order.date ? shortDay(order.date) : 'Дата не назначена';
  const reference = order.number || typeName(order);
  return <article class={'owner-board-card od-order ' + weekdayClass(order.date)} data-order-id={order.id}>
    <a href={order.href} class="owner-board-open od-grid od-row">
      <span class="od-number" title={reference}>{reference}</span>
      <div class="od-vehicle">
        <h2 title={order.vehicle}>{order.vehicle}</h2>
        <small class="od-order-meta">{subtitle}</small>
        <small class="od-compact-meta">{reference} · {dateText}</small>
      </div>
      <span class="od-date" title={formatOrderDay(order.date) || undefined}>
        {order.date ? <time dateTime={order.date}>{order.dateKind === 'due' ? 'Срок ' : ''}{dateText}</time> : dateText}
      </span>
      <span class="od-person" title={workers || undefined}>{workers || (order.isCustom ? 'В карточке' : 'Не назначены')}</span>
      <span class={'od-phase od-phase-' + (order.status === 'cancelled' ? 'cancelled' : order.tone)}>{order.phaseLabel}</span>
      <span class={'od-price' + (order.catalogueKopeks === null ? ' od-price-empty' : '')}>
        {order.catalogueKopeks === null
          ? <span title={order.isCustom ? 'Кастомный заказ' : 'Сумма по прайсу недоступна'}>—</span>
          : money(order.catalogueKopeks)}
      </span>
      <span class="od-open-icon" title="Открыть заказ"><ListIcon name="open" /></span>
    </a>
  </article>;
}

export function DashboardOrderList({ orders }: { orders: DashboardOrder[] }) {
  const [query, setQuery] = useState('');
  const [day, setDay] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [descending, setDescending] = useState(false);
  const dates = [...new Set(orders.map(o => o.date).filter(Boolean))].sort();
  const matches = orders.filter(o => (!day || day === (o.date || noDate)) && matchesStatus(o, status) && matchesOrder(o, query));
  // The queue sorts undated orders last in both directions and keeps its original tie-breaks.
  if (descending) matches.sort((a, b) => Number(!a.date) - Number(!b.date) || b.date.localeCompare(a.date));
  const archived = matches.filter(o => !o.isCustom && o.archived);
  const current = matches.filter(o => o.isCustom || !o.archived);
  const filtered = Boolean(query.trim() || day || status !== 'all');
  const sortLabel = descending ? 'Сначала ближайшие заказы' : 'Сначала поздние заказы';
  const sortButton = (compact: boolean) => <button type="button" title={sortLabel} aria-label={sortLabel}
    onClick={() => setDescending(!descending)} class={'od-sort' + (compact ? ' od-sort-compact' : '') + (descending ? ' od-desc' : '')}>
    {!compact && 'Дата'}<ListIcon name="sort" />
  </button>;
  const reset = () => { setQuery(''); setDay(''); setStatus('all'); };
  return <>
    <Summary orders={orders} />
    <section class="owner-board od-list" aria-label="Список заказов">
      <header class="od-toolbar">
        <h2>Список заказов</h2>
        <label class="od-search"><ListIcon name="search" /><input type="search" aria-label="Поиск заказов"
          placeholder="Найти заказ" value={query} onInput={e => setQuery(e.currentTarget.value)} /></label>
        <label class="od-select"><select aria-label="Статус заказа" value={status}
          onChange={e => setStatus(e.currentTarget.value as StatusFilter)}>
          {Object.entries(filters).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select><ListIcon name="chevron" /></label>
        <label class={'od-day' + (day ? ' od-day-active' : '')} title={day ? day === noDate ? 'Без даты' : formatOrderDay(day) : 'Фильтр по дате'}>
          <ListIcon name="calendar" />
          <select aria-label="День заказа" value={day} onChange={e => setDay(e.currentTarget.value)}>
            <option value="">Все даты</option>
            {dates.map(date => <option key={date} value={date}>{formatOrderDay(date)}</option>)}
            {orders.some(o => !o.date) && <option value={noDate}>Без даты</option>}
          </select>
        </label>
        {sortButton(true)}
        <div class="od-toolbar-actions">
          <button type="button" class="od-export" disabled={!matches.length} onClick={() => filteredCsv(matches, day)}
            aria-label="Экспорт" title="Скачать выбранные заказы в CSV"><ListIcon name="download" /><span>Экспорт</span></button>
          <a class="od-new-order" href="#orders/new"><ListIcon name="plus" />Новый заказ</a>
        </div>
      </header>
      {filtered && <div class="od-applied"><span aria-live="polite">Найдено заказов · {matches.length}{day && ' · ' + (day === noDate ? 'Без даты' : formatOrderDay(day))}</span>
        <button type="button" onClick={reset}>Сбросить фильтры</button></div>}
      <div class="od-grid od-columns">
        <span class="od-number">Заказ</span><span>Автомобиль</span>{sortButton(false)}<span class="od-person">Исполнители</span>
        <span>Состояние</span><span class="od-price">По прайсу</span><span />
      </div>
      <div class="owner-board-list od-body">{current.map(o => <OrderRow key={o.key} order={o} />)}</div>
      {archived.length > 0 && <details class="owner-archive od-archive" open={filtered || undefined}>
        <summary>Архив <span>{archived.length}</span></summary>
        <div class="owner-board-list od-body">{archived.map(o => <OrderRow key={o.key} order={o} />)}</div>
      </details>}
      {!matches.length && <div class="od-empty" role="status"><ListIcon name={filtered ? 'search' : 'list'} />
        <strong>{filtered ? 'Заказы не найдены' : 'Заказов пока нет'}</strong></div>}
    </section>
  </>;
}
