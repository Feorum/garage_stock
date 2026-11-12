const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSINESS_ERRORS: Record<string, string> = {
  INVALID_SUBMISSION: 'Check the submission fields and try again.',
  UNSUPPORTED_FIELDS: 'The submission contains unsupported fields.',
  SPREADSHEET_MISMATCH: 'This connection is registered to another spreadsheet.',
  SUBMISSION_ID_REUSED: 'This submission ID was already used with different content.',
  REVISION_CONFLICT: 'The source revision has changed. Reconcile before resubmitting.',
  ORDER_CHANGED: 'The order has changed in the application. Ask the Owner to review it.',
  ORDER_CLOSED: 'The order is closed and cannot be amended from the spreadsheet.',
  TASK_ID_REUSED: 'A task ID is already linked to another order.',
  VALIDATION_FAILED: 'Check the vehicle group, work selections and task options.',
  SOURCE_UNAVAILABLE: 'This spreadsheet connection is unavailable.'
};
const TASK_STATES = new Set(['pending', 'in_progress', 'blocked', 'completed', 'cancelled']);
const ORDER_STATES = new Set(['published', 'closed', 'cancelled']);

type Dependencies = {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  } });
}

function failure(status: number, code: string, message: string) {
  return response({ status: 'rejected', error: { code, message } }, status);
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeTask(value: unknown, statusReply = false) {
  if (!record(value) || typeof value.external_task_id !== 'string' || !UUID.test(value.external_task_id)
      || typeof value.work_code !== 'string' || !/^W\d{2}$/.test(value.work_code)
      || !TASK_STATES.has(value.status)) throw new Error('Invalid upstream task');
  const task: Record<string, unknown> = {
    external_task_id: value.external_task_id, work_code: value.work_code, status: value.status
  };
  if (statusReply) {
    if (typeof value.working_name === 'string') task.working_name = value.working_name.slice(0, 200);
    if (value.completed_at === null || (typeof value.completed_at === 'string' && value.completed_at.length <= 40)) {
      task.completed_at = value.completed_at;
    }
  }
  return task;
}

function safeReceipt(value: unknown) {
  if (!record(value) || !['accepted', 'rejected', 'conflict'].includes(value.status)) throw new Error('Invalid upstream receipt');
  const result: Record<string, any> = { status: value.status };
  for (const field of ['submission_id', 'external_order_id']) {
    if (typeof value[field] === 'string' && UUID.test(value[field])) result[field] = value[field];
  }
  if (Number.isInteger(value.revision) && value.revision > 0) result.revision = value.revision;
  if (value.status === 'accepted') {
    if (!result.submission_id || !result.external_order_id || !result.revision
        || typeof value.order_number !== 'string' || !/^G-\d{1,20}$/.test(value.order_number)
        || !ORDER_STATES.has(value.order_status) || !Number.isInteger(value.order_version)
        || value.order_version < 1 || !Array.isArray(value.tasks) || value.tasks.length > 50) throw new Error('Invalid upstream acceptance');
    result.order_number = value.order_number;
    result.order_status = value.order_status;
    result.order_version = value.order_version;
    result.tasks = value.tasks.map(task => safeTask(task));
  } else {
    const code = record(value.error) && typeof value.error.code === 'string' && Object.hasOwn(BUSINESS_ERRORS, value.error.code)
      ? value.error.code : value.status === 'conflict' ? 'ORDER_CHANGED' : 'VALIDATION_FAILED';
    result.error = { code, message: BUSINESS_ERRORS[code] };
  }
  return result;
}

function safeStatus(value: unknown) {
  if (!record(value) || typeof value.source_id !== 'string' || !UUID.test(value.source_id)
      || !Array.isArray(value.orders) || value.orders.length > 100) throw new Error('Invalid upstream status');
  return { source_id: value.source_id, orders: value.orders.map((order: unknown) => {
    if (!record(order) || typeof order.external_order_id !== 'string' || !UUID.test(order.external_order_id)
        || !Number.isInteger(order.revision) || order.revision < 1
        || typeof order.order_number !== 'string' || !/^G-\d{1,20}$/.test(order.order_number)
        || !ORDER_STATES.has(order.status) || !Number.isInteger(order.order_version) || order.order_version < 1
        || !Array.isArray(order.tasks) || order.tasks.length > 50) throw new Error('Invalid upstream order status');
    return { external_order_id: order.external_order_id, revision: order.revision,
      order_number: order.order_number, status: order.status, order_version: order.order_version,
      tasks: order.tasks.map(task => safeTask(task, true)) };
  }) };
}

async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get('Content-Length') || 0) > limit) throw new RangeError('Too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) { await reader.cancel(); throw new RangeError('Too large'); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function createHandler({ supabaseUrl, serviceRoleKey, fetchImpl = fetch, maxBodyBytes = 131072 }: Dependencies) {
  const origin = new URL(supabaseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
      || (origin.pathname !== '/' && origin.pathname !== '') || !serviceRoleKey) throw new Error('Invalid server configuration');
  const base = origin.origin;
  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.search) return failure(400, 'INVALID_REQUEST', 'Send request data in the JSON body.');
    const statusRoute = url.pathname.endsWith('/manager-orders/status');
    if (!statusRoute && !url.pathname.endsWith('/manager-orders') && url.pathname !== '/') return failure(404, 'NOT_FOUND', 'This endpoint is unavailable.');
    if (request.method !== 'POST') return failure(405, 'METHOD_NOT_ALLOWED', 'Use POST for this endpoint.');
    const authorization = request.headers.get('Authorization') || '';
    const token = authorization.match(/^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,256})$/i);
    if (!token || !UUID.test(token[1])) return failure(401, 'SOURCE_UNAVAILABLE', BUSINESS_ERRORS.SOURCE_UNAVAILABLE);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) return failure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json.');
    let body: unknown;
    try { body = JSON.parse(await boundedBody(request, maxBodyBytes)); }
    catch (error) {
      return error instanceof RangeError ? failure(413, 'PAYLOAD_TOO_LARGE', 'The submission is too large.')
        : failure(400, 'INVALID_SUBMISSION', BUSINESS_ERRORS.INVALID_SUBMISSION);
    }
    if (!record(body)) return failure(400, 'INVALID_SUBMISSION', BUSINESS_ERRORS.INVALID_SUBMISSION);
    let arguments_: Record<string, unknown>;
    if (statusRoute) {
      if (Object.keys(body).some(key => key !== 'external_order_ids') || !Array.isArray(body.external_order_ids)
          || body.external_order_ids.length > 100 || body.external_order_ids.some((id: unknown) => typeof id !== 'string' || !UUID.test(id))) {
        return failure(400, 'INVALID_SUBMISSION', BUSINESS_ERRORS.INVALID_SUBMISSION);
      }
      arguments_ = { p_source_id: token[1], p_secret: token[2], p_external_order_ids: body.external_order_ids };
    } else arguments_ = { p_source_id: token[1], p_secret: token[2], p_payload: body };

    let upstream: Response;
    let result: any;
    try {
      upstream = await fetchImpl(`${base}/rest/v1/rpc/${statusRoute ? 'garage_sheet_status' : 'garage_ingest_sheet'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }, body: JSON.stringify(arguments_)
      });
      result = await upstream.json();
    } catch { return failure(503, 'TEMPORARILY_UNAVAILABLE', 'The submission service is temporarily unavailable. Retry the same submission.'); }
    if (!upstream.ok) {
      const code = record(result) ? result.code : '';
      if (code === '42501' || upstream.status === 401 || upstream.status === 403) return failure(401, 'SOURCE_UNAVAILABLE', BUSINESS_ERRORS.SOURCE_UNAVAILABLE);
      if (code === '40001') return failure(409, 'ORDER_CHANGED', BUSINESS_ERRORS.ORDER_CHANGED);
      if (code === '22023' || code === 'P0001' || upstream.status === 400) return failure(422, 'VALIDATION_FAILED', BUSINESS_ERRORS.VALIDATION_FAILED);
      return failure(503, 'TEMPORARILY_UNAVAILABLE', 'The submission service is temporarily unavailable. Retry the same submission.');
    }
    try {
      if (statusRoute) {
        const status = safeStatus(result);
        if (status.source_id.toLowerCase() !== token[1].toLowerCase()) throw new Error('Mismatched source response');
        return response(status);
      }
      const receipt = safeReceipt(result);
      if (receipt.status === 'accepted' && (receipt.submission_id.toLowerCase() !== String(body.submission_id).toLowerCase()
          || receipt.external_order_id.toLowerCase() !== String(body.external_order_id).toLowerCase() || receipt.revision !== body.revision)) {
        throw new Error('Mismatched submission response');
      }
      return response(receipt, receipt.status === 'accepted' ? 200 : receipt.status === 'conflict' ? 409 : 422);
    } catch { return failure(502, 'INVALID_SERVICE_RESPONSE', 'The submission could not be confirmed. Retry the same submission.'); }
  };
}
