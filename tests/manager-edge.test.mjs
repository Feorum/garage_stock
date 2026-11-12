// Boundary tests use synthetic credentials and an injected fetch; no service calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/manager-orders/handler.ts';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const SUBMISSION = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';
const SECRET = 'synthetic_ingestion_credential_0123456789';
const SERVICE_KEY = 'synthetic_server_key_for_boundary_tests';
const SUPABASE_URL = 'https://database.example.invalid';
const EDGE_URL = 'https://edge.example.invalid/functions/v1/manager-orders';

function payload() {
  return {
    schema_version: 1,
    spreadsheet_id: 'synthetic-workbook-id',
    submission_id: SUBMISSION,
    external_order_id: ORDER,
    revision: 1,
    expected_order_version: null,
    action: 'submit',
    order: {
      vehicle: 'Synthetic vehicle', vin: '', colour: '',
      vehicle_group_code: 'VG02', planned_date: null, due_date: null,
      priority: 'normal', instructions: '', manager_label: 'Synthetic reference',
    },
    tasks: [{ external_task_id: TASK, work_code: 'W01', options: {}, instructions: '' }],
  };
}

function request(body = payload(), overrides = {}) {
  const headers = {
    Authorization: `Bearer ${SOURCE}.${SECRET}`,
    'Content-Type': 'application/json; charset=utf-8',
    ...overrides.headers,
  };
  return new Request(overrides.url || EDGE_URL, {
    method: overrides.method || 'POST', headers,
    ...((overrides.method || 'POST') === 'GET' ? {} : {
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  });
}

function setup(upstream, options = {}) {
  const calls = [];
  const handler = createHandler({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (upstream instanceof Error) throw upstream;
      return typeof upstream === 'function' ? upstream(url, init) : upstream;
    },
    ...options,
  });
  return { handler, calls };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

async function assertSafeResponse(response) {
  const text = await response.text();
  for (const value of [SECRET, SERVICE_KEY, 'PRIVATE_RATE_SENTINEL', 'PRIVATE_TRACE_SENTINEL']) {
    assert.ok(!text.includes(value), `Response exposed ${value}`);
  }
  assert.ok(!/"(?:net_amount|gross_amount|vat_amount|secret_hash|service_role_key)"\s*:/.test(text),
    'Response contains a financial or credential field');
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  return JSON.parse(text);
}

test('submission delegates only to the private ingest RPC with the bound credential', async () => {
  const { handler, calls } = setup(jsonResponse({
    status: 'accepted', submission_id: SUBMISSION, external_order_id: ORDER,
    revision: 1, order_number: 'G-000001', order_status: 'published', order_version: 1,
    tasks: [{ external_task_id: TASK, work_code: 'W01', status: 'pending' }],
  }));
  const submitted = payload();
  const response = await handler(request(submitted));
  assert.equal(response.status, 200);
  await assertSafeResponse(response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SUPABASE_URL + '/rest/v1/rpc/garage_ingest_sheet');
  assert.equal(calls[0].init.method, 'POST');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${SERVICE_KEY}`);
  assert.equal(headers.get('apikey'), SERVICE_KEY);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    p_source_id: SOURCE, p_secret: SECRET, p_payload: submitted,
  });
});

test('status uses its own RPC and source-scoped external IDs', async () => {
  const { handler, calls } = setup(jsonResponse({ source_id: SOURCE, orders: [] }));
  const response = await handler(request({ external_order_ids: [ORDER] }, { url: EDGE_URL + '/status' }));
  assert.equal(response.status, 200);
  await assertSafeResponse(response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SUPABASE_URL + '/rest/v1/rpc/garage_sheet_status');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    p_source_id: SOURCE, p_secret: SECRET, p_external_order_ids: [ORDER],
  });
});

test('unsupported methods and non-JSON content never reach the database', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const { handler, calls } = setup(jsonResponse({}));
    const response = await handler(request({}, { method }));
    assert.equal(response.status, 405, method);
    await assertSafeResponse(response);
    assert.equal(calls.length, 0);
  }
  const { handler, calls } = setup(jsonResponse({}));
  const response = await handler(request('not JSON', { headers: { 'Content-Type': 'text/plain' } }));
  assert.equal(response.status, 415);
  await assertSafeResponse(response);
  assert.equal(calls.length, 0);
});

test('source credentials are accepted only from a strict Bearer header', async () => {
  for (const authorization of ['', 'Basic value', `Bearer ${SOURCE}.short`, `Bearer not-a-uuid.${SECRET}`,
    `Bearer ${SOURCE}.${SECRET}!`, `Bearer ${SOURCE}.${SECRET} trailing`]) {
    const { handler, calls } = setup(jsonResponse({}));
    const response = await handler(request(payload(), { headers: { Authorization: authorization } }));
    assert.equal(response.status, 401, authorization);
    await assertSafeResponse(response);
    assert.equal(calls.length, 0);
  }
  const { handler, calls } = setup(jsonResponse({}));
  const response = await handler(request(payload(), {
    url: EDGE_URL + `?token=${SOURCE}.${SECRET}`,
    headers: { Authorization: '' },
  }));
  assert.equal(response.status, 400);
  await assertSafeResponse(response);
  assert.equal(calls.length, 0);
});

test('invalid JSON is rejected before an upstream request', async () => {
  const { handler, calls } = setup(jsonResponse({}));
  const response = await handler(request('{broken'));
  assert.equal(response.status, 400);
  await assertSafeResponse(response);
  assert.equal(calls.length, 0);
});

test('body limit counts UTF-8 bytes and ignores a false Content-Length', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    const { handler, calls } = setup(jsonResponse({}), { maxBodyBytes: 100 });
    const body = JSON.stringify({ instructions: 'é'.repeat(70) });
    assert.ok(body.length < 100 && new TextEncoder().encode(body).length > 100);
    const response = await handler(request(body, { headers }));
    assert.equal(response.status, 413);
    await assertSafeResponse(response);
    assert.equal(calls.length, 0);
  }
});

test('malformed status filters cannot probe arbitrary RPC arguments', async () => {
  for (const body of [{ external_order_ids: 'not-an-array' }, { external_order_ids: ['not-a-uuid'] },
    { external_order_ids: [ORDER], p_source_id: SOURCE },
    { external_order_ids: Array(101).fill(ORDER) }]) {
    const { handler, calls } = setup(jsonResponse({ source_id: SOURCE, orders: [] }));
    const response = await handler(request(body, { url: EDGE_URL + '/status' }));
    assert.ok([400, 422].includes(response.status));
    await assertSafeResponse(response);
    assert.equal(calls.length, 0);
  }
});

test('SQL auth, conflict and validation failures have safe stable HTTP categories', async () => {
  for (const [code, expected] of [['42501', 401], ['40001', 409], ['22023', 422], ['P0001', 422]]) {
    const { handler, calls } = setup(jsonResponse({
      code, message: `PRIVATE_TRACE_SENTINEL ${SECRET}`, details: SERVICE_KEY,
      hint: 'PRIVATE_RATE_SENTINEL',
    }, 400));
    const response = await handler(request());
    assert.equal(response.status, expected, code);
    await assertSafeResponse(response);
    assert.equal(calls.length, 1);
  }
});

test('upstream transport and invalid responses fail without leaking server details', async () => {
  for (const upstream of [new Error(`PRIVATE_TRACE_SENTINEL ${SECRET}`),
    new Response('PRIVATE_TRACE_SENTINEL PRIVATE_RATE_SENTINEL', { status: 500 }),
    jsonResponse({ code: 'XX000', message: `PRIVATE_TRACE_SENTINEL ${SERVICE_KEY}` }, 500)]) {
    const { handler } = setup(upstream);
    const response = await handler(request());
    assert.ok(response.status >= 500 && response.status <= 599);
    await assertSafeResponse(response);
  }
});

test('an incomplete upstream acceptance is not reported as a confirmed delivery', async () => {
  const { handler } = setup(jsonResponse({
    status: 'accepted', submission_id: SUBMISSION, external_order_id: ORDER,
    revision: 1, net_amount: 'PRIVATE_RATE_SENTINEL',
  }));
  const response = await handler(request());
  assert.equal(response.status, 502);
  const result = await assertSafeResponse(response);
  assert.notEqual(result.status, 'accepted');
});

test('recorded rejected/conflict receipts retain their safe delivery category', async () => {
  for (const [status, expected] of [['rejected', 422], ['conflict', 409]]) {
    const { handler } = setup(jsonResponse({
      status, submission_id: SUBMISSION, external_order_id: ORDER, revision: 2,
      error: { code: 'VALIDATION_FAILED', message: `PRIVATE_TRACE_SENTINEL ${SECRET}` },
    }));
    const response = await handler(request());
    assert.equal(response.status, expected);
    const result = await assertSafeResponse(response);
    assert.equal(result.status, status);
  }
});

test('successful submissions cannot forward unexpected financial or credential fields', async () => {
  const { handler } = setup(jsonResponse({
    status: 'accepted', submission_id: SUBMISSION, external_order_id: ORDER, revision: 1,
    order_number: 'G-000001', order_status: 'published', order_version: 1,
    net_amount: 'PRIVATE_RATE_SENTINEL', secret_hash: SECRET,
    nested: { service_role_key: SERVICE_KEY, gross_amount: 'PRIVATE_RATE_SENTINEL' },
    tasks: [{ external_task_id: TASK, work_code: 'W01', status: 'pending', net_amount: 'PRIVATE_RATE_SENTINEL' }],
  }));
  const response = await handler(request());
  assert.equal(response.status, 200);
  await assertSafeResponse(response);
});

test('status output does not forward private fields even inside task rows', async () => {
  const { handler } = setup(jsonResponse({ source_id: SOURCE, orders: [{
    external_order_id: ORDER, revision: 1, order_number: 'G-000001',
    status: 'published', order_version: 1,
    net_amount: 'PRIVATE_RATE_SENTINEL',
    tasks: [{ external_task_id: TASK, work_code: 'W01', status: 'pending',
      working_name: 'Synthetic mechanic', net_amount: 'PRIVATE_RATE_SENTINEL',
      secret_hash: SECRET, nested: { service_role_key: SERVICE_KEY } }],
  }] }));
  const response = await handler(request({ external_order_ids: [ORDER] }, { url: EDGE_URL + '/status' }));
  assert.equal(response.status, 200);
  await assertSafeResponse(response);
});

test('status acknowledgements must belong to the authenticated source', async () => {
  const { handler } = setup(jsonResponse({ source_id: ORDER, orders: [] }));
  const response = await handler(request({ external_order_ids: [] }, { url: EDGE_URL + '/status' }));
  assert.equal(response.status, 502);
  await assertSafeResponse(response);
});

test('acceptances must match every submitted identity and revision', async () => {
  const receipt = { status: 'accepted', submission_id: SUBMISSION, external_order_id: ORDER,
    revision: 1, order_number: 'G-000001', order_status: 'published', order_version: 1,
    tasks: [{ external_task_id: TASK, work_code: 'W01', status: 'pending' }] };
  for (const override of [{ submission_id: SOURCE }, { external_order_id: SOURCE }, { revision: 2 },
    { submission_id: undefined }, { external_order_id: undefined }, { revision: undefined }]) {
    const { handler } = setup(jsonResponse({ ...receipt, ...override }));
    const response = await handler(request());
    assert.equal(response.status, 502);
    const result = await assertSafeResponse(response);
    assert.notEqual(result.status, 'accepted');
  }
});

test('accepted UUID identities compare canonically regardless of hex letter case', async () => {
  const submission = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
  const order = 'fedcba98-7654-4321-8123-fedcba987654';
  const submitted = { ...payload(), submission_id: submission.toUpperCase(), external_order_id: order.toUpperCase() };
  const { handler } = setup(jsonResponse({
    status: 'accepted', submission_id: submission, external_order_id: order,
    revision: 1, order_number: 'G-000001', order_status: 'published', order_version: 1,
    tasks: [{ external_task_id: TASK, work_code: 'W01', status: 'pending' }],
  }));
  const response = await handler(request(submitted));
  assert.equal(response.status, 200);
  assert.equal((await assertSafeResponse(response)).status, 'accepted');
});
