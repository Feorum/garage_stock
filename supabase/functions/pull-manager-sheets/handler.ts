import { parseExistingSheetCsv } from './parser.ts';
import { runFeed } from './engine.ts';

type Dependencies = {
  supabaseUrl: string;
  serviceRoleKey: string;
  schedulerSecret: string;
  fetchImpl?: typeof fetch;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CSV_BYTES = 2 * 1024 * 1024;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  } });
}

function authorized(header: string, secret: string) {
  // Fixed work for all plausible same-length credentials; no credentials enter URLs.
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  let difference = supplied.length ^ secret.length;
  for (let index = 0; index < secret.length; index++) difference |= secret.charCodeAt(index) ^ (supplied.charCodeAt(index) || 0);
  return difference === 0;
}

function mergedReviews(previous: any[], current: any[]) {
  const rows = new Map<string, any>();
  for (const item of [...previous, ...current]) {
    const key = JSON.stringify([item.row_number, item.source_key ?? null]);
    const old = rows.get(key);
    rows.set(key, old ? { ...old, ...item, reason_codes: [...new Set([...old.reason_codes, ...item.reason_codes])] } : item);
  }
  return [...rows.values()];
}

function googleExportUrl(spreadsheetId: string, gid: string) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(spreadsheetId) || !/^\d{1,20}$/.test(gid)) throw new Error('Invalid source');
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
}

function permittedRedirect(url: URL) {
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
    && (url.hostname === 'docs.google.com' || url.hostname.endsWith('.googleusercontent.com'));
}

