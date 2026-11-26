import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { mondayOf, ordersInWeek, shiftDate, type DashboardOrder } from './dashboard-model';
import { workshopDay } from './workspace-types';
import './dashboard-overview.css';

interface Props {
  orders: DashboardOrder[];
  weekStart: string | null;
  onWeekChange: (week: string | null) => void;
  role?: 'admin' | 'mechanic';
  layout?: 'compact' | 'home';
}

const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const months = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'short' });
const dateLabels = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' });
const weekLabels = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const numbers = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const currency = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const asDate = (day: string) => new Date(day + 'T12:00:00Z');
const monthOf = (day: string) => months.format(asDate(day)).replace(/\.$/, '');
const dayNumber = (day: string) => day.slice(-2);
const rangeLabel = (first: string, last: string) =>
  weekLabels.formatRange(asDate(first), asDate(last)).replace(/\s*г\./gu, '');

function Icon({ name }: { name: keyof typeof paths }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

const paths = {
  calendar: 'M4 8h16M8 3v4m8-4v4M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  left: 'm14.5 5.5-6 6.5 6 6.5',
  right: 'm9.5 5.5 6 6.5-6 6.5',
  orders: 'M7 5H5v15h14V5h-2M9 3h6v4H9zM8 11h8m-8 4h6',
  amount: 'M4 7h15v3m-1-6L5 6a2 2 0 0 0-1 2v9a2 2 0 0 0 2 2h13v-4m-1-5h3v5h-3a2.5 2.5 0 0 1 0-5Z',
  active: 'M4 13h4l3-8 3 14 3-7h3',
  works: 'M15 4a5 5 0 0 0-6 6L3.7 16a2.5 2.5 0 0 0 3.6 3.4l5.8-5.8A5 5 0 0 0 20 7l-3.5 3.2-2.7-2.6L17 4Z',
  review: 'M20.5 12s-3.3 6-8.5 6-8.5-6-8.5-6 3.3-6 8.5-6 8.5 6 8.5 6ZM14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  done: 'M20.5 10.3A8.6 8.6 0 1 1 16 4.4M9 10.5l3 3 8-8',
};

function WeekStrip({ week, selected, counts, onChange }: {
  week: string; selected: string | null; counts: Map<string, number>; onChange: Props['onWeekChange'];
}) {
  const ribbon = useRef<HTMLDivElement>(null);
  const weeks = [-3, -2, -1, 0, 1, 2, 3].map(offset => shiftDate(week, offset * 7));
  const largest = Math.max(1, ...weeks.map(start => counts.get(start) || 0));
  useLayoutEffect(() => {
    const group = ribbon.current;
    if (!group) return;
    function centerWeek() {
      const strip = ribbon.current;
      const current = strip?.querySelector<HTMLElement>('[data-summary-week]');
      if (strip && current && strip.clientWidth && strip.scrollWidth > strip.clientWidth) {
        strip.scrollLeft = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
      }
    }
    centerWeek();
    const resize = new ResizeObserver(centerWeek);
    resize.observe(group);
    return () => resize.disconnect();
  }, [week]);

  return <div class="dash-weeks" role="group" aria-label="Недели заказов">
    <button class="dash-step" type="button" aria-label="Предыдущая неделя" title="Предыдущая неделя"
      onClick={() => onChange(shiftDate(week, -7))}><Icon name="left" /></button>
    <div class="dash-week-scroll" ref={ribbon}>{weeks.map(first => {
      const last = shiftDate(first, 6);
      const count = counts.get(first) || 0;
      const name = rangeLabel(first, last) + ' · Заказов ' + count;
      return <button class="dash-week" type="button" key={first}
        data-summary-week={first === week ? '' : undefined}
        aria-pressed={selected === first} aria-label={name} title={name} onClick={() => onChange(first)}>
        <span class="dash-month">{monthOf(first)}{first.slice(0, 7) !== last.slice(0, 7) && ' – ' + monthOf(last)}</span>
        <span class="dash-week-range">{dayNumber(first)} – {dayNumber(last)}</span>
        <span class="dash-week-volume" aria-hidden="true"><i style={{width: (count / largest * 100) + '%'}} /></span>
      </button>;
    })}</div>
    <button class="dash-step" type="button" aria-label="Следующая неделя" title="Следующая неделя"
      onClick={() => onChange(shiftDate(week, 7))}><Icon name="right" /></button>
  </div>;
}

function workCount(order: DashboardOrder) {
  return order.isCustom || order.status === 'cancelled' ? 0 : order.works.filter(work => work.status !== 'cancelled').length;
}

function Chart({ orders, week, today }: { orders: DashboardOrder[]; week: string; today: string }) {
  const [unit, setUnit] = useState<'orders' | 'works'>('orders');
  const label = unit === 'orders' ? 'Заказы' : 'Работы';
  const dates = days.map((_, i) => shiftDate(week, i));
  const totals = new Map<string, number>();
  for (const order of orders) totals.set(order.date, (totals.get(order.date) || 0) + (unit === 'orders' ? 1 : workCount(order)));
  const values = dates.map(date => totals.get(date) || 0);
  const half = Math.max(1, Math.max(...values) / 2);
  const power = 10 ** Math.floor(Math.log10(half));
  const step = ([1, 2, 3, 5, 10].find(n => n * power >= half) || 10) * power;
  return <section class="dash-activity">
    <div class="dash-chart-heading"><h3>Активность</h3>
      <div class="dash-unit" role="group" aria-label="Показатель графика">
        <button type="button" aria-pressed={unit === 'orders'} onClick={() => setUnit('orders')}>Заказы</button>
        <button type="button" aria-pressed={unit === 'works'} title="Работы стандартных заказов без отменённых"
          onClick={() => setUnit('works')}>Работы</button>
      </div>
    </div>
    <div class="dash-plot">
      <div class="dash-bars">{dates.map((day, index) => {
        const name = dateLabels.format(asDate(day)) + ' · ' + label + ' ' + values[index];
        return <div class={'dash-day' + (day === today ? ' dash-today' : '')}
          key={day} role="img" aria-label={name} title={name}>
          <div class="dash-track"><div class="dash-fill" style={{ height: (values[index] / (2 * step) * 100) + '%' }}>
            {values[index] > 0 && <small>{values[index]}</small>}</div></div>
          <span>{days[index]}</span>
        </div>;
      })}</div>
      <div class="dash-axis" aria-hidden="true"><span>{step * 2}</span><span>{step}</span><span>0</span></div>
    </div>
  </section>;
}

function summarize(rows: DashboardOrder[], includeMoney: boolean) {
  const standard = rows.filter(row => !row.isCustom && row.status !== 'cancelled');
  const incomplete = standard.some(row => !Number.isSafeInteger(row.catalogueKopeks));
  const amount = includeMoney && !incomplete && (standard.length || !rows.length)
    ? standard.reduce((sum, row) => sum + (row.catalogueKopeks ?? 0), 0) : null;
  return {
    orders: rows.length, amount: amount !== null && Number.isSafeInteger(amount) ? amount / 100 : null,
    active: rows.filter(row => row.tone === 'active' && !row.inReview).length,
    works: rows.reduce((count, row) => count + workCount(row), 0),
    review: rows.filter(row => row.inReview).length,
    done: rows.filter(row => row.status === 'closed').length,
    completedWorks: standard.reduce((count, row) => count + row.works.filter(w => w.status === 'completed').length, 0),
  };
}

function Metric({ title, name, current, previous, hint, price = false }: {
  title: string; name: keyof typeof paths; current: number | null; previous: number | null; hint?: string; price?: boolean;
}) {
  const exact = (n: number) => price ? currency.format(n) + ' BYN' : numbers.format(n);
  let change = '—';
  const direction = current === null || previous === null || !previous ? 0 : Math.sign(current - previous);
  if (current !== null && previous !== null && previous > 0) {
    const percent = Math.abs((current - previous) / previous) * 100;
    change = percent > 0 && percent < 0.1 ? (direction > 0 ? '↑' : '↓') + ' <0,1%'
      : (direction > 0 ? '+' : direction < 0 ? '−' : '') + numbers.format(percent) + '%';
  }
  const description = previous === null ? 'Сравнение недоступно' : 'Предыдущая неделя · ' + exact(previous);
  return <div class="dash-metric" title={hint}>
    <div class="dash-metric-label"><h3>{title}</h3><Icon name={name} /></div>
    <div class="dash-metric-result"><strong title={current === null ? 'Нет полной суммы по прайсу' : exact(current)}>
      {current === null ? '—' : current >= 100000 ? compact.format(current) : price ? currency.format(current) : numbers.format(current)}
      {price && current !== null && <small> BYN</small>}</strong>
      {current === null ? <span class="dash-no-rate">Нет суммы</span> :
        <span class={'dash-change ' + (direction > 0 ? 'dash-gain' : direction < 0 ? 'dash-loss' : '')}
          title={description} aria-label={description + '. Изменение ' + change}>{change}</span>}
    </div>
  </div>;
}

function Completion({ completed, total }: { completed: number; total: number }) {
  const percent = total ? Math.round(100 * completed / total) : null;
  return <section class="home-completion" aria-label="Выполнение стандартных работ">
    <h3>Выполнение работ</h3>
    <div class="home-progress-ring" style={{ '--completion': (total ? 100 * completed / total : 0) + '%' }}
      role="img" aria-label={total ? 'Выполнено ' + completed + ' из ' + total : 'Нет стандартных работ'}>
      <strong>{percent === null ? '—' : percent + '%'}</strong>
    </div>
    <p>{total ? <>Выполнено <b>{completed} из {total}</b></> : 'Работ пока нет'}</p>
  </section>;
}

export function DashboardOverview({ orders, weekStart, onWeekChange, role = 'admin', layout = 'compact' }: Props) {
  const home = layout === 'home';
  const today = workshopDay();
  const thisWeek = mondayOf(today);
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const row of orders) if (row.date) {
      const start = mondayOf(row.date);
      result.set(start, (result.get(start) || 0) + 1);
    }
    return result;
  }, [orders]);
  // All dates keeps undated and historic orders in the table. Its summary still
  // needs one named week so the chart and comparison have a common denominator.
  let week = weekStart ?? thisWeek;
  if (!weekStart && counts.size && !counts.has(thisWeek)) {
    let distance = Infinity;
    for (const start of counts.keys()) {
      const difference = Math.abs(Date.parse(start) - Date.parse(thisWeek));
      if (difference < distance || (difference === distance && start < week)) {
        distance = difference;
        week = start;
      }
    }
  }
  const currentRows = ordersInWeek(orders, week);
  const current = summarize(currentRows, role === 'admin');
  const previous = summarize(ordersInWeek(orders, shiftDate(week, -7)), role === 'admin');
  return <section class={'dash-overview' + (home ? ' dash-home-overview' : '')} aria-label="Недельная сводка заказов">
    <WeekStrip week={week} selected={weekStart} counts={counts} onChange={onWeekChange} />
    <div class="dash-period-heading">
      <h2>Сводка за неделю <span>{rangeLabel(week, shiftDate(week, 6))}</span></h2>
      <div class="dash-period-controls">
        {home
          ? <button type="button" aria-pressed={week === thisWeek} onClick={() => onWeekChange(thisWeek)}>Текущая неделя</button>
          : <button type="button" aria-pressed={!weekStart} onClick={() => onWeekChange(null)}>Все даты</button>}
        <label class="dash-pick" title="Выбрать неделю по дате"><Icon name="calendar" />
          <input type="date" value={weekStart ?? ''} aria-label="Выбрать неделю по дате"
            onChange={e => { if (e.currentTarget.value) onWeekChange(mondayOf(e.currentTarget.value)); }} /></label>
      </div>
    </div>
    <div class={'dash-summary' + (role === 'mechanic' ? ' dash-personal' : '')}>
      <Chart orders={currentRows} week={week} today={today} />
      <div class="dash-metrics" aria-label="Показатели недели и изменение к предыдущей">
        {home && <Completion completed={current.completedWorks} total={current.works} />}
        {role === 'admin' && <Metric title="По прайсу" name="amount" current={current.amount} previous={previous.amount} price
          hint="Каталожная стоимость стандартных заказов в BYN, без отменённых работ и заказов." />}
        <Metric title="Заказы" name="orders" current={current.orders} previous={previous.orders} />
        <Metric title="В работе" name="active" current={current.active} previous={previous.active} />
        <Metric title="Работы" name="works" current={current.works} previous={previous.works}
          hint="Количество работ в стандартных заказах, без отменённых работ и заказов." />
        {role === 'admin' ? <>
          <Metric title="На проверке" name="review" current={current.review} previous={previous.review} />
          <Metric title="Закрытые заказы" name="done" current={current.done} previous={previous.done} />
        </> : <Metric title="Выполнено работ" name="done" current={current.completedWorks} previous={previous.completedWorks} />}
      </div>
    </div>
  </section>;
}
