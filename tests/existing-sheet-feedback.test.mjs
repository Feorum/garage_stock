// Synthetic rows and mocked services only; no production spreadsheet writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackRows, feedbackSummary, managerComments, normalizeFeedbackCsv, publicFeedback, unchangedScopeKeys } from '../supabase/functions/pull-manager-sheets/feedback.ts';
import { parseExistingSheetCsv } from '../supabase/functions/pull-manager-sheets/parser.ts';
import { runFeed } from '../supabase/functions/pull-manager-sheets/engine.ts';
import { createPullHandler } from '../supabase/functions/pull-manager-sheets/handler.ts';

const HEADERS = ['Столбец 1', 'День', 'Менеджер', 'Автомобиль', 'VIN', 'Цвет', 'Оклейка', 'Тонировка', 'Готовность', 'Примечание'];
const KEY = '2026-11-13|TEST0000000000001';
const SOURCE = '11111111-1111-4111-8111-111111111111', LEASE = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const SHEET = 'SyntheticCopyWorkbook0000000000001', SECRET = 'synthetic_private_source_01234567890123456789';
const BLOCK = '[Garage G-000001]\nкапот полностью: Synthetic mechanic — completed\n[/Garage]';
function row(changes = {}) {
  const values = ['13.11.2026', '', 'Synthetic manager', 'S50', 'TEST0000000000001', 'Grey', 'W01', '', 'FALSE', ''];
  for (const [key, value] of Object.entries(changes)) values[Number(key)] = value;
  return values;
}
const cell = value => /[\r\n,"]/.test(String(value)) ? '"' + String(value).replaceAll('"', '""') + '"' : String(value);
const csv = (...rows) => [HEADERS, ...rows].map(values => values.map(cell).join(',')).join('\r\n');
function output(changes = {}) {
  return { order_id: ORDER, order_number: 'G-000001', order_version: 4, source_keys: [KEY], complete: true,
    block: BLOCK, known_outputs: [{ block: BLOCK, complete: true }], ...changes };
}
function scope(parsed) {
  const { instructions, ...order } = parsed.rows[0].order;
  return { order, tasks: parsed.rows[0].tasks };
}

test('verified completion output round-trips without becoming Manager instructions or a checkbox command', () => {
  const text = csv(row({ 8: 'TRUE', 9: 'Preparation note\n\n' + BLOCK }));
  const parsed = normalizeFeedbackCsv(text, [output()]);
  assert.equal(parsed.rows[0].state, 'ready');
  assert.equal(parsed.rows[0].raw.notes, 'Preparation note');
  assert.equal(parsed.rows[0].raw.completion, 'FALSE');
  assert.equal(parsed.rows[0].manager_comment, 'Preparation note');
  assert.ok(!parsed.rows[0].issues.includes('SOURCE_PROGRESS_REQUIRES_REVIEW'));
});

test('arbitrary or edited completion markers remain untrusted source text', () => {
  for (const notes of [BLOCK.replace('Synthetic mechanic', 'Another person'), BLOCK + '\nManager addition']) {
    const parsed = normalizeFeedbackCsv(csv(row({ 9: notes })), [output()]);
    assert.equal(parsed.rows[0].raw.notes, notes);
    assert.ok(parsed.rows[0].issues.includes('SOURCE_PROGRESS_REQUIRES_REVIEW'));
  }
});

test('a completion block copied from another source identity cannot mask source instructions', () => {
  const parsed = normalizeFeedbackCsv(csv(row({ 9: BLOCK })), [output({ source_keys: ['2026-11-14|TEST0000000000001'] })]);
  assert.equal(parsed.rows[0].raw.notes, BLOCK);
  assert.ok(parsed.rows[0].issues.includes('SOURCE_PROGRESS_REQUIRES_REVIEW'));
});

test('old issued versions are recognized exactly, without stripping an unissued suffix', () => {
  const old = BLOCK.replace('Synthetic mechanic', 'Previous recorded mechanic');
  const feedback = output({ known_outputs: [{ block: old, complete: true }, { block: BLOCK, complete: true }] });
  assert.equal(normalizeFeedbackCsv(csv(row({ 8: 'TRUE', 9: old })), [feedback]).rows[0].raw.notes, '');
  assert.equal(normalizeFeedbackCsv(csv(row({ 9: BLOCK.replace('completed', 'pending') })), [feedback]).rows[0].raw.notes,
    BLOCK.replace('completed', 'pending'));
});

test('partial output never permits a manually checked box to impersonate completion', async () => {
  const feedback = output({ complete: false, known_outputs: [{ block: BLOCK, complete: false }] });
  const parsed = normalizeFeedbackCsv(csv(row({ 8: 'TRUE', 9: BLOCK })), [feedback]);
  assert.equal(parsed.rows[0].state, 'completed');
  assert.equal(parsed.rows[0].raw.completion, 'TRUE');
  assert.deepEqual(await publicFeedback(csv(row({ 8: 'TRUE', 9: BLOCK })), [feedback]), []);
  assert.deepEqual(await publicFeedback(csv(row({ 8: 'TRUE' })), [output()]), []);
  assert.deepEqual(await publicFeedback(csv(row({ 8: '' })), [output()]), []);
});

test('duplicate rows and overlapping source aliases suppress every write locator', async () => {
  const duplicate = csv(row({ 9: BLOCK }), row({ 9: BLOCK }));
  assert.deepEqual(await publicFeedback(duplicate, [output()]), []);
  assert.equal(normalizeFeedbackCsv(duplicate, [output()]).rows[0].raw.notes, BLOCK);
  const other = output({ order_id: '44444444-4444-4444-8444-444444444444', order_number: 'G-000002' });
  assert.deepEqual(await publicFeedback(csv(row()), [output(), other]), []);
  const aliases = output({ source_keys: [KEY, '2026-11-14|TEST0000000000001'] });
  assert.deepEqual(await publicFeedback(csv(row(), row({ 0: '14.11.2026' })), [aliases]), []);
  assert.deepEqual(managerComments(parseExistingSheetCsv(csv(row({ 9: 'First note' }),
    row({ 0: '14.11.2026', 9: 'Different note' }))), [aliases]), []);
});

test('output locator preserves raw A:J bytes, follows source sorting, and excludes private backend fields', async () => {
  const original = row({ 2: ' Synthetic manager ', 9: 'Private source note' });
  const extra = row({ 4: 'TEST0000000000002' });
  const feedback = output({ operational_scope: { secret: 'PRIVATE_SCOPE' }, price: 999, manager_notes: 'PRIVATE_NOTE' });
  const result = await publicFeedback(csv(extra, original), [feedback]);
  assert.equal(result.length, 1); assert.equal(result[0].row_number, 3); assert.equal(result[0].source_key, KEY);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(original)));
  assert.equal(result[0].observation_hash, Buffer.from(digest).toString('hex'));
  const serialized = JSON.stringify(result);
  for (const value of ['PRIVATE_SCOPE', 'PRIVATE_NOTE', 'Private source note', '999']) assert.ok(!serialized.includes(value));
});

