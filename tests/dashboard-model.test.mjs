import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, watch: null, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
after(() => vite.close());
const { dashboardCatalogueTotal, dashboardMetricOrders, dashboardOrders, dashboardScopeHref, dashboardWorkRows,
  matchesOrder, mechanicDashboardOrder, mondayOf, ordersInWeek, parseDashboardScope, shiftDate } =
  await vite.ssrLoadModule('/src/dashboard-model.ts');
const { orderColumns, orderTableCsv, orderTableDefaults, sortTableRows } =
  await vite.ssrLoadModule('/src/dashboard-order-table.ts');

const visit = {
  id: 'visit', order_number: 'Н-12', vehicle: 'Ауди', version: 1, source: 'manager', status: 'published',
  manager_label: 'Пётр', due_date: '2026-11-26', vehicle_workflow: { state: 'review' },
  tasks: [
    { id: 'film', work_name: 'Тонировка', work_code: 'W19', options: { tint_percent: 30 },
      status: 'completed', participants: [{ mechanic_id: 'm', name: 'Саша', status: 'confirmed', confirmed_at: '2026-11-26T21:05:00Z' }] },
    { id: 'other', work_name: 'Бампер', status: 'cancelled', participants: [] },
  ],
};

test('calendar uses the scheduled date, deadline or custom visit date and keeps undated orders reachable', () => {
  const undated = { ...visit, id: 'undated', planned_date: '2026-02-31', due_date: null, status: 'cancelled' };
  const custom = { id: 'visit', visit_date: '2026-11-20', vehicle: 'Форд', status: 'closed' };
  const rows = dashboardOrders([undated, visit], [custom]);
  assert.deepEqual(rows.map(row => [row.key, row.dateKind, row.archived]), [
    ['custom-visit', 'visit', true], ['visit', 'due', false], ['undated', 'none', true],
  ]);
  assert.deepEqual(ordersInWeek(rows, '2026-11-23').map(row => row.key), ['visit']);
  assert.deepEqual(ordersInWeek(rows, null), rows);
  assert.equal(mondayOf('2027-01-01'), '2026-12-28');
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29');
});

test('optional table dates preserve the separate workshop days and sort missing dates last', () => {
  const first = { ...visit, id: 'first', planned_date: '2026-12-28', due_date: '2027-01-04',
    created_at: '2026-12-25T21:00:00Z', closed_at: '2026-12-28T21:00:00Z' };
  const second = { ...visit, id: 'second', planned_date: '2027-01-03', due_date: '2027-01-06',
    created_at: '2026-12-31T21:00:00Z', closed_at: '2027-01-03T21:00:00Z' };
  const custom = { id: 'custom', vehicle: 'Форд', visit_date: '2026-12-27', status: 'closed' };
  const rows = dashboardOrders([second, first], [custom]);
  const dates = ['plannedDate', 'dueDate', 'createdDate', 'closedDate'];
  for (const column of dates) {
    assert(!orderTableDefaults.main.columns.includes(column));
    assert.deepEqual(sortTableRows(rows, { column, direction: 'asc' }, orderColumns).map(row => row.id), ['first', 'second', 'custom']);
    assert.deepEqual(sortTableRows(rows, { column, direction: 'desc' }, orderColumns).map(row => row.id), ['second', 'first', 'custom']);
  }
  assert.deepEqual(orderTableCsv(rows, dates), [
    ['Плановая дата', 'Срок выполнения', 'Дата создания', 'Дата закрытия'],
    ['', '', '', ''],
    ['2026-12-28', '2027-01-04', '2026-12-26', '2026-12-29'],
    ['2027-01-03', '2027-01-06', '2027-01-01', '2027-01-04'],
  ]);
});

