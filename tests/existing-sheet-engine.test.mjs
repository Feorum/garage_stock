// Synthetic records only: no network or operational vehicle/Manager data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFeed } from '../supabase/functions/pull-manager-sheets/engine.ts';

const VIN = 'ABCDEFGHIJKLMNPQR';
const DATE = '2026-11-01';
const SOURCE = '11111111-1111-4111-8111-111111111111';
function row({ vin = VIN, date = DATE, number = 2, state = 'ready', work = 'W01', tint, vehicle = 'Synthetic vehicle', instructions = '', issues = [] } = {}) {
  return { row_number: number, source_key: `${date}|${vin}`, state,
    source: { vin, planned_date: date, vehicle },
    order: { vehicle, vin, colour: 'Synthetic colour', vehicle_group_code: 'VG02', planned_date: date,
      due_date: null, priority: 'normal', manager_label: 'Synthetic Manager', instructions },
    tasks: [{ task_key: work + (tint ? ':' + tint : ''), work_code: work,
      options: tint ? { tint_percent: tint } : {}, instructions: '' }], issues };
}
function parsed(rows) { return { parser_version: 1, rows, summary: { ready: rows.filter(r => r.state === 'ready').length } }; }
function feed(state = {}) { return { source_id: SOURCE, spreadsheet_id: 'synthetic-existing-sheet', state, version: 1 }; }
function accepted(payload, overrides = {}) {
  return { status: 'accepted', submission_id: payload.submission_id, external_order_id: payload.external_order_id,
    revision: payload.revision, order_version: payload.revision, order_number: 'G-000001', ...overrides };
}
function setup({ state = {}, startVersion = 1, ingest, crashCheckpoint } = {}) {
  let serial = 0, version = startVersion, durable = structuredClone(state);
  const calls = [], saved = [];
  const deps = {
    quietPeriodMs: 0,
    uuid: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
    checkpoint: async (next, expected) => {
      assert.equal(expected, version);
      if (crashCheckpoint) throw new Error('Synthetic checkpoint failure');
      durable = structuredClone(next); saved.push(durable); return ++version;
    },
    ingest: async payload => { calls.push(structuredClone(payload)); return ingest ? await ingest(payload) : accepted(payload); },
  };
  return { calls, saved, deps, durable: () => durable, version: () => version };
}

test('new ready request is durable before delivery and ack is saved separately', async () => {
  const s = setup({ ingest: payload => {
    const snapshot = Object.values(s.durable().entries)[0].pending.payload;
    assert.deepEqual(snapshot, payload);
    return accepted(payload);
  } });
  const result = await runFeed(feed(), parsed([row()]), s.deps);
  assert.equal(s.calls.length, 1); assert.equal(s.saved.length, 2);
  assert.equal(result.summary.accepted_orders, 1); assert.equal(result.summary.accepted_this_run, 1);
  assert.equal(result.review.length, 0);
  assert.equal(s.calls[0].action, 'submit');
  assert.equal(s.calls[0].expected_order_version, null);
  assert.equal(s.calls[0].revision, 1);
});

test('checkpoint failure prevents all outbound delivery', async () => {
  const s = setup({ crashCheckpoint: true });
  await assert.rejects(runFeed(feed(), parsed([row()]), s.deps), /checkpoint/);
  assert.equal(s.calls.length, 0);
});

test('timeout and lost acknowledgement retry immutable body after a restart', async () => {
  const a = setup({ ingest: () => { throw new Error('Synthetic lost response'); } });
  const first = await runFeed(feed(), parsed([row()]), a.deps);
  assert.equal(first.summary.pending_deliveries, 1);
  const durable = a.durable(); // Includes snapshot, before the failed response.
  const b = setup({ state: durable, startVersion: a.version() });
  await runFeed({ ...feed(durable), version: a.version() }, parsed([row()]), b.deps);
  assert.equal(b.calls.length, 1); assert.deepEqual(b.calls[0], a.calls[0]);
});

test('sorting and same exact inputs do not create another order or revision', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ number: 47 })]), b.deps);
  assert.equal(b.calls.length, 0); assert.equal(result.summary.accepted_orders, 1);
  assert.equal(Object.values(result.state.entries)[0].row_number, 47);
});

