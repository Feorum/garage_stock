import { useState } from 'preact/hooks';
import { DashboardOverview } from './dashboard-overview';
import { mondayOf, ordersInWeek, shiftDate, type DashboardOrder } from './dashboard-model';
import { workshopDay } from './workspace-types';
import './dashboard-home.css';

const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' });
const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dateKinds: Record<DashboardOrder['dateKind'], string> = {
  planned: 'Запись', visit: 'Визит', due: 'Срок выполнения', actual: 'Выполнение', none: '',
};

function Visit({ order }: { order: DashboardOrder }) {
  const status = order.inReview ? 'На проверке' : order.phaseLabel;
  const tone = order.inReview ? 'review' : order.status === 'cancelled' ? 'cancelled' : order.tone;
  const work = order.works[0];
  return <li>
    <a href={order.href} class={'home-visit visit-tone-' + tone}>
      <span class="home-visit-meta">{dateKinds[order.dateKind]}
        {order.number && <span> · {order.number}</span>}
        {order.isCustom && <span> · Кастомный</span>}
      </span>
      <strong>{order.vehicle}</strong>
      {work && <span class="home-visit-work">{work.name}{order.works.length > 1 && ' +' + (order.works.length - 1)}</span>}
      <span class="home-visit-status">{status}</span>
    </a>
  </li>;
}

function Schedule({ orders, start, today }: { orders: DashboardOrder[]; start: string; today: string }) {
  const byDay = new Map<string, DashboardOrder[]>();
  for (const visit of ordersInWeek(orders, start)) {
    const day = byDay.get(visit.date);
    if (day) day.push(visit);
    else byDay.set(visit.date, [visit]);
  }
  return <section class="home-schedule" aria-label="Расписание заказов">
    <div class="home-schedule-heading"><h2>Расписание заказов</h2><a href="#orders">К журналу заказов</a></div>
    <div class="home-schedule-scroll" role="region" aria-label="Заказы по дням недели" tabIndex={0}>
      <div class="home-schedule-days">{Array.from({length: 7}, (_, i) => {
        const day = shiftDate(start, i);
        const calendarDay = new Date(day + 'T12:00:00Z');
        const visits = byDay.get(day) || [];
        return <section class={'home-schedule-day' + (day === today ? ' is-today' : '')} key={day}>
          <h3><time dateTime={day} aria-current={day === today ? 'date' : undefined}>
            <span>{weekday.format(calendarDay)}</span> {date.format(calendarDay).replace(/\.$/u, '')}
          </time></h3>
          {visits.length ? <ul>{visits.map(visit => <Visit key={visit.key} order={visit} />)}</ul>
            : <span class="home-day-empty" aria-label="Нет заказов">—</span>}
        </section>;
      })}</div>
    </div>
    {!byDay.size && <p class="home-schedule-empty">Заказов на эту неделю пока нет.</p>}
  </section>;
}

export function DashboardHome({ orders }: { orders: DashboardOrder[] }) {
  const today = workshopDay();
  const [selected, select] = useState<string | null>(null);
  const start = selected ?? mondayOf(today);
  return <div class="dashboard-home">
    <DashboardOverview orders={orders} weekStart={start} onWeekChange={select} layout="home" />
    <Schedule orders={orders} start={start} today={today} />
  </div>;
}
