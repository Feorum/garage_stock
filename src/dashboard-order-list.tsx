import { useState } from 'preact/hooks';
import { matchesOrder, shiftDate, type DashboardOrder } from './dashboard-model';
import { formatOrderDay, weekdayClass } from './order-calendar';
import { money } from './pay-model';
import { taskLabel } from './shift-model';
import './dashboard-order-list.css';

const icons = {
  search: 'M16 16l4.5 4.5 M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  download: 'M12 3v12 M7.5 10.5L12 15l4.5-4.5 M4 16v4h16v-4',
  chevron: 'm6 9 6 6 6-6',
  sort: 'M12 4v16 M7 15l5 5 5-5',
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

function VehicleBadge({ vehicle }: { vehicle: string }) {
  const words = vehicle.trim().split(/\s+/);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toLocaleUpperCase('ru');
  const tone = [...vehicle].reduce((sum, letter) => sum + (letter.codePointAt(0) || 0), 0) % 5;
  return <span aria-hidden="true" class={'od-vehicle-badge od-tint-' + tone}>{initials}</span>;
}

function OrderDetails({ order }: { order: DashboardOrder }) {
  const fields = [
    ['VIN', order.vin], ['Группа', order.group], ['Цвет', order.colour], ['Источник', order.sourceLabel],
    ['Менеджер', order.manager], ['Автомобиль у механика', order.holder], ['Исполнители', order.people.map(p => p.name).join(', ')],
  ].filter(([, value]) => value);
  return <div class="od-expanded" id={'od-details-' + order.key}>
    {fields.length > 0 && <dl class="od-fields">{fields.map(([key, value]) =>
      <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
    <div class="od-detail-bottom">
      <div class="od-work-details">
        {order.works.length ? <>
          <strong>Состав работ</strong>
          <ul>{order.works.map(work => <li key={work.id}><span>{work.name}</span>
            <small>{taskLabel[work.status] || work.status}</small></li>)}</ul>
        </> : <p>{order.isCustom ? 'Работы и расчёты доступны в карточке заказа.' : 'Работы не указаны.'}</p>}
      </div>
      <a class="od-detail-link" href={order.href}>Открыть заказ</a>
    </div>
  </div>;
}

function OrderRow({ order, expanded, toggle }: { order: DashboardOrder; expanded: boolean; toggle: () => void }) {
  const workers = order.people.map(p => p.name).join(', ');
  const subtitle = [order.number || typeName(order), order.colour, order.sourceLabel].filter(Boolean).join(' · ');
  const dateText = order.date ? shortDay(order.date) : 'Дата не назначена';
  const meta = [dateText, order.phaseLabel, order.isCustom ? 'Кастомный' : ''].filter(Boolean).join(' · ');
  return <article class={'owner-board-card od-order ' + weekdayClass(order.date) + (expanded ? ' od-open' : '')}
    data-order-id={order.id}>
    <div class="od-grid od-summary">
      <a href={order.href} class="owner-board-open od-vehicle-link">
        <VehicleBadge vehicle={order.vehicle} />
        <div class="od-vehicle-text">
          <h2 title={order.vehicle}>{order.vehicle}</h2>
          <small class="od-order-meta" title={subtitle}>{subtitle}</small>
          <small class="od-compact-meta">{meta}</small>
          <span class="sr-only"> · {typeName(order)} · {order.phaseLabel}</span>
        </div>
      </a>
      <span class="od-date" title={order.date ? (order.dateKind === 'due' ? 'Срок • ' : '') + formatOrderDay(order.date) : undefined}>
        {order.date ? <time dateTime={order.date}>{order.dateKind === 'due' ? 'Срок ' : ''}{dateText}</time> : dateText}
      </span>
      <span class="od-person" title={workers || undefined}>{workers || (order.isCustom ? 'В карточке' : 'Не назначены')}</span>
      <span class={'od-phase od-phase-' + order.tone}>{order.phaseLabel}</span>
      <span class={'od-price' + (order.catalogueKopeks === null ? ' od-price-empty' : '')}>
        {order.catalogueKopeks === null ? <span title={order.isCustom ? 'Кастомный заказ' : 'Сумма по прайсу недоступна'}>—</span> : money(order.catalogueKopeks)}
      </span>
      <button type="button" class="od-toggle" aria-expanded={expanded}
        aria-controls={expanded ? 'od-details-' + order.key : undefined}
        aria-label={(expanded ? 'Свернуть' : 'Раскрыть') + ' заказ · ' + order.vehicle} onClick={toggle}><ListIcon name="chevron" /></button>
    </div>
    {expanded && <OrderDetails order={order} />}
  </article>;
}

export function DashboardOrderList({ orders, weekStart }: { orders: DashboardOrder[]; weekStart?: string | null }) {
  const [query, setQuery] = useState('');
  const [selectedDay, setDay] = useState({ period: '', day: '' });
  const [descending, setDescending] = useState(false);
  const [expanded, setExpanded] = useState('');
  const period = weekStart || '';
  const day = selectedDay.period === period ? selectedDay.day : '';
  const days = weekStart ? Array.from({ length: 7 }, (_, i) => shiftDate(weekStart, i))
    : [...new Set(orders.map(o => o.date).filter(Boolean))].sort();
  const matches = orders.filter(order => (!day || day === (order.date || noDate)) && matchesOrder(order, query));
  // Preserve the board's established queue order for ties and keep undated work at the end.
  if (descending) matches.sort((a, b) => Number(!a.date) - Number(!b.date) || b.date.localeCompare(a.date));
  const archive = matches.filter(o => !o.isCustom && o.archived);
  const current = matches.filter(o => o.isCustom || !o.archived);
  const row = (o: DashboardOrder) => <OrderRow key={o.key} order={o} expanded={expanded === o.key}
    toggle={() => setExpanded(expanded === o.key ? '' : o.key)} />;
  const sortLabel = descending ? 'Сначала ближайшие заказы' : 'Сначала поздние заказы';
  const sortButton = (compact: boolean) => <button type="button" title={sortLabel} aria-label={sortLabel} onClick={() => setDescending(!descending)}
    class={'od-sort' + (compact ? ' od-sort-compact' : '') + (descending ? ' od-desc' : '')}>
    {!compact && 'Дата'}<ListIcon name="sort" />
  </button>;
  return <section class="owner-board od-list" aria-label="Список заказов">
    <header class="od-toolbar"><div class="od-title"><h2>Список заказов</h2><span aria-live="polite">{matches.length}</span></div>
      <div class="od-tools">
        <label class="od-period"><select aria-label="День заказа" value={day} onChange={e => setDay({ period, day: e.currentTarget.value })}>
          <option value="">{weekStart ? 'Вся неделя' : 'Все даты'}</option>
          {days.map(value => <option key={value} value={value}>{formatOrderDay(value)}</option>)}
          {!weekStart && orders.some(o => !o.date) && <option value={noDate}>Без даты</option>}
        </select><ListIcon name="chevron" /></label>
        <label class="od-search"><ListIcon name="search" /><input type="search" aria-label="Поиск заказов"
          placeholder="Поиск заказов" value={query} onInput={e => setQuery(e.currentTarget.value)} /></label>
        {sortButton(true)}
        <button type="button" class="od-export" disabled={!matches.length} onClick={() => filteredCsv(matches, day || period)}
          title="Скачать выбранные заказы в CSV"><ListIcon name="download" />Экспорт</button>
      </div>
    </header>
    <div class="od-grid od-columns">
      <span>Автомобиль</span>{sortButton(false)}<span class="od-person">Исполнители</span><span class="od-phase-head">Состояние</span>
      <span class="od-price">По прайсу</span><span />
    </div>
    <div class="owner-board-list od-body">{current.map(row)}</div>
    {archive.length > 0 && <details class="owner-archive od-archive" open={Boolean(query.trim() || day) || undefined}>
      <summary>Архив <span>{archive.length}</span></summary>
      <div class="owner-board-list od-body">{archive.map(row)}</div>
    </details>}
    {!matches.length && <div class="od-empty" role="status"><span class="od-empty-icon"><ListIcon name={orders.length ? 'search' : 'list'} /></span>
      <strong>{orders.length ? 'Заказы не найдены' : 'Заказов за этот период нет'}</strong>
      {(day || query.trim()) && <button class="od-detail-link" type="button" onClick={() => { setQuery(''); setDay({ period, day: '' }); }}>
        Сбросить фильтры</button>}
    </div>}
  </section>;
}
