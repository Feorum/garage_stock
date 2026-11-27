import { compareOrderDays, orderDay, workshopOrderDay } from './order-calendar';
import { isArchived, orderAuthor, orderPhase, type OwnerOrder } from './owner-model';
import { historyOrderDate, participants, taskName, type Order } from './shift-model';

export interface CustomOrderSummary {
  id: string;
  vehicle: string;
  visit_date: string;
  status: 'open' | 'closed';
}

export type DashboardMetric = 'orders' | 'active' | 'closed' | 'works' | 'completedWorks' | 'amount';
export interface DashboardScope { week: string; day: string; metric: DashboardMetric }

interface DashboardPerson { id: string; name: string; color?: string | null }
interface DashboardWork { id: string; name: string; status: string; people: DashboardPerson[] }
interface DashboardOrderDetails {
  plannedDate: string;
  dueDate: string;
  createdDate: string;
  closedDate: string;
  priority: string;
  instructions: string;
  managerComment: string;
  sourceSheet: string;
}

export interface DashboardOrder {
  id: string;
  key: string;
  href: string;
  isCustom: boolean;
  vehicle: string;
  number: string;
  vin: string;
  colour: string;
  group: string;
  sourceLabel: string;
  manager: string;
  holder: string;
  date: string;
  dateKind: 'planned' | 'due' | 'visit' | 'actual' | 'none';
  status: string;
  phaseLabel: string;
  tone: string;
  inReview: boolean;
  archived: boolean;
  people: DashboardPerson[];
  works: DashboardWork[];
  catalogueKopeks: number | null;
  catalogueRateMissing: boolean;
  details?: DashboardOrderDetails;
}

interface CatalogueRow {
  tasks: { task_id: string; net_kopeks: number | null }[];
}

function standardRow(order: OwnerOrder): DashboardOrder {
  const day = orderDay(order);
  const phase = orderPhase(order);
  const works = order.tasks.filter(task => task.status !== 'cancelled').map(task => ({
    id: task.id, name: taskName(task), status: task.status,
    people: participants(task).map(person => ({ id: person.mechanic_id, name: person.name, color: person.color })),
  }));
  const people = new Map(works.flatMap(work => work.people.map(person => [person.id, person] as const)));
  return {
    id: order.id, key: order.id, href: '#orders/' + encodeURIComponent(order.id),
    isCustom: false, vehicle: order.vehicle, number: order.order_number || '', vin: order.vin || '',
    colour: order.colour || '', group: order.vehicle_group_name || '', sourceLabel: orderAuthor(order),
    manager: order.manager_label || '', holder: order.vehicle_workflow?.holder_name || '',
    date: day, dateKind: !day ? 'none' : day === order.planned_date ? 'planned' : 'due',
    status: order.status, phaseLabel: phase.label, tone: phase.tone, archived: isArchived(order),
    inReview: order.status === 'published' && order.vehicle_workflow?.state === 'review',
    people: [...people.values()],
    works,
    catalogueKopeks: null,
    catalogueRateMissing: false,
  };
}

// The batch price RPC returns frozen catalogue amounts per non-cancelled task.
// An absent task or a missing rate makes the whole order total unknown.
function catalogueAmount(works: DashboardOrder['works'], row?: CatalogueRow) {
  if (!row) return null;
  const rates = new Map(row.tasks.map(task => [task.task_id, task.net_kopeks]));
  let total = 0;
  for (const work of works) {
    const rate = rates.get(work.id);
    if (rate === null) return 'missing';
    if (rate === undefined || !Number.isSafeInteger(rate)) return null;
    total += rate;
  }
  return Number.isSafeInteger(total) ? total : null;
}

function customRow(order: CustomOrderSummary): DashboardOrder {
  const closed = order.status === 'closed';
  const date = orderDay({ planned_date: order.visit_date });
  return {
    id: order.id, key: 'custom-' + order.id, href: '#orders/custom-' + encodeURIComponent(order.id),
    isCustom: true, vehicle: order.vehicle, number: '', vin: '', colour: '', group: '',
    sourceLabel: 'Вы', manager: '', holder: '', date, dateKind: date ? 'visit' : 'none',
    status: order.status, phaseLabel: closed ? 'Закрыт' : 'Открыт', tone: closed ? 'closed' : 'open',
    inReview: false, archived: closed, people: [], works: [], catalogueKopeks: null,
    catalogueRateMissing: false,
  };
}

