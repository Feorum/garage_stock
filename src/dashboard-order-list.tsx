import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { dashboardCatalogueTotal, dashboardMetricOrders, dashboardWorkRows, lastDayOfWeek, matchesOrder, ordersInWeek, parseDashboardScope,
  shiftDate, type DashboardMetric, type DashboardOrder, type DashboardScope } from './dashboard-model';
import { nextTableSort, orderColumns, orderTableCsv, orderTableDefaults, orderViewHref, readOrderTableSettings,
  sortTableRows, withOrderColumns, workColumnIds, workColumns, workTableCsv, type OrderColumn,
  type OrderLayout, type OrderTableSettings, type OrderWorkRow, type TableSort, type WorkColumn } from './dashboard-order-table';
import { OrderViewControls } from './dashboard-order-views';
import { formatOrderDay, weekdayClass } from './order-calendar';
import { useOwnerPreference } from './owner-preferences';
import { money } from './pay-model';
import { dayLabel } from './shift-model';
import './dashboard-order-list.css';

const icons = {
  search: 'M16 16l4.5 4.5 M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  download: 'M12 3v12 M7.5 10.5L12 15l4.5-4.5 M4 16v4h16v-4',
  chevron: 'm6 9 6 6 6-6',
  sort: 'M12 4v16 M7 15l5 5 5-5',
  open: 'm9 5 7 7-7 7',
  plus: 'M12 5v14 M5 12h14',
  calendar: 'M4 6h16v15H4z M4 11h16 M8 3v6 M16 3v6',
  list: 'M5 5h14v15H5z M9 9h6 M9 13h6 M9 17h4',
};
function ListIcon({ name }: { name: keyof typeof icons }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

const dayFormat = new Intl.DateTimeFormat('ru-RU', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDay = (date: string) => dayFormat.format(new Date(date + 'T12:00:00Z'));
const noDate = 'undated';
const metricLabels: Record<DashboardMetric, string> = {
  orders: 'Заказы', active: 'В работе', closed: 'Закрытые заказы', works: 'Работы',
  completedWorks: 'Выполненные работы', amount: 'По прайсу',
};

function downloadCsv(lines: string[][], period: string, name: string) {
  function quote(value: string) {
    const plainText = /^\s*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value;
    return '"' + plainText.replaceAll('"', '""') + '"';
  }
  const text = lines.map(row => row.map(quote).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'garage-' + name + (period ? '-' + period : '') + '.csv';
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

interface ColumnHeading { label: string; minWidth: number; weight: number }
interface SortControls<Column extends string> {
  keys: Column[];
  columns: Record<Column, ColumnHeading>;
  sort: TableSort<Column>;
  onSort: (sort: TableSort<Column>) => void;
  ready: boolean;
}

function TableHeading<Column extends string>({ keys, columns, sort, onSort, ready }: SortControls<Column>) {
  return <div class="od-grid od-columns" role="group" aria-label="Сортировка по столбцам">
    {keys.map(column => {
      const active = sort.column === column;
      const next = nextTableSort(sort, column);
      return <button key={column} type="button" aria-pressed={active} disabled={!ready}
        aria-description={active ? sort.direction === 'asc' ? 'По возрастанию' : 'По убыванию' : undefined}
        title={next.direction === 'asc' ? 'По возрастанию' : 'По убыванию'}
        class={'od-sort' + (active ? ' od-sort-active' : '') + (active && sort.direction === 'desc' ? ' od-desc' : '')}
        onClick={() => onSort(next)}>
        {columns[column].label}<ListIcon name="sort" />
      </button>;
    })}
    <span />
  </div>;
}

function CompactSort<Column extends string>({ keys, columns, sort, onSort, ready }: SortControls<Column>) {
  return <div class="od-compact-sort">
    <span class="od-sort-label" aria-hidden="true">Сортировка</span>
    <label class="od-select"><select value={sort.column} aria-label="Столбец сортировки" disabled={!ready}
      onChange={event => onSort(nextTableSort(sort, event.currentTarget.value as Column))}>
      {keys.map(column => <option key={column} value={column}>{columns[column].label}</option>)}
    </select><ListIcon name="chevron" /></label>
    <button type="button" class={'od-sort od-sort-active' + (sort.direction === 'desc' ? ' od-desc' : '')} disabled={!ready}
      aria-label={sort.direction === 'asc' ? 'Сортировать по убыванию' : 'Сортировать по возрастанию'}
      onClick={() => onSort(nextTableSort(sort, sort.column))}><ListIcon name="sort" /></button>
  </div>;
}

function TableCell({ name, label, children }: { name: string; label: string; children: ComponentChildren }) {
  return <div class={'od-cell od-cell-' + name}>
    <small class="od-cell-label" aria-hidden="true">{label}</small>
    <div class="od-cell-value">{children}</div>
  </div>;
}

function OrderDate({ order }: { order: DashboardOrder }) {
  if (!order.date) return 'Дата не назначена';
  return <time dateTime={order.date} title={formatOrderDay(order.date)}>
    {order.dateKind === 'due' ? 'Срок ' : ''}{shortDay(order.date)}
  </time>;
}

function OrderValue({ order, column, showMissingRate }: { order: DashboardOrder; column: OrderColumn; showMissingRate: boolean }) {
  switch (column) {
    case 'vehicle': return <h2>{order.vehicle}</h2>;
    case 'date': return <OrderDate order={order} />;
    case 'plannedDate':
    case 'dueDate':
    case 'createdDate':
    case 'closedDate': {
      const date = orderColumns[column].value(order);
      return date ? <time dateTime={date} title={formatOrderDay(date)}>{dayLabel(date)}</time> : '—';
    }
    case 'people': return orderColumns.people.value(order) || 'Не назначены';
    case 'phase': return <div class="od-phases">
      <span class={'od-phase od-phase-' + (order.status === 'cancelled' ? 'cancelled' : order.tone)}>{order.phaseLabel}</span>
      {order.inReview && <span class="od-phase od-phase-review">На проверке</span>}
    </div>;
    case 'amount': return order.catalogueKopeks !== null ? money(order.catalogueKopeks)
      : showMissingRate ? <span class="od-rate-missing">{order.catalogueRateMissing ? 'Ставка не указана' : 'Сумма недоступна'}</span>
        : <span title="Сумма по прайсу недоступна">—</span>;
    case 'vin': return orderColumns.vin.value(order) || <span title="VIN не указан">—</span>;
    case 'instructions':
    case 'managerComment': {
      const message = orderColumns[column].value(order);
      return message ? <span class="od-cell-note" title={message}>{message}</span> : '—';
    }
    default: return orderColumns[column].value(order) || '—';
  }
}

function OrderRow({ order, columns, showMissingRate }: { order: DashboardOrder; columns: OrderColumn[]; showMissingRate: boolean }) {
  return <article class={'owner-board-card od-order ' + weekdayClass(order.date)} data-order-id={order.id}>
    <a href={order.href} class="owner-board-open od-grid od-row"
      aria-label={columns.includes('vehicle') ? undefined : 'Открыть заказ · ' + order.vehicle}>
      {columns.map(column => <TableCell key={column} name={column} label={orderColumns[column].label}>
        <OrderValue order={order} column={column} showMissingRate={showMissingRate} />
      </TableCell>)}
      <span class="od-open-icon" title="Открыть заказ"><ListIcon name="open" /></span>
    </a>
  </article>;
}

function WorkValue({ row, column }: { row: OrderWorkRow; column: WorkColumn }) {
  const { order, work } = row;
  const value = workColumns[column].value(row);
  switch (column) {
    case 'vehicle': return <strong>{value}</strong>;
    case 'date': return <OrderDate order={order} />;
    case 'status': return <span class={'od-phase' + (work.status === 'completed' ? ' od-phase-completed' : '')}>
      {value || 'Состояние не указано'}
    </span>;
    case 'people': return value || 'Не назначены';
    default: return value || '—';
  }
}

function WorkRows({ rows, sorting }: { rows: OrderWorkRow[]; sorting: SortControls<WorkColumn> }) {
  return <div class="od-records" style={gridStyle(sorting)}>
    <div class="od-table">
      <TableHeading {...sorting} />
      <ul class="od-work-list">{rows.map(row => {
        const { order, work } = row;
        return <li key={order.key + '/' + work.id} data-order-id={order.id} data-work-id={work.id}>
          <a class="od-grid od-row" href={order.href}>
            {workColumnIds.map(column => <TableCell key={column} name={column} label={workColumns[column].label}>
              <WorkValue row={row} column={column} />
            </TableCell>)}
            <span class="od-open-icon"><ListIcon name="open" /></span>
          </a>
        </li>;
      })}</ul>
    </div>
  </div>;
}

function gridStyle<Column extends string>({ keys, columns }: SortControls<Column>) {
  const tracks = keys.map(column => columns[column]);
  return {
    '--od-columns': tracks.map(column => `minmax(${column.minWidth}rem, ${column.weight}fr)`).join(' ') + ' 1rem',
    '--od-tracks-width': (1 + tracks.reduce((width, column) => width + column.minWidth, 0)) + 'rem',
    '--od-column-gaps': keys.length,
  };
}

export function DashboardOrderList({ orders, query = '' }: { orders: DashboardOrder[]; query?: string }) {
  const scope = parseDashboardScope(query);
  const viewId = new URLSearchParams(query).get('view');
  return <OrderJournal key={scope.week + '/' + scope.day + '/' + scope.metric} orders={orders} scope={scope} viewId={viewId} />;
}

function OrderJournal({ orders, scope, viewId }: { orders: DashboardOrder[]; scope: DashboardScope; viewId: string | null }) {
  const [stored, saveSettings, ready] = useOwnerPreference<OrderTableSettings>('orderTable', orderTableDefaults);
  const settings = useMemo(() => readOrderTableSettings(stored), [stored]);
  const [query, setQuery] = useState('');
  const [day, setDay] = useState(scope.day);
  const [status, setStatus] = useState<StatusFilter>('all');
  const scoped = Boolean(scope.week || scope.day || scope.metric !== 'orders');
  const showAmount = scope.metric === 'amount';
  const view = settings.views.find(tab => tab.id === viewId);
  const layout = view ?? settings.main;
  function changeLayout(next: OrderLayout) {
    saveSettings(view ? { ...settings, views: settings.views.map(tab => tab.id === view.id ? { ...tab, ...next } : tab) }
      : { ...settings, main: next });
  }
  const orderSorting: SortControls<OrderColumn> = {
    keys: layout.columns, columns: orderColumns, sort: layout.sort, ready, onSort: sort => changeLayout({ ...layout, sort }),
  };
  const workSorting: SortControls<WorkColumn> = {
    keys: workColumnIds, columns: workColumns, sort: settings.workSort, ready,
    onSort: workSort => saveSettings({ ...settings, workSort }),
  };
  const weekOrders = ordersInWeek(orders, scope.week);
  const dates = scope.week ? Array.from({ length: 7 }, (_, index) => shiftDate(scope.week, index)).filter(Boolean)
    : [...new Set([...orders.map(o => o.date), scope.day].filter(Boolean))].sort();
  const candidates = dashboardMetricOrders(weekOrders, scope.metric)
    .filter(o => (!day || day === (o.date || noDate)) && matchesStatus(o, status));
  const matches = sortTableRows(candidates.filter(o => matchesOrder(o, query)), layout.sort, orderColumns);
  const workRows = scope.metric === 'works' || scope.metric === 'completedWorks'
    ? sortTableRows(dashboardWorkRows(candidates, scope.metric).filter(({ order, work }) =>
      matchesOrder({ ...order, people: work.people, works: [work] }, query)), settings.workSort, workColumns)
    : null;
  const count = workRows?.length ?? matches.length;
  const amounts = showAmount ? dashboardCatalogueTotal(matches) : null;
  const archived = matches.filter(o => !o.isCustom && o.archived);
  const current = matches.filter(o => o.isCustom || !o.archived);
  const filtered = Boolean(scoped || query.trim() || day || status !== 'all');
  const reset = () => { setQuery(''); setDay(''); setStatus('all'); };
  return <section class="owner-board od-list" aria-label={scoped ? metricLabels[scope.metric] : 'Список заказов'}>
    {!scoped && <OrderViewControls key={view?.id || 'main'} settings={settings} view={view} layout={layout} ready={ready}
      changeColumns={columns => changeLayout(withOrderColumns(layout, columns))} saveSettings={saveSettings} />}
    <header class="od-toolbar">
      <h2>{scoped ? metricLabels[scope.metric] : 'Список заказов'}</h2>
      <label class="od-search"><ListIcon name="search" /><input type="search" aria-label="Поиск заказов"
        placeholder="Найти заказ" value={query} onInput={e => setQuery(e.currentTarget.value)} /></label>
      <label class="od-select"><select aria-label="Статус заказа" value={status}
        onChange={e => setStatus(e.currentTarget.value as StatusFilter)}>
        {Object.entries(filters).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select><ListIcon name="chevron" /></label>
      <label class={'od-day' + (day ? ' od-day-active' : '')} title={day ? day === noDate ? 'Без даты' : formatOrderDay(day) : 'Фильтр по дате'}>
        <ListIcon name="calendar" />
        <select aria-label="День заказа" value={day} onChange={e => setDay(e.currentTarget.value)}>
          <option value="">{scope.week ? 'Вся неделя' : 'Все даты'}</option>
          {dates.map(date => <option key={date} value={date}>{formatOrderDay(date)}</option>)}
          {!scope.week && orders.some(o => !o.date) && <option value={noDate}>Без даты</option>}
        </select>
      </label>
      {workRows ? <CompactSort {...workSorting} /> : <CompactSort {...orderSorting} />}
      <div class="od-toolbar-actions">
        <button type="button" class="od-export" disabled={!count} onClick={() => downloadCsv(
          workRows ? workTableCsv(workRows) : orderTableCsv([...current, ...archived], layout.columns),
          day || scope.week, workRows ? 'works' : 'orders')}
          aria-label="Экспорт" title="Скачать текущую выборку в CSV"><ListIcon name="download" /><span>Экспорт</span></button>
        <a class="od-new-order" href="#orders/new"><ListIcon name="plus" />Новый заказ</a>
      </div>
    </header>
    {filtered && <div class="od-applied">
      {scope.week && <span class="od-scope">Неделя {shortDay(scope.week)} – {shortDay(lastDayOfWeek(scope.week))}</span>}
      {day && <span class="od-scope">{day === noDate ? 'Без даты' : formatOrderDay(day)}</span>}
      <span aria-live="polite">{workRows ? 'Работ' : 'Найдено заказов'} · {count}</span>
      {amounts && count > 0 && <span aria-live="polite">{amounts.missing ? 'Заказов без полной суммы · ' + amounts.missing
        : amounts.total !== null ? 'Всего по прайсу · ' + money(amounts.total) : 'Общая сумма недоступна'}</span>}
      {scoped ? <a href={orderViewHref(view?.id)}>Сбросить фильтры</a> : <button type="button" onClick={reset}>Сбросить фильтры</button>}
    </div>}
    {workRows ? <WorkRows rows={workRows} sorting={workSorting} /> : <div class="od-records" style={gridStyle(orderSorting)}>
      <div class="owner-board od-table">
        <TableHeading {...orderSorting} />
        <div class="owner-board-list od-body">{current.map(o =>
          <OrderRow key={o.key} order={o} columns={layout.columns} showMissingRate={showAmount} />)}
        </div>
        {archived.length > 0 && <details class="owner-archive od-archive" open={filtered || undefined}>
          <summary>Архив <span>{archived.length}</span></summary>
          <div class="owner-board-list od-body">{archived.map(o =>
            <OrderRow key={o.key} order={o} columns={layout.columns} showMissingRate={showAmount} />)}
          </div>
        </details>}
      </div>
    </div>}
    {!count && <div class="od-empty" role="status"><ListIcon name={filtered ? 'search' : 'list'} />
      <strong>{workRows ? 'Работы не найдены' : filtered ? 'Заказы не найдены' : 'Заказов пока нет'}</strong></div>}
  </section>;
}