export async function readGoogleCsv(spreadsheetId: string, gid: string, fetchImpl: typeof fetch = fetch) {
  let target = new URL(googleExportUrl(spreadsheetId, gid));
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetchImpl(target.href, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(25000),
      headers: { Accept: 'text/csv' }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if (!location || hop === 3) throw new Error('Export unavailable');
      target = new URL(location, target);
      if (!permittedRedirect(target)) throw new Error('Export unavailable');
      continue;
    }
    if (!response.ok || !/^text\/csv(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')
        || Number(response.headers.get('Content-Length') || 0) > MAX_CSV_BYTES || !response.body) {
      await response.body?.cancel();
      throw new Error('Export unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_CSV_BYTES) { await reader.cancel(); throw new Error('Export too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  throw new Error('Export unavailable');
}

export function createPullHandler({ supabaseUrl, serviceRoleKey, schedulerSecret, fetchImpl = fetch }: Dependencies) {
  const url = new URL(supabaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '') || !serviceRoleKey
      || !/^[A-Za-z0-9_-]{32,256}$/.test(schedulerSecret)) throw new Error('Invalid server configuration');
  const base = url.origin;

  async function rpc(name: string, args: Record<string, unknown> = {}) {
    const response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST', signal: AbortSignal.timeout(30000), headers: {
        'Content-Type': 'application/json', apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`
      }, body: JSON.stringify(args)
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Service unavailable'); }
    return await response.json();
  }

  return async (request: Request) => {
    const target = new URL(request.url);
    const readerRoute = target.pathname.endsWith('/pull-manager-sheets/source');
    if (target.search || (!readerRoute && !target.pathname.endsWith('/pull-manager-sheets') && target.pathname !== '/')) return reply({ status: 'unavailable' }, 404);
    if (request.method !== 'POST') return reply({ status: 'unavailable' }, 405);
    const credential = readerRoute ? (request.headers.get('Authorization') || '').match(/^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,256})$/i) : null;
    if (readerRoute ? !credential || !UUID.test(credential[1]) : !authorized(request.headers.get('Authorization') || '', schedulerSecret)) return reply({ status: 'unauthorized' }, 401);
    // The schedule accepts no controls. An authenticated reader supplies only
    // its bound spreadsheet ID and a complete CSV snapshot, never an endpoint.
    let body = '';
    let input: any = {};
    const bodyLimit = readerRoute ? MAX_CSV_BYTES + 512 * 1024 : 1024;
    try {
      if (Number(request.headers.get('Content-Length') || 0) > bodyLimit) return reply({ status: 'invalid_request' }, 400);
      const reader = request.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > bodyLimit) { await reader.cancel(); return reply({ status: 'invalid_request' }, 400); }
            body += decoder.decode(part.value, { stream: true });
          }
          body += decoder.decode();
        } finally { reader.releaseLock(); }
      }
      input = body.trim() ? JSON.parse(body) : {};
      if (typeof input !== 'object' || input === null || Array.isArray(input)
          || (readerRoute ? Object.keys(input).length !== 3 || Object.keys(input).some(key => !['spreadsheet_id', 'sheet_gid', 'csv'].includes(key))
            || !/^[A-Za-z0-9_-]{10,200}$/.test(input.spreadsheet_id) || typeof input.csv !== 'string'
            || typeof input.sheet_gid !== 'string' || !/^\d{1,20}$/.test(input.sheet_gid)
            || new TextEncoder().encode(input.csv).length > MAX_CSV_BYTES : Object.keys(input).length !== 0)) {
        return reply({ status: 'invalid_request' }, 400);
      }
    } catch { return reply({ status: 'invalid_request' }, 400); }

    let feeds: any[];
    try {
      const acquired = readerRoute ? await rpc('garage_acquire_sheet_reader', {
        p_source_id: credential![1], p_secret: credential![2], p_spreadsheet_id: input.spreadsheet_id, p_sheet_gid: input.sheet_gid
      }) : await rpc('garage_acquire_sheet_pulls');
      if (readerRoute && acquired === null) return reply({ status: 'busy', checked: 0, failed: 0 });
      if (readerRoute) feeds = [acquired];
      else feeds = acquired;
      if (!Array.isArray(feeds) || feeds.length > 5) throw new Error('Invalid feeds');
    } catch { return reply({ status: readerRoute ? 'source_unavailable' : 'retry' }, readerRoute ? 401 : 503); }

    let checked = 0, failed = 0;
    for (const feed of feeds) {
      if (!feed || !UUID.test(feed.source_id) || !UUID.test(feed.lease_token)
          || !Number.isInteger(feed.version) || feed.version < 1 || feed.adapter !== 'alfort_v1'
          || (readerRoute && (feed.source_id.toLowerCase() !== credential![1].toLowerCase()
            || feed.spreadsheet_id !== input.spreadsheet_id || feed.sheet_gid !== input.sheet_gid))
          || !/^[A-Za-z0-9_-]{32,256}$/.test(feed.credential)) { failed++; continue; }
      let parsed: any = null;
      let errorCode: string | null = null;
      let durableState = feed.state;
      let version = feed.version;
      try {
        let csv: string | null = null;
        try { csv = readerRoute ? input.csv : await readGoogleCsv(feed.spreadsheet_id, feed.sheet_gid, fetchImpl); }
        catch { errorCode = 'SHEET_FETCH_UNAVAILABLE'; }
        if (csv !== null) {
          try { parsed = parseExistingSheetCsv(csv); }
          catch { errorCode = 'SHEET_FORMAT_CHANGED'; }
        }
        const result = await runFeed(feed, parsed, {
          checkpoint: async (state: unknown, expectedVersion: number) => {
            const saved = await rpc('garage_checkpoint_sheet_pull', {
              p_source_id: feed.source_id, p_lease_token: feed.lease_token,
              p_expected_version: expectedVersion, p_state: state
            });
            if (!Number.isInteger(saved?.version) || saved.version <= expectedVersion) throw new Error('Unconfirmed checkpoint');
            version = saved.version;
            durableState = state;
            return saved.version;
          },
          ingest: async (payload: unknown) => rpc('garage_ingest_sheet', {
            p_source_id: feed.source_id, p_secret: feed.credential, p_payload: payload
          })
        });
        version = result.version;
        durableState = result.state;
        const committed = await rpc('garage_commit_sheet_pull', {
          p_source_id: feed.source_id, p_lease_token: feed.lease_token, p_expected_version: version,
          p_state: durableState, p_summary: parsed ? result.summary : { ...(feed.summary || {}), ...result.summary },
          p_review: parsed ? result.review : mergedReviews(feed.review || [], result.review), p_error_code: errorCode
        });
        if (!Number.isInteger(committed?.version) || committed.version <= version) throw new Error('Unconfirmed result');
        if (errorCode) failed++; else checked++;
      } catch {
        // A checkpoint already preserves exact pending UUIDs/payloads across failure.
        // Best-effort release uses only the latest confirmed durable state.
        try { await rpc('garage_commit_sheet_pull', {
          p_source_id: feed.source_id, p_lease_token: feed.lease_token, p_expected_version: version,
          p_state: durableState, p_summary: feed.summary || {}, p_review: feed.review || [], p_error_code: 'SHEET_SYNC_UNAVAILABLE'
        }); } catch { /* Lease expires; next run resumes only persisted state. */ }
        failed++;
      }
    }
    return reply({ status: failed ? 'attention' : 'checked', checked, failed }, failed && !checked ? 503 : 200);
  };
}