test('catalogue amount needs complete standard task rates, excluding cancelled tasks', () => {
  const rates = new Map([['visit', { tasks: [{ task_id: 'film', net_kopeks: 12505 }] }]]);
  const [row] = dashboardOrders([visit], [], rates);
  assert.equal(row.catalogueKopeks, 12505);
  assert.equal(row.inReview, true);
  assert.equal(row.phaseLabel, 'Выполнен');
  assert(matchesOrder(row, '30%') && matchesOrder(row, 'САША') && matchesOrder(row, 'Пётр'));
  assert(!matchesOrder(row, 'Бампер'));
  assert.equal(dashboardOrders([visit], [])[0].catalogueKopeks, null);
  assert.equal(dashboardOrders([visit], [])[0].catalogueRateMissing, false);
  rates.get('visit').tasks[0].net_kopeks = null;
  assert.equal(dashboardOrders([visit], [], rates)[0].catalogueKopeks, null);
  assert.equal(dashboardOrders([visit], [], rates)[0].catalogueRateMissing, true);
});

test('mechanic history follows the Minsk confirmation day and the mechanic route', () => {
  const row = mechanicDashboardOrder(visit, 'history', 'm');
  assert.equal(row.date, '2026-11-27');
  assert.equal(row.dateKind, 'actual');
  assert.equal(row.href, '#history/visit');
  assert.equal(row.catalogueKopeks, null);
});

test('dashboard links carry week, day and metric; valid days override mismatched weeks', () => {
  assert.equal(dashboardScopeHref('2026-11-23', 'works', '2026-11-27'), '#orders?week=2026-11-23&metric=works&day=2026-11-27');
  assert.equal(dashboardScopeHref('2026-11-23', 'review'), '#shift?week=2026-11-23');
  assert.deepEqual(parseDashboardScope('week=2027-01-01&metric=completedWorks'),
    { week: '2026-12-28', day: '', metric: 'completedWorks' });
  assert.deepEqual(parseDashboardScope('week=2026-11-23&day=2026-12-03&metric=closed'),
    { week: '2026-11-30', day: '2026-12-03', metric: 'closed' });
  assert.deepEqual(parseDashboardScope('week=2026-02-31&day=2026-2-03&metric=unknown'),
    { week: '', day: '', metric: 'orders' });
  assert.deepEqual(parseDashboardScope('week=2026-11-27&day=2026-11-31&metric=amount'),
    { week: '2026-11-23', day: '', metric: 'amount' });
});

test('metric contributions retain the same order and work eligibility as the dashboard totals', () => {
  const assisted = { ...visit.tasks[0], participants: [...visit.tasks[0].participants,
    { mechanic_id: 'helper', name: 'Маша', status: 'confirmed' }] };
  const secondWork = { id: 'body', work_name: 'Кузов', status: 'in_progress', assigned_to: 'z', assigned_name: 'Иван' };
  const active = { ...visit, id: 'active', vehicle_workflow: { state: 'active' }, tasks: [assisted, secondWork, visit.tasks[1]] };
  const waiting = { ...active, id: 'waiting', vehicle_workflow: { state: 'review' } };
  const cancelled = { ...active, id: 'cancelled', status: 'cancelled' };
  const custom = { id: 'custom', visit_date: '2026-11-23', vehicle: 'Форд', status: 'closed' };
  const rates = new Map([['active', { tasks: [{ task_id: 'film', net_kopeks: 12500 }, { task_id: 'body', net_kopeks: 0 }] }]]);
  const rows = ordersInWeek(dashboardOrders([active, waiting, cancelled], [custom], rates), '2026-11-23');
  assert.deepEqual(dashboardMetricOrders(rows, 'active').map(o => o.id), ['active']);
  assert.deepEqual(dashboardMetricOrders(rows, 'closed').map(o => o.id), ['custom']);
  assert.equal(dashboardMetricOrders(rows, 'orders').length, 4);
  const amountOrders = dashboardMetricOrders(rows, 'amount');
  assert.deepEqual(dashboardCatalogueTotal(amountOrders), { total: null, missing: 1 });
  assert.deepEqual(dashboardCatalogueTotal(amountOrders.filter(o => o.id === 'active')), { total: 12500, missing: 0 });
  const work = dashboardWorkRows(rows, 'works');
  assert.equal(work.length, 4);
  assert.deepEqual(work.find(row => row.work.id === 'body').work.people.map(person => person.name), ['Иван']);
  assert.deepEqual(dashboardWorkRows(rows, 'completedWorks').map(row => [row.work.id, row.work.people.map(person => person.name)]),
    [['film', ['Саша', 'Маша']], ['film', ['Саша', 'Маша']]]);
});
