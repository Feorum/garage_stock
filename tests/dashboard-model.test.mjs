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
const { dashboardOrders, matchesOrder, mechanicDashboardOrder, mondayOf, ordersInWeek, shiftDate } =
  await vite.ssrLoadModule('/src/dashboard-model.ts');

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

test('catalogue amount needs complete standard task rates, excluding cancelled tasks', () => {
  const rates = new Map([['visit', { tasks: [{ task_id: 'film', net_kopeks: 12505 }] }]]);
  const [row] = dashboardOrders([visit], [], rates);
  assert.equal(row.catalogueKopeks, 12505);
  assert.equal(row.inReview, true);
  assert.equal(row.phaseLabel, 'Выполнен');
  assert(matchesOrder(row, '30%') && matchesOrder(row, 'САША') && matchesOrder(row, 'Пётр'));
  assert(!matchesOrder(row, 'Бампер'));
  assert.equal(dashboardOrders([visit], [])[0].catalogueKopeks, null);
  rates.get('visit').tasks[0].net_kopeks = null;
  assert.equal(dashboardOrders([visit], [], rates)[0].catalogueKopeks, null);
});

test('mechanic history follows the Minsk confirmation day and the mechanic route', () => {
  const row = mechanicDashboardOrder(visit, 'history', 'm');
  assert.equal(row.date, '2026-11-27');
  assert.equal(row.dateKind, 'actual');
  assert.equal(row.href, '#history/visit');
  assert.equal(row.catalogueKopeks, null);
});