test('feedback ledger responses fail closed if source keys, versions or issued output do not match', () => {
  assert.equal(feedbackRows({ version: 4, rows: [output()] }, 4).length, 1);
  for (const value of [null, { version: 5, rows: [] }, { version: 4, rows: [output({ known_outputs: [] })] },
    { version: 4, rows: [output({ source_keys: ['other'] })] }, { version: 4, rows: [output(), output()] }]) {
    assert.throws(() => feedbackRows(value, 4), /INVALID_FEEDBACK/);
  }
});

test('feedback health confirms only an exact current block and completion flag observed on a later read', async () => {
  const before = csv(row());
  assert.deepEqual(feedbackSummary(before, await publicFeedback(before, [output()])), { feedback_confirmed: 0, feedback_pending: 1 });
  const after = csv(row({ 8: 'TRUE', 9: 'Original note\n\n' + BLOCK }));
  assert.deepEqual(feedbackSummary(after, await publicFeedback(after, [output()])), { feedback_confirmed: 1, feedback_pending: 0 });
  const old = BLOCK.replace('Synthetic mechanic', 'Prior name');
  const stale = csv(row({ 8: 'TRUE', 9: old }));
  const feedback = output({ known_outputs: [{ block: old, complete: true }, { block: BLOCK, complete: true }] });
  assert.deepEqual(feedbackSummary(stale, await publicFeedback(stale, [feedback])), { feedback_confirmed: 0, feedback_pending: 1 });
});