test('unchanged tasks retain IDs, material options get new IDs and next revision', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row({ work: 'W19', tint: 5 })]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ work: 'W19', tint: 5, instructions: 'Synthetic note' })]), b.deps);
  assert.equal(b.calls[0].revision, 2); assert.equal(b.calls[0].expected_order_version, 1);
  assert.equal(b.calls[0].tasks[0].external_task_id, a.calls[0].tasks[0].external_task_id);
  // UUID generators model independent restarts, using a distinct namespace.
  let serial = 500;
  b.deps.uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const c = setup({ state: first.state, startVersion: first.version }); c.deps.uuid = b.deps.uuid;
  await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ work: 'W19', tint: 15 })]), c.deps);
  assert.notEqual(c.calls[0].tasks[0].external_task_id, a.calls[0].tasks[0].external_task_id);
});

test('durable pending delivery precedes a newly edited input and uses accepted version', async () => {
  const a = setup({ ingest: () => { throw new Error('Synthetic timeout'); } });
  const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  let serial = 100; b.deps.uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ instructions: 'Changed request' })]), b.deps);
  assert.equal(b.calls.length, 2); assert.deepEqual(b.calls[0], a.calls[0]);
  assert.equal(b.calls[1].revision, 2); assert.equal(b.calls[1].expected_order_version, 1);
});

test('CSV failure drain-only mode still acknowledges an existing immutable delivery', async () => {
  const a = setup({ ingest: () => { throw new Error('Synthetic timeout'); } });
  const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, null, b.deps);
  assert.equal(b.calls.length, 1); assert.deepEqual(b.calls[0], a.calls[0]);
  assert.equal(result.summary.accepted_orders, 1);
});

test('completed history never creates pending work and cannot later reopen silently', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row({ state: 'completed' })]), a.deps);
  assert.equal(a.calls.length, 0);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([row()]), b.deps);
  assert.equal(b.calls.length, 0); assert.deepEqual(result.review[0].reason_codes, ['COMPLETED_HISTORY_REOPENED']);
});

test('checking an imported row requests review and never emits task completion/cancellation', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ state: 'completed' })]), b.deps);
  assert.equal(b.calls.length, 0); assert.deepEqual(result.review[0].reason_codes, ['SOURCE_MARKED_COMPLETED']);
  assert.equal(result.summary.accepted_orders, 1);
});

test('duplicate same-day vehicle rows block requests including mixed history', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row(), row({ number: 3, state: 'completed' })]), a.deps);
  assert.equal(a.calls.length, 0); assert.equal(first.review.length, 2);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([row()]), b.deps);
  assert.equal(b.calls.length, 0); assert.deepEqual(result.review[0].reason_codes, ['COMPLETED_HISTORY_REOPENED']);
});

test('same VIN on separate dates remains distinct when both visits exist', async () => {
  const s = setup(); const result = await runFeed(feed(), parsed([row(), row({ date: '2026-11-02', number: 3 })]), s.deps);
  assert.equal(s.calls.length, 2); assert.equal(result.summary.accepted_orders, 2);
  assert.notEqual(s.calls[0].external_order_id, s.calls[1].external_order_id);
});

test('changed date replacing a previous visit is held rather than duplicated', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ date: '2026-11-03' })]), b.deps);
  assert.equal(b.calls.length, 0); assert.deepEqual(result.review[0].reason_codes, ['SOURCE_IDENTITY_CHANGED']);
});

test('changed VIN plausibly replacing an absent registered same-date vehicle requires review', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ vin: 'SYNTHETICVIN00001', vehicle: '  SYNTHETIC   VEHICLE  ' })]), b.deps);
  assert.equal(b.calls.length, 0); assert.deepEqual(result.review[0].reason_codes, ['SOURCE_IDENTITY_CHANGED']);
});

test('new VIN is a new request when earlier same-date vehicle remains in source', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  let serial = 800; b.deps.uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([row(), row({ vin: 'SYNTHETICVIN00001', number: 3 })]), b.deps);
  assert.equal(b.calls.length, 1); assert.equal(result.summary.accepted_orders, 2);
  assert.equal(result.review.length, 0);
});