export function dashboardOrders(
  standard: (OwnerOrder & { created_at?: string | null })[],
  custom: CustomOrderSummary[],
  prices?: ReadonlyMap<string, CatalogueRow> | null,
) {
  const rows = standard.map(order => {
    const row = standardRow(order);
    row.details = {
      plannedDate: orderDay({ planned_date: order.planned_date }),
      dueDate: orderDay({ due_date: order.due_date }),
      createdDate: workshopOrderDay(order.created_at),
      closedDate: workshopOrderDay(order.closed_at),
      priority: order.priority || '',
      instructions: order.instructions || '',
      managerComment: order.manager_comment || '',
      sourceSheet: order.source_name || '',
    };
    const amount = catalogueAmount(row.works, prices?.get(order.id));
    row.catalogueKopeks = typeof amount === 'number' ? amount : null;
    row.catalogueRateMissing = amount === 'missing';
    return row;
  });
  return rows.concat(custom.map(customRow)).sort((a, b) =>
    compareOrderDays(a.date, b.date) || Number(a.isCustom) - Number(b.isCustom) ||
    a.number.localeCompare(b.number, 'ru', { numeric: true }) || a.key.localeCompare(b.key));
}

export function mechanicDashboardOrder(order: Order, section: string, mechanicId: string): DashboardOrder {
  const row = standardRow({ vehicle_group_code: '', ...order });
  row.sourceLabel = order.source === 'manager' ? 'Менеджер' : 'Владелец';
  row.href = '#' + section + '/' + encodeURIComponent(order.id);
  if (section === 'history') {
    const latest = historyOrderDate(order, mechanicId);
    row.date = latest.day;
    if (latest.timestamp) row.dateKind = 'actual';
  }
  return row;
}

// Dates here are workshop calendar days. Arithmetic on UTC midnight avoids
// both the viewer's time zone and daylight-saving transitions.
export function shiftDate(day: string, days: number) {
  if (!orderDay({ planned_date: day })) return '';
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return orderDay({ planned_date: date.toISOString().split('T')[0] });
}

export function mondayOf(day: string) {
  const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
  return shiftDate(day, -((weekday + 6) % 7));
}

export function lastDayOfWeek(weekStart: string) {
  return shiftDate(weekStart, 6) || '9999-12-31';
}

export function ordersInWeek(orders: DashboardOrder[], weekStart: string | null) {
  if (!weekStart) return orders;
  const end = lastDayOfWeek(weekStart);
  return orders.filter(order => order.date >= weekStart && order.date <= end);
}

const metrics = new Set<string>(['orders', 'active', 'closed', 'works', 'completedWorks', 'amount']);

export function parseDashboardScope(query: string): DashboardScope {
  const params = new URLSearchParams(query);
  const day = orderDay({ planned_date: params.get('day') });
  const date = day || orderDay({ planned_date: params.get('week') });
  const metric = params.get('metric') || '';
  return { week: date ? mondayOf(date) : '', day, metric: metrics.has(metric) ? metric as DashboardMetric : 'orders' };
}

export function dashboardScopeHref(week: string, metric: DashboardMetric | 'review', day = '') {
  const params = new URLSearchParams({ week });
  if (metric === 'review') return '#shift?' + params;
  params.set('metric', metric);
  if (day) params.set('day', day);
  return '#orders?' + params;
}

function contributesCatalogue(order: DashboardOrder) {
  return !order.isCustom && order.status !== 'cancelled';
}

export function dashboardMetricOrders(orders: DashboardOrder[], metric: DashboardMetric) {
  switch (metric) {
    case 'active': return orders.filter(order => order.tone === 'active' && !order.inReview);
    case 'closed': return orders.filter(order => order.status === 'closed');
    case 'amount': return orders.filter(contributesCatalogue);
    default: return orders;
  }
}

export function dashboardWorkRows(orders: DashboardOrder[], metric: 'works' | 'completedWorks') {
  return orders.filter(contributesCatalogue).flatMap(order => order.works
    .filter(work => work.status !== 'cancelled' && (metric === 'works' || work.status === 'completed'))
    .map(work => ({ order, work })));
}

export function dashboardCatalogueTotal(orders: DashboardOrder[]) {
  const missing = orders.filter(order => !Number.isSafeInteger(order.catalogueKopeks)).length;
  const sum = orders.reduce((total, order) => total + (order.catalogueKopeks ?? 0), 0);
  return { missing, total: missing || !Number.isSafeInteger(sum) ? null : sum };
}

export function matchesOrder(order: DashboardOrder, query: string) {
  const needle = query.trim().toLocaleLowerCase('ru-RU');
  return !needle || [
    order.vehicle, order.number, order.vin, order.colour, order.group, order.sourceLabel,
    order.manager, order.holder, order.phaseLabel, order.date, order.date.split('-').reverse().join('.'),
    order.isCustom ? 'Кастомный' : 'Стандарт', ...order.people.map(person => person.name),
    ...order.works.map(work => work.name),
  ].some(value => value?.toLocaleLowerCase('ru-RU').includes(needle));
}