test('Manager comments keep catalogue tasks unchanged and confidential notes stay Owner-only', () => {
  const parsed = parseExistingSheetCsv(csv(row({ 6: 'W01; W13\nComment: Call before starting' })));
  assert.deepEqual(parsed.rows[0].tasks.map(task => task.work_code), ['W01', 'W13']);
  assert.ok(managerComments(parsed)[0].comment.includes('Call before starting'));
  const privateRow = parseExistingSheetCsv(csv(row({ 6: 'W01; price 120 BYN' })));
  assert.deepEqual(managerComments(privateRow), []);
  assert.equal(privateRow.rows[0].manager_comment, '');
});

test('explicit free-form comment lines cannot consume selected works or select catalogue-looking text', () => {
  const parsed = parseExistingSheetCsv(csv(row({ 6: 'W01; W13\nComment: W10, call first (details to follow' })));
  assert.equal(parsed.rows[0].state, 'ready');
  assert.deepEqual(parsed.rows[0].tasks.map(task => task.work_code), ['W01', 'W13']);
  assert.ok(parsed.rows[0].manager_comment.includes('W10, call first (details to follow'));
  const local = parseExistingSheetCsv(csv(row({ 6: 'W01\nКомментарий: осмотреть (перед началом' })));
  assert.equal(local.rows[0].state, 'ready'); assert.equal(local.rows[0].tasks.length, 1);
});

test('comments on Owner-interpreted free writing remain independently available', () => {
  const parsed = parseExistingSheetCsv(csv(row({ 6: '(W01; extra context', 9: 'Call the manager before delivery' })));
  assert.equal(parsed.rows[0].state, 'review');
  assert.ok(managerComments(parsed)[0].comment.includes('Call the manager before delivery'));
  assert.deepEqual(managerComments(parseExistingSheetCsv(csv(row(), row()))), []);
});

test('only an exact authoritative operational scope qualifies as a comment-only change', () => {
  const original = parseExistingSheetCsv(csv(row({ 9: 'Original comment' })));
  const feedback = output({ operational_scope: scope(original) });
  const updated = parseExistingSheetCsv(csv(row({ 9: 'New delivery detail' })));
  assert.deepEqual(unchangedScopeKeys(updated, [feedback]), [KEY]);
  assert.deepEqual(unchangedScopeKeys(parseExistingSheetCsv(csv(row({ 6: 'W01; W13' }))), [feedback]), []);
  assert.deepEqual(unchangedScopeKeys(parseExistingSheetCsv(csv(row({ 9: '[W01] New task instruction' }))), [feedback]), []);
});

test('a comment-only update after acceptance does not amend tasks or create ORDER_CHANGED', async () => {
  let version = 1, sequence = 0;
  const parsed = parseExistingSheetCsv(csv(row()));
  const feed = { source_id: SOURCE, spreadsheet_id: SHEET, version, state: {} };
  const dependencies = { quietPeriodMs: 0, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    checkpoint: async (_state, expected) => { assert.equal(expected, version); return ++version; },
    ingest: async payload => ({ status: 'accepted', submission_id: payload.submission_id, external_order_id: payload.external_order_id,
      revision: payload.revision, order_version: 1, order_number: 'G-000001' }) };
  const accepted = await runFeed(feed, parsed, dependencies);
  const updated = parseExistingSheetCsv(csv(row({ 6: 'W01\nComment: Later Manager detail' })));
  const result = await runFeed({ ...feed, state: accepted.state, version: accepted.version }, updated, { ...dependencies,
    unchangedScopeKeys: [KEY], ingest: () => { throw new Error('A comment must not amend task definitions'); } });
  assert.equal(result.summary.pending_deliveries, 0); assert.deepEqual(result.review, []);
});

