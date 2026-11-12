// Synthetic boundary tests. No Google or Supabase requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPullHandler, readGoogleCsv } from '../supabase/functions/pull-manager-sheets/handler.ts';

const SECRET = 'synthetic_private_schedule_01234567890123456789';
const READER = 'synthetic_private_source_01234567890123456789';
const SERVICE = 'synthetic_service_role_key';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const SHEET = 'SyntheticCopyWorkbook0000000000001';
const URL = 'https://db.example.invalid';
const EDGE = 'https://edge.example.invalid/functions/v1/pull-manager-sheets';
const HEADER = 'Столбец 1,День,Менеджер,Автомобиль,VIN,Цвет,Оклейка,Тонировка,Готовность,Примечание';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const feed = overrides => ({ source_id: SOURCE, spreadsheet_id: SHEET, sheet_gid: '12345', adapter: 'alfort_v1',
  version: 1, lease_token: LEASE, credential: READER, state: {}, summary: {}, review: [], ...overrides });
function setup(options = {}) {
  const calls = [];
  const handler = createPullHandler({ supabaseUrl: URL, serviceRoleKey: SERVICE, schedulerSecret: SECRET,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const name = String(url).split('/').pop();
      if (String(url).startsWith('https://docs.google.com/')) return new Response(options.csv ?? HEADER, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
      if (name === 'garage_acquire_sheet_pulls') return json(options.feeds ?? [feed()]);
      if (name === 'garage_acquire_sheet_reader') return options.authError ? json({ code: '42501', message: 'PRIVATE_DATABASE_TRACE' }, 403) : json(options.readerFeed === null ? null : options.readerFeed || feed());
      if (name === 'garage_checkpoint_sheet_pull' || name === 'garage_commit_sheet_pull') return json({ version: JSON.parse(init.body).p_expected_version + 1 });
      throw new Error('Unexpected request ' + String(url));
    } });
  return { handler, calls };
}
function request(body = {}, route = '', auth = SECRET) {
  return new Request(EDGE + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}
async function safe(response) {
  const text = await response.text();
  for (const privateValue of [SECRET, READER, SERVICE, SHEET, SOURCE, 'PRIVATE_DATABASE_TRACE']) assert.ok(!text.includes(privateValue));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return JSON.parse(text);
}

test('requires the private scheduler credential before acquiring any source', async () => {
  for (const value of ['', 'wrong', SERVICE, `${SOURCE}.${READER}`]) {
    const { handler, calls } = setup();
    const response = await handler(request({}, '', value));
    assert.equal(response.status, 401); await safe(response); assert.equal(calls.length, 0);
  }
});
test('the schedule accepts no caller supplied URLs, source IDs, query keys or payloads', async () => {
  for (const body of [{ url: 'https://example.invalid/' }, { source_id: SOURCE }, null, [], '{bad', { x: 'x'.repeat(1500) }]) {
    const { handler, calls } = setup(); const response = await handler(request(body));
    assert.equal(response.status, 400); await safe(response); assert.equal(calls.length, 0);
  }
  const { handler, calls } = setup();
  assert.equal((await handler(request({}, '?credential=' + SECRET))).status, 404); assert.equal(calls.length, 0);
});
test('Google fetch has no database/source credentials and is bound to a known export URL', async () => {
  const { handler, calls } = setup(); const response = await handler(request());
  assert.equal(response.status, 200); assert.deepEqual(await safe(response), { status: 'checked', checked: 1, failed: 0 });
  const google = calls.find(call => call.url.startsWith('https://docs.google.com/'));
  assert.equal(google.url, `https://docs.google.com/spreadsheets/d/${SHEET}/export?format=csv&gid=12345`);
  assert.deepEqual(google.init.headers, { Accept: 'text/csv' }); assert.equal(google.init.redirect, 'manual');
  for (const call of calls.filter(call => call.url.startsWith(URL))) {
    assert.equal(call.init.headers.Authorization, 'Bearer ' + SERVICE);
    assert.equal(call.init.headers.apikey, SERVICE);
  }
});
test('private-reader snapshots require a bound source credential and never fetch Google anonymously', async () => {
  const { handler, calls } = setup();
  const response = await handler(request({ spreadsheet_id: SHEET, sheet_gid: '12345', csv: HEADER }, '/source', `${SOURCE}.${READER}`));
  assert.equal(response.status, 200); await safe(response);
  assert.ok(!calls.some(call => call.url.startsWith('https://docs.google.com/')));
  const acquire = calls.find(call => call.url.endsWith('garage_acquire_sheet_reader'));
  assert.deepEqual(JSON.parse(acquire.init.body), { p_source_id: SOURCE, p_secret: READER, p_spreadsheet_id: SHEET, p_sheet_gid: '12345' });
});
test('private-reader invalid credentials cannot reveal DB errors or acquire another workbook', async () => {
  const { handler } = setup({ authError: true });
  const response = await handler(request({ spreadsheet_id: SHEET, sheet_gid: '12345', csv: HEADER }, '/source', `${SOURCE}.${READER}`));
  assert.equal(response.status, 401); await safe(response);
  for (const body of [{ spreadsheet_id: SHEET, sheet_gid: '12345', csv: HEADER, url: 'https://example.invalid' }, { csv: HEADER }, { spreadsheet_id: SHEET, sheet_gid: '12345', csv: 123 }]) {
    const { handler, calls } = setup();
    assert.equal((await handler(request(body, '/source', `${SOURCE}.${READER}`))).status, 400); assert.equal(calls.length, 0);
  }
});
test('an overlapping private reader receives a safe busy acknowledgement', async () => {
  const { handler, calls } = setup({ readerFeed: null });
  const response = await handler(request({ spreadsheet_id: SHEET, sheet_gid: '12345', csv: HEADER }, '/source', `${SOURCE}.${READER}`));
  assert.deepEqual(await safe(response), { status: 'busy', checked: 0, failed: 0 }); assert.equal(calls.length, 1);
});
test('malformed CSV records a format error and preserves prior private review', async () => {
  const previousReview = [{ row_number: 2, source_key: null, reason_codes: ['INVALID_VIN'], vehicle: 'Synthetic' }];
  const { handler, calls } = setup({ csv: '<html>Sign in</html>', feeds: [feed({ summary: { completed: 9 }, review: previousReview })] });
  const response = await handler(request()); assert.equal(response.status, 503); await safe(response);
  const commit = JSON.parse(calls.find(call => call.url.endsWith('garage_commit_sheet_pull')).init.body);
  assert.equal(commit.p_error_code, 'SHEET_FORMAT_CHANGED'); assert.deepEqual(commit.p_review, previousReview);
  assert.equal(commit.p_summary.completed, 9);
});
test('failed reads merge repeated delivery reviews without growing duplicate rows', async () => {
  const key = '2026-11-13|TEST0000000000001';
  const previousReview = [{ row_number: 2, source_key: key, reason_codes: ['ORDER_CHANGED'], vehicle: 'S50', planned_date: '2026-11-13' }];
  const state = { schema_version: 1, entries: { [key]: { source_key: key, vin: 'TEST0000000000001', planned_date: '2026-11-13',
    row_number: 2, vehicle: 'S50', origin: 'request', blocked: { input_hash: 'synthetic', code: 'ORDER_CHANGED', permanent: true } } } };
  const { handler, calls } = setup({ csv: '<html>Sign in</html>', feeds: [feed({ state, review: previousReview })] });
  await handler(request());
  const result = JSON.parse(calls.find(call => call.url.endsWith('garage_commit_sheet_pull')).init.body);
  assert.equal(result.p_review.length, 1); assert.deepEqual(result.p_review[0].reason_codes, ['ORDER_CHANGED']);
});
test('the first valid private read records a candidate without publishing an unfinished selection', async () => {
  const csv = HEADER + '\r\n13.11.2026,,Synthetic manager,S50,TEST0000000000001,Grey,W01,,FALSE,';
  const { handler, calls } = setup();
  const response = await handler(request({ spreadsheet_id: SHEET, sheet_gid: '12345', csv }, '/source', `${SOURCE}.${READER}`));
  assert.equal(response.status, 200);
  assert.ok(calls.some(call => call.url.endsWith('garage_checkpoint_sheet_pull')));
  assert.ok(!calls.some(call => call.url.endsWith('garage_ingest_sheet')));
  const result = JSON.parse(calls.find(call => call.url.endsWith('garage_commit_sheet_pull')).init.body);
  assert.equal(result.p_summary.awaiting_stability, 1);
});
test('CSV redirects are confined to HTTPS Google export infrastructure', async () => {
  for (const location of ['https://attacker.invalid/collect', 'http://docs.google.com/', 'https://docs.google.com.attacker.invalid/', 'https://user:pass@docs.google.com/']) {
    const calls = [];
    await assert.rejects(readGoogleCsv(SHEET, '12345', async (url, init) => { calls.push({ url, init }); return new Response('', { status: 302, headers: { Location: location } }); }));
    assert.equal(calls.length, 1);
  }
  const calls = [];
  const csv = await readGoogleCsv(SHEET, '12345', async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? new Response('', { status: 302, headers: { Location: 'https://export.googleusercontent.com/csv' } })
      : new Response(HEADER, { headers: { 'Content-Type': 'text/csv' } });
  });
  assert.equal(csv, HEADER); assert.equal(calls.length, 2); assert.deepEqual(calls[1].init.headers, { Accept: 'text/csv' });
});
test('CSV downloads reject HTML and oversized actual UTF8 bodies', async () => {
  for (const response of [new Response('<html>no</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('я'.repeat(1024 * 1024 + 1), { headers: { 'Content-Type': 'text/csv', 'Content-Length': '1' } })]) {
    await assert.rejects(readGoogleCsv(SHEET, '12345', async () => response));
  }
});