test('removing a row never emits cancellation or erases known identity', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([]), b.deps);
  assert.equal(b.calls.length, 0); assert.equal(Object.keys(result.state.entries).length, 1);
});

test('app-progress conflict persists for Owner review without repeated submissions', async () => {
  const a = setup({ ingest: payload => ({ status: 'conflict', submission_id: payload.submission_id,
    external_order_id: payload.external_order_id, revision: payload.revision, error: { code: 'ORDER_CHANGED' } }) });
  const first = await runFeed(feed(), parsed([row()]), a.deps);
  assert.deepEqual(first.review[0].reason_codes, ['ORDER_CHANGED']);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ instructions: 'Still edited' })]), b.deps);
  assert.equal(b.calls.length, 0); assert.equal(result.summary.accepted_orders, 0);
});

test('corrected validation rejection can capture a new body without advancing accepted revision', async () => {
  const a = setup({ ingest: () => ({ status: 'rejected', error: { code: 'VALIDATION_FAILED' } }) });
  const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  let serial = 700; b.deps.uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ instructions: 'Corrected body' })]), b.deps);
  assert.equal(b.calls.length, 1); assert.equal(b.calls[0].revision, 1);
  assert.equal(b.calls[0].external_order_id, a.calls[0].external_order_id);
  assert.notEqual(b.calls[0].submission_id, a.calls[0].submission_id);
});

test('invalid or mismatched receipt remains pending rather than inventing acceptance', async () => {
  const s = setup({ ingest: payload => accepted(payload, { revision: 999 }) });
  const result = await runFeed(feed(), parsed([row()]), s.deps);
  assert.equal(result.summary.accepted_orders, 0); assert.equal(result.summary.pending_deliveries, 1);
});

test('source paused/unavailable response remains retryable with the same body', async () => {
  const a = setup({ ingest: () => ({ status: 'rejected', error: { code: 'SOURCE_UNAVAILABLE' } }) });
  const first = await runFeed(feed(), parsed([row()]), a.deps);
  assert.equal(first.summary.pending_deliveries, 1);
  const b = setup({ state: first.state, startVersion: first.version });
  await runFeed({ ...feed(first.state), version: first.version }, parsed([row()]), b.deps);
  assert.deepEqual(b.calls[0], a.calls[0]);
});

test('identity correction of a review-only row is allowed before any request was captured', async () => {
  const a = setup();
  const first = await runFeed(feed(), parsed([row({ state: 'review', issues: ['unsupported_scope'] })]), a.deps);
  assert.equal(a.calls.length, 0);
  const b = setup({ state: first.state, startVersion: first.version });
  const result = await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ date: '2026-11-03' })]), b.deps);
  assert.equal(b.calls.length, 1); assert.equal(result.summary.accepted_orders, 1);
});

test('parser review issues are normalized and never submitted', async () => {
  const s = setup(); const result = await runFeed(feed(), parsed([row({ state: 'review', issues: ['tint_percentage_required'] })]), s.deps);
  assert.equal(s.calls.length, 0); assert.deepEqual(result.review[0].reason_codes, ['TINT_PERCENTAGE_REQUIRED']);
});

test('per-run delivery cap leaves the rest durable for future triggers', async () => {
  const s = setup(); const rows = Array.from({ length: 22 }, (_, i) => row({ vin: 'SYNTHETIC' + String(i).padStart(8, '0'), number: i + 2 }));
  const result = await runFeed(feed(), parsed(rows), s.deps);
  assert.equal(s.calls.length, 20); assert.equal(result.summary.pending_deliveries, 2);
  assert.equal(Object.values(s.saved[0].entries).filter(e => e.pending).length, 22);
});

test('unrecognized/corrupt private state fails closed', async () => {
  const s = setup();
  await assert.rejects(runFeed(feed({ schema_version: 99, entries: {} }), parsed([row()]), s.deps), /INVALID_PULL_STATE/);
  assert.equal(s.calls.length, 0);
});