function handlerSetup(options = {}) {
  const calls = [], json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const feed = { source_id: SOURCE, spreadsheet_id: SHEET, sheet_gid: '12345', adapter: 'alfort_v1', version: 1,
    lease_token: LEASE, credential: SECRET, state: {}, summary: {}, review: [] };
  const handler = createPullHandler({ supabaseUrl: 'https://synthetic.example.invalid', serviceRoleKey: 'PRIVATE_SERVICE', schedulerSecret: SECRET,
    fetchImpl: async (url, init) => {
      const name = String(url).split('/').pop(), args = JSON.parse(init.body); calls.push({ name, args });
      if (name === 'garage_acquire_sheet_reader') return json(feed);
      if (name === 'garage_sheet_feedback') return json({ version: options.badVersion ? 99 : args.p_expected_version, rows: [output()] });
      if (name === 'garage_capture_manager_rows') return json({ version: args.p_expected_version, owner_managed_keys: [KEY], owner_managed_rows: [2] });
      if (name === 'garage_sync_manager_comments') return json({ version: args.p_expected_version, updated: 1 });
      if (name === 'garage_commit_sheet_pull') return json({ version: args.p_expected_version + 1 });
      throw new Error('Unexpected mutation ' + name);
    } });
  const request = body => new Request('https://edge.example.invalid/functions/v1/pull-manager-sheets/source', {
    method: 'POST', headers: { Authorization: `Bearer ${SOURCE}.${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ spreadsheet_id: SHEET, sheet_gid: '12345', protocol: 'feedback_v1', ...body }) });
  return { handler, calls, request };
}

test('upgraded private reader updates comments and receives only source-bound safe completion locators', async () => {
  const { handler, calls, request } = handlerSetup();
  const response = await handler(request({ csv: csv(row({ 6: 'W01\nComment: Later detail', 8: 'TRUE', 9: BLOCK })) }));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.protocol, 'feedback_v1'); assert.equal(result.feedback[0].source_key, KEY);
  const capture = calls.find(call => call.name === 'garage_capture_manager_rows');
  assert.equal(capture.args.p_rows[0].raw.notes, ''); assert.equal(capture.args.p_rows[0].raw.completion, 'FALSE');
  assert.ok(calls.find(call => call.name === 'garage_sync_manager_comments').args.p_comments[0].comment.includes('Later detail'));
  assert.ok(!calls.some(call => call.name === 'garage_ingest_sheet'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SERVICE')); assert.equal(result.feedback[0].row_number, 2);
  const commit = calls.find(call => call.name === 'garage_commit_sheet_pull');
  assert.equal(commit.args.p_summary.feedback_confirmed, 1); assert.equal(commit.args.p_summary.feedback_pending, 0);
});

test('an invalid feedback ledger prevents capture, replay and completion writes', async () => {
  const { handler, calls, request } = handlerSetup({ badVersion: true });
  const response = await handler(request({ csv: csv(row()) }));
  assert.equal(response.status, 503); const result = await response.json();
  assert.equal(result.feedback, undefined); assert.ok(!calls.some(call => call.name === 'garage_capture_manager_rows'));
});

test('unknown write-back protocol is rejected before source acquisition', async () => {
  const { handler, calls, request } = handlerSetup();
  assert.equal((await handler(request({ csv: csv(row()), protocol: 'untrusted_future_protocol' }))).status, 400);
  assert.equal(calls.length, 0);
});
