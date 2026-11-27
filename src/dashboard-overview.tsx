import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dashboardCatalogueTotal, dashboardMetricOrders, dashboardScopeHref, dashboardWorkRows, lastDayOfWeek, mondayOf,
  ordersInWeek, shiftDate, type DashboardOrder } from './dashboard-model';
import { useOwnerPreference } from './owner-preferences';
import { OwnerWidgetEditor } from './owner-widget-editor';
import { chartMetrics, homeWidgets, monthlyWidgets, noWidgets, orderWidgets, readOwnerWidgets, valueMetrics, widgetTitle,
  type OwnerWidget, type WidgetMetric } from './owner-widget-model';
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
  const weeks = [-3, -2, -1, 0, 1, 2, 3].map(offset => shiftDate(week, offset * 7)).filter(Boolean);
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
    <button class="dash-step" type="button" aria-label="Предыдущая неделя" title="Предыдущая неделя" disabled={!shiftDate(week, -7)}
      onClick={() => onChange(shiftDate(week, -7))}><Icon name="left" /></button>
    <div class="dash-week-scroll" ref={ribbon}>{weeks.map(first => {
      const last = lastDayOfWeek(first);
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
    <button class="dash-step" type="button" aria-label="Следующая неделя" title="Следующая неделя" disabled={!shiftDate(week, 7)}
      onClick={() => onChange(shiftDate(week, 7))}><Icon name="right" /></button>
  </div>;
}

function Chart({ orders, week, today, drillDown, title = 'Активность', metric, onMetricChange, disabled }: {
  orders: DashboardOrder[]; week: string; today: string; drillDown: boolean; title?: string;
  metric?: WidgetMetric<'chart'>; onMetricChange?: (metric: WidgetMetric<'chart'>) => void; disabled?: boolean;
}) {
  const [localMetric, setLocalMetric] = useState<WidgetMetric<'chart'>>('orders');
  const unit = metric ?? localMetric;
  const changeMetric = onMetricChange ?? setLocalMetric;
  const label = chartMetrics[unit];
  const dates = days.map((_, i) => shiftDate(week, i)).filter(Boolean);
  const totals = new Map<string, number>();
  const contributions = unit === 'orders' ? orders : dashboardWorkRows(orders, 'works').map(({ order }) => order);
  for (const order of contributions) totals.set(order.date, (totals.get(order.date) || 0) + 1);
  const values = dates.map(date => totals.get(date) || 0);
  const half = Math.max(1, Math.max(...values) / 2);
  const power = 10 ** Math.floor(Math.log10(half));
  const step = ([1, 2, 3, 5, 10].find(n => n * power >= half) || 10) * power;
  return <section class="dash-activity">
    <div class="dash-chart-heading"><h3>{title}</h3>
      <div class="dash-unit" role="group" aria-label="Показатель графика">
        <button type="button" aria-pressed={unit === 'orders'} disabled={disabled} onClick={() => changeMetric('orders')}>Заказы</button>
        <button type="button" aria-pressed={unit === 'works'} disabled={disabled} title="Работы стандартных заказов без отменённых"
          onClick={() => changeMetric('works')}>Работы</button>
      </div>
    </div>
    <div class="dash-plot">
      <div class="dash-bars">{dates.map((day, index) => {
        const name = dateLabels.format(asDate(day)) + ' · ' + label + ' ' + values[index];
        const Column = drillDown ? 'a' : 'div';
        return <Column class={'dash-day' + (day === today ? ' dash-today' : '')}
          key={day} href={drillDown ? dashboardScopeHref(week, unit, day) : undefined}
          role={drillDown ? undefined : 'img'} aria-label={name} title={name}>
          <span class="dash-track" aria-hidden="true"><span class="dash-fill" style={{ height: (values[index] / (2 * step) * 100) + '%' }}>
            {values[index] > 0 && <small>{values[index]}</small>}</span></span>
          <span class="dash-day-label">{days[index]}</span>
        </Column>;
      })}</div>
      <div class="dash-axis" aria-hidden="true"><span>{step * 2}</span><span>{step}</span><span>0</span></div>
    </div>
  </section>;
}

function summarize(rows: DashboardOrder[], includeMoney: boolean) {
  const standard = includeMoney ? dashboardMetricOrders(rows, 'amount') : [];
  const amount = includeMoney && (standard.length || !rows.length) ? dashboardCatalogueTotal(standard).total : null;
  const works = dashboardWorkRows(rows, 'works');
  return {
    orders: rows.length, amount: amount === null ? null : amount / 100,
    active: dashboardMetricOrders(rows, 'active').length,
    unarchived: rows.filter(row => !row.archived).length,
    works: works.length,
    review: rows.filter(row => row.inReview).length,
    closed: dashboardMetricOrders(rows, 'closed').length,
    completedWorks: works.filter(({ work }) => work.status === 'completed').length,
  };
}

function Metric({ title, name, current, previous, hint, href, price = false }: {
  title: string; name: keyof typeof paths; current: number | null; previous?: number | null; hint?: string; href?: string; price?: boolean;
}) {
  const exact = (n: number) => price ? currency.format(n) + ' BYN' : numbers.format(n);
  let change = '—';
  const direction = current === null || !previous ? 0 : Math.sign(current - previous);
  if (current !== null && previous != null && previous > 0) {
    const percent = Math.abs((current - previous) / previous) * 100;
    change = percent > 0 && percent < 0.1 ? (direction > 0 ? '↑' : '↓') + ' <0,1%'
      : (direction > 0 ? '+' : direction < 0 ? '−' : '') + numbers.format(percent) + '%';
  }
  const description = previous == null ? 'Сравнение недоступно' : 'Предыдущая неделя · ' + exact(previous);
  const Card = href ? 'a' : 'div';
  return <Card class="dash-metric" title={hint} href={href}>
    <div class="dash-metric-label"><h3>{title}</h3><Icon name={name} /></div>
    <div class="dash-metric-result"><strong title={current === null ? 'Нет полной суммы по прайсу' : exact(current)}>
      {current === null ? '—' : current >= 100000 ? compact.format(current) : price ? currency.format(current) : numbers.format(current)}
      {price && current !== null && <small> BYN</small>}</strong>
      {current === null ? <span class="dash-no-rate">Нет суммы</span> : previous !== undefined &&
        <span class={'dash-change ' + (direction > 0 ? 'dash-gain' : direction < 0 ? 'dash-loss' : '')}
          title={description} aria-label={description + '. Изменение ' + change}>{change}</span>}
    </div>
  </Card>;
}

function Completion({ title, current, metric, week }: {
  title: string; current: ReturnType<typeof summarize>; metric: WidgetMetric<'progress'>; week?: string;
}) {
  const forWorks = metric === 'completedWorks';
  const completed = current[metric];
  const total = forWorks ? current.works : current.orders;
  const percent = total ? Math.round(100 * completed / total) : null;
  const Card = week ? 'a' : 'div';
  return <Card class="home-completion" href={week ? dashboardScopeHref(week, metric) : undefined}>
    <h3>{title}</h3>
    <div class="home-progress-ring" style={{ '--completion': (total ? 100 * completed / total : 0) + '%' }}
      aria-hidden="true">
      <strong>{percent === null ? '—' : percent + '%'}</strong>
    </div>
    <p>{total ? <>{forWorks ? 'Выполнено' : 'Закрыто'} <b>{completed} из {total}</b></>
      : forWorks ? 'Работ пока нет' : 'Заказов пока нет'}</p>
  </Card>;
}

const metricIcons = {
  amount: 'amount', orders: 'orders', active: 'active', unarchived: 'works', works: 'works',
  review: 'review', closed: 'done', completedWorks: 'done',
} as const;
const metricHints: Partial<Record<WidgetMetric<'value'>, string>> = {
  amount: 'Каталожная стоимость стандартных заказов в BYN, без отменённых работ и заказов.',
  unarchived: 'Все заказы, кроме закрытых и отменённых.',
  works: 'Количество работ в стандартных заказах, без отменённых работ и заказов.',
};
const adminMetrics = ['amount', 'orders', 'active', 'works', 'review', 'closed'] as const;
const mechanicMetrics = ['orders', 'active', 'works', 'completedWorks'] as const;

export type MonthlyWidgetRenderer = (widget: { title: string; metric: WidgetMetric<'monthly'> }) => ComponentChildren;

interface OwnerSummarySettings {
  widgets: readonly OwnerWidget[];
  setWidgets: (widgets: readonly OwnerWidget[]) => void;
  ready: boolean;
  allTime: boolean;
  renderMonthly?: MonthlyWidgetRenderer;
}

function WeeklyOverview({ orders, weekStart, onWeekChange, role = 'admin', layout = 'compact', settings }: Props & {
  settings?: OwnerSummarySettings;
}) {
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
  const allTime = settings?.allTime;
  const showWeek = home || !settings || settings.widgets.some(widget => widget.kind !== 'monthly' && (!allTime || widget.kind === 'chart'));
  const showSummary = showWeek || Boolean(settings?.widgets.length);
  const currentRows = showWeek ? ordersInWeek(orders, week) : [];
  const totals = summarize(allTime ? orders : currentRows, role === 'admin');
  const earlierWeek = showWeek && !allTime ? shiftDate(week, -7) : '';
  const previous = allTime ? null : summarize(earlierWeek ? ordersInWeek(orders, earlierWeek) : [], role === 'admin');
  const drillDown = role === 'admin' && (home || Boolean(settings));
  const classes = 'dash-overview' + (home ? ' dash-home-overview' : '') + (settings ? ' dash-owner-overview' : '');
  const regionLabel = allTime ? 'Сводка по всем заказам' : settings?.renderMonthly ? 'Виджеты отчёта' : 'Недельная сводка заказов';

  function metricCard(metric: WidgetMetric<'value'>, title = valueMetrics[metric], key: string = metric) {
    const href = drillDown && !allTime && metric !== 'unarchived' ? dashboardScopeHref(week, metric) : undefined;
    return <Metric key={key} title={title} name={metricIcons[metric]} current={totals[metric]} previous={previous?.[metric]}
      price={metric === 'amount'} hint={metricHints[metric]} href={href} />;
  }

  return <section class={showSummary ? classes : classes + ' dash-widget-setup'}
    aria-label={showSummary ? regionLabel : undefined}>
    {showWeek && <WeekStrip week={week} selected={weekStart} counts={counts} onChange={onWeekChange} />}
    <div class={'dash-period-heading' + (showWeek ? '' : ' dash-setup-heading')}>
      {showWeek && <h2>{allTime ? 'Графики за неделю' : 'Сводка за неделю'} <span>{rangeLabel(week, lastDayOfWeek(week))}</span></h2>}
      <div class="dash-period-controls">
        {settings && <OwnerWidgetEditor widgets={settings.widgets} onChange={settings.setWidgets} ready={settings.ready}
          allowMonthly={Boolean(settings.renderMonthly)} />}
        {showWeek && <>
          {home || settings
            ? <button type="button" aria-pressed={week === thisWeek} onClick={() => onWeekChange(thisWeek)}>Текущая неделя</button>
            : <button type="button" aria-pressed={!weekStart} onClick={() => onWeekChange(null)}>Все даты</button>}
          <label class="dash-pick" title="Выбрать неделю по дате"><Icon name="calendar" />
            <input type="date" value={weekStart ?? ''} aria-label="Выбрать неделю по дате"
              onChange={e => { const start = mondayOf(e.currentTarget.value); if (start) onWeekChange(start); }} /></label>
        </>}
      </div>
    </div>
    {settings ? settings.widgets.length > 0 && <div class="dash-owner-widgets">
      {settings.widgets.map(widget => {
        const title = widgetTitle(widget);
        switch (widget.kind) {
          case 'chart': return <Chart key={widget.id} orders={currentRows} week={week} today={today} drillDown={drillDown}
            title={title} metric={widget.metric} disabled={!settings.ready} onMetricChange={metric => {
              if (metric !== widget.metric) settings.setWidgets(settings.widgets.map(item => item.id === widget.id ? { ...widget, metric } : item));
            }} />;
          case 'progress': return <Completion key={widget.id} title={title} current={totals} metric={widget.metric} week={allTime ? undefined : week} />;
          case 'value': return metricCard(widget.metric, title, widget.id);
          case 'monthly': return <div key={widget.id} class="dash-monthly-widget">
            {settings.renderMonthly?.({ title, metric: widget.metric })}
          </div>;
        }
      })}
    </div> : <div class={'dash-summary' + (role === 'mechanic' ? ' dash-personal' : '')}>
      <Chart orders={currentRows} week={week} today={today} drillDown={false} />
      <div class="dash-metrics" aria-label="Показатели недели и изменение к предыдущей">
        {(role === 'admin' ? adminMetrics : mechanicMetrics).map(metric => metricCard(metric))}
      </div>
    </div>}
  </section>;
}

export function OwnerDashboardOverview({ tab, renderMonthly, ...props }: Omit<Props, 'role'> & {
  tab: string; renderMonthly?: MonthlyWidgetRenderer;
}) {
  const allTime = tab === 'orders';
  const allowMonthly = Boolean(renderMonthly);
  const fallback = props.layout === 'home' ? homeWidgets : allTime ? orderWidgets : allowMonthly ? monthlyWidgets : noWidgets;
  const [saved, setWidgets, ready] = useOwnerPreference('widgets:' + tab, fallback);
  const widgets = useMemo(() => {
    const configured = readOwnerWidgets(saved, fallback);
    return allowMonthly ? configured : configured.filter(widget => widget.kind !== 'monthly');
  }, [saved, fallback, allowMonthly]);
  return <WeeklyOverview {...props} settings={{ widgets, setWidgets, ready, allTime, renderMonthly }} />;
}

export function DashboardOverview(props: Props) {
  if (props.layout === 'home' && props.role !== 'mechanic') {
    return <OwnerDashboardOverview tab="home" {...props} />;
  }
  return <WeeklyOverview {...props} />;
}