test('default auto-import waits for two unchanged valid polls at least sixty seconds apart', async () => {
  const a = setup(); delete a.deps.quietPeriodMs; a.deps.now = () => 1000;
  const first = await runFeed(feed(), parsed([row()]), a.deps);
  assert.equal(a.calls.length, 0); assert.equal(first.summary.awaiting_stability, 1);
  assert.equal(first.review.length, 0);
  const b = setup({ state: first.state, startVersion: first.version });
  delete b.deps.quietPeriodMs; b.deps.now = () => 60999;
  const early = await runFeed({ ...feed(first.state), version: first.version }, parsed([row()]), b.deps);
  assert.equal(b.calls.length, 0); assert.equal(early.summary.awaiting_stability, 1);
  const c = setup({ state: early.state, startVersion: early.version });
  delete c.deps.quietPeriodMs; c.deps.now = () => 61000;
  const stable = await runFeed({ ...feed(early.state), version: early.version }, parsed([row({ number: 88 })]), c.deps);
  assert.equal(c.calls.length, 1); assert.equal(stable.summary.awaiting_stability, 0);
  assert.equal(stable.summary.accepted_orders, 1);
});

test('another valid multi-select edit restarts the automatic quiet window', async () => {
  const a = setup(); delete a.deps.quietPeriodMs; a.deps.now = () => 1000;
  const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  delete b.deps.quietPeriodMs; b.deps.now = () => 62000;
  const edited = await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ work: 'W02' })]), b.deps);
  assert.equal(b.calls.length, 0); assert.equal(edited.summary.awaiting_stability, 1);
  assert.equal(Object.values(edited.state.entries)[0].candidate.first_seen_at, 62000);
  const c = setup({ state: edited.state, startVersion: edited.version });
  delete c.deps.quietPeriodMs; c.deps.now = () => 122000;
  await runFeed({ ...feed(edited.state), version: edited.version }, parsed([row({ work: 'W02' })]), c.deps);
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].tasks[0].work_code, 'W02');
});

test('parser review and source removal reset a prior stable candidate', async () => {
  const a = setup(); delete a.deps.quietPeriodMs; a.deps.now = () => 1000;
  const first = await runFeed(feed(), parsed([row()]), a.deps);
  for (const rows of [[row({ state: 'review', issues: ['unknown_work'] })], []]) {
    const b = setup({ state: first.state, startVersion: first.version });
    delete b.deps.quietPeriodMs; b.deps.now = () => 62000;
    const invalid = await runFeed({ ...feed(first.state), version: first.version }, parsed(rows), b.deps);
    assert.equal(Object.values(invalid.state.entries)[0].candidate, undefined);
    const c = setup({ state: invalid.state, startVersion: invalid.version });
    delete c.deps.quietPeriodMs; c.deps.now = () => 123000;
    const restored = await runFeed({ ...feed(invalid.state), version: invalid.version }, parsed([row()]), c.deps);
    assert.equal(c.calls.length, 0); assert.equal(restored.summary.awaiting_stability, 1);
  }
});

test('an amendment waits for stability while an existing durable retry drains immediately', async () => {
  const a = setup(); const first = await runFeed(feed(), parsed([row()]), a.deps);
  const b = setup({ state: first.state, startVersion: first.version });
  delete b.deps.quietPeriodMs; b.deps.now = () => 1000;
  const amended = await runFeed({ ...feed(first.state), version: first.version }, parsed([row({ work: 'W02' })]), b.deps);
  assert.equal(b.calls.length, 0); assert.equal(amended.summary.awaiting_stability, 1);
  const c = setup({ state: amended.state, startVersion: amended.version, ingest: () => { throw new Error('Synthetic timeout'); } });
  delete c.deps.quietPeriodMs; c.deps.now = () => 61000;
  const pending = await runFeed({ ...feed(amended.state), version: amended.version }, parsed([row({ work: 'W02' })]), c.deps);
  assert.equal(c.calls.length, 1); assert.equal(pending.summary.pending_deliveries, 1);
  const d = setup({ state: pending.state, startVersion: pending.version });
  delete d.deps.quietPeriodMs; d.deps.now = () => 61001;
  const result = await runFeed({ ...feed(pending.state), version: pending.version }, parsed([row({ work: 'W02' })]), d.deps);
  assert.equal(d.calls.length, 1); assert.deepEqual(d.calls[0], c.calls[0]);
  assert.equal(result.summary.accepted_orders, 1);
});
