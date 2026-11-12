// Private delivery state for a read-only Manager source. Source rows are never
// identities by position and never receive application IDs or delivery writes.
type SourceRow = {
  row_number: number;
  source_key: string | null;
  state: 'completed' | 'ready' | 'review';
  source: { vin?: string; planned_date?: string | null; vehicle?: string; [key: string]: unknown };
  order: Record<string, unknown> | null;
  tasks: { task_key: string; work_code: string; options: Record<string, unknown>; instructions: string }[];
  issues: string[];
};
type ParsedSheet = { rows: SourceRow[]; summary: Record<string, number>; parser_version?: number };
type Accepted = { input_hash: string; revision: number; order_version: number; order_number: string; task_ids: Record<string, string> };
type Pending = { input_hash: string; payload: Record<string, any>; task_ids: Record<string, string>; attempts: number };
type Entry = {
  source_key: string; vin: string; planned_date: string | null; row_number: number; vehicle: string;
  origin: 'completed' | 'request'; external_order_id?: string; accepted?: Accepted; pending?: Pending;
  blocked?: { input_hash: string; code: string; permanent: boolean };
  candidate?: { input_hash: string; first_seen_at: number };
};
type PullState = { schema_version: 1; entries: Record<string, Entry> };
type Feed = { source_id: string; spreadsheet_id: string; state?: unknown; version: number; [key: string]: unknown };
type Review = { row_number: number; source_key: string | null; vehicle: string; planned_date: string | null; reason_codes: string[] };
type Dependencies = {
  checkpoint: (state: PullState, expectedVersion: number) => Promise<number>;
  ingest: (payload: Record<string, any>) => Promise<any>;
  uuid?: () => string;
  maxDeliveries?: number;
  now?: () => number;
  quietPeriodMs?: number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMANENT = new Set(['ORDER_CHANGED', 'ORDER_CLOSED', 'REVISION_CONFLICT', 'TASK_ID_REUSED', 'SUBMISSION_ID_REUSED']);
const BUSINESS_CODES = new Set(['INVALID_SUBMISSION', 'UNSUPPORTED_FIELDS', 'SPREADSHEET_MISMATCH', 'SUBMISSION_ID_REUSED', 'REVISION_CONFLICT', 'ORDER_CHANGED', 'ORDER_CLOSED', 'TASK_ID_REUSED', 'VALIDATION_FAILED', 'SOURCE_UNAVAILABLE']);

function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeState(value: unknown): PullState {
  if (value === null || value === undefined || (record(value) && Object.keys(value).length === 0)) return { schema_version: 1, entries: {} };
  if (!record(value) || value.schema_version !== 1 || !record(value.entries)) throw new Error('INVALID_PULL_STATE');
  const copy = structuredClone(value) as PullState;
  for (const [key, entry] of Object.entries(copy.entries)) {
    if (!record(entry) || entry.source_key !== key || typeof entry.vin !== 'string'
        || !['completed', 'request'].includes(entry.origin)
        || (entry.external_order_id !== undefined && !UUID.test(entry.external_order_id))
        || (entry.accepted && (!UUID.test(entry.external_order_id || '') || !Number.isInteger(entry.accepted.revision)
          || entry.accepted.revision < 1 || !Number.isInteger(entry.accepted.order_version) || entry.accepted.order_version < 1
          || typeof entry.accepted.input_hash !== 'string' || !record(entry.accepted.task_ids)))
        || (entry.candidate && (typeof entry.candidate.input_hash !== 'string'
          || !Number.isFinite(entry.candidate.first_seen_at) || entry.candidate.first_seen_at < 0))
        || (entry.pending && (!record(entry.pending.payload) || !UUID.test(entry.pending.payload.submission_id)
          || entry.pending.payload.external_order_id !== entry.external_order_id || typeof entry.pending.input_hash !== 'string'
          || !record(entry.pending.task_ids)))) throw new Error('INVALID_PULL_STATE');
  }
  return copy;
}
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
}
function normalized(value: unknown): string { return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function reviewRow(row: SourceRow | Entry, reasons: string[]): Review {
  const source = 'source' in row ? row.source : row;
  return { row_number: row.row_number, source_key: row.source_key,
    vehicle: String(source.vehicle || '').slice(0, 200), planned_date: source.planned_date ? String(source.planned_date) : null,
    reason_codes: [...new Set(reasons.map(code => code.toUpperCase()))] };
}
function validReceipt(receipt: any, payload: Record<string, any>) {
  return record(receipt) && receipt.status === 'accepted'
    && String(receipt.submission_id).toLowerCase() === payload.submission_id.toLowerCase()
    && String(receipt.external_order_id).toLowerCase() === payload.external_order_id.toLowerCase()
    && receipt.revision === payload.revision && Number.isInteger(receipt.order_version) && receipt.order_version > 0
    && /^G-\d+$/.test(receipt.order_number || '');
}

/** Capture -> durable checkpoint -> network -> durable acknowledgement. A lost
 * response reuses exactly the same source/order/submission/task IDs and body. */
export async function runFeed(feed: Feed, parsed: ParsedSheet | null, dependencies: Dependencies) {
  const { checkpoint, ingest, uuid = () => crypto.randomUUID(), now = () => Date.now() } = dependencies;
  const observedAt = now();
  const quietPeriodMs = Math.max(0, dependencies.quietPeriodMs ?? 60000);
  if (!Number.isFinite(observedAt) || observedAt < 0 || !Number.isFinite(quietPeriodMs)) throw new Error('INVALID_STABILITY_CLOCK');
  const maxDeliveries = Math.max(0, Math.min(20, dependencies.maxDeliveries ?? 20));
  const state = safeState(feed.state);
  let version = feed.version, deliveries = 0, acceptedThisRun = 0;
  const review: Review[] = [];
  const addReview = (row: SourceRow | Entry, reasons: string[]) => {
    const item = reviewRow(row, reasons);
    const existing = review.find(other => other.source_key === item.source_key && other.row_number === item.row_number);
    if (existing) existing.reason_codes = [...new Set([...existing.reason_codes, ...item.reason_codes])];
    else review.push(item);
  };
  async function save() {
    // The caller must enforce a lease/version compare-and-swap and reject stale
    // writers. Nothing is delivered unless its exact snapshot is durable.
    const next = await checkpoint(structuredClone(state), version);
    if (!Number.isInteger(next) || next <= version) throw new Error('INVALID_CHECKPOINT_VERSION');
    version = next;
  }
  async function deliver(entry: Entry) {
    if (!entry.pending || deliveries >= maxDeliveries) return;
    const pending = entry.pending;
    deliveries += 1;
    let receipt: any;
    try { receipt = await ingest(structuredClone(pending.payload)); }
    catch { pending.attempts += 1; return; }
    if (validReceipt(receipt, pending.payload)) {
      entry.accepted = { input_hash: pending.input_hash, revision: receipt.revision, order_version: receipt.order_version,
        order_number: receipt.order_number, task_ids: pending.task_ids };
      delete entry.pending; delete entry.blocked;
      acceptedThisRun += 1;
      // Save acknowledgements independently of future parser/source failures.
      await save();
    } else if (record(receipt) && ['rejected', 'conflict'].includes(receipt.status)
        && record(receipt.error) && BUSINESS_CODES.has(receipt.error.code)) {
      // A paused source or temporary credential/configuration outage must not
      // permanently suppress the unchanged durable request after resumption.
      if (receipt.error.code === 'SOURCE_UNAVAILABLE') { pending.attempts += 1; return; }
      entry.blocked = { input_hash: pending.input_hash, code: receipt.error.code,
        permanent: receipt.status === 'conflict' || PERMANENT.has(receipt.error.code) };
      delete entry.pending;
      await save();
    } else pending.attempts += 1;
  }

  // Durable snapshots survive bad/missing/edited current rows and lost acks.
  // They were already captured as requests; replay is required to learn whether
  // the server accepted them before a connection failed.
  const priorPending = Object.values(state.entries).filter(entry => entry.pending);
  for (const entry of priorPending) await deliver(entry);

  const sourceRows = parsed?.rows || [];
  const currentKeys = new Set(sourceRows.map(row => row.source_key).filter((key): key is string => !!key));
  const keyCounts = new Map<string, number>();
  for (const row of sourceRows) if (row.source_key) keyCounts.set(row.source_key, (keyCounts.get(row.source_key) || 0) + 1);
  // Resolve every identity before creating requests: sorting has no meaning,
  // and an absent previous visit plus a changed date is ambiguous rather than a
  // new order. Distinct visits concurrently present in the source stay distinct.
  const priorEntries = Object.values(state.entries);
  const newEntries: Entry[] = [];
  let changed = false;
  function clearCandidate(entry?: Entry) {
    if (entry?.candidate) { delete entry.candidate; changed = true; }
  }
  // A missing/invalid row breaks the observed stable input. A failed whole-file
  // read uses null and neither advances nor rewrites source observations.
  if (parsed) for (const entry of priorEntries) if (!currentKeys.has(entry.source_key)) clearCandidate(entry);
  for (const row of sourceRows) {
    if (!row.source_key) { if (row.state !== 'completed') addReview(row, row.issues.length ? row.issues : ['INVALID_SOURCE_IDENTITY']); continue; }
    if ((keyCounts.get(row.source_key) || 0) > 1) {
      // A completed occurrence still reserves historical identity even where a
      // duplicate prevents any current request from being trusted.
      if (row.state === 'completed' && !state.entries[row.source_key]) {
        state.entries[row.source_key] = { source_key: row.source_key, vin: String(row.source.vin || '').toUpperCase(),
          planned_date: row.source.planned_date || null, row_number: row.row_number,
          vehicle: String(row.source.vehicle || ''), origin: 'completed' };
        changed = true;
      }
      clearCandidate(state.entries[row.source_key]);
      addReview(row, ['DUPLICATE_SOURCE_IDENTITY']); continue;
    }
    let entry = state.entries[row.source_key];
    const vin = String(row.source.vin || '').toUpperCase();
    const missingPrior = !entry && priorEntries.some(previous => previous.source_key !== row.source_key
      && !currentKeys.has(previous.source_key)
      && ((previous.vin === vin && (previous.origin === 'completed' || !!previous.external_order_id))
        || (previous.origin === 'request' && !!previous.external_order_id
          && previous.planned_date === (row.source.planned_date || null)
          && normalized(previous.vehicle) === normalized(row.source.vehicle))));
    if (missingPrior) {
      addReview(row, ['SOURCE_IDENTITY_CHANGED']); continue;
    }
    if (!entry) {
      entry = { source_key: row.source_key, vin, planned_date: row.source.planned_date || null,
        row_number: row.row_number, vehicle: String(row.source.vehicle || ''),
        origin: row.state === 'completed' ? 'completed' : 'request' };
      state.entries[row.source_key] = entry; changed = true;
    }
    if (entry.row_number !== row.row_number || entry.vehicle !== String(row.source.vehicle || '')) {
      entry.row_number = row.row_number; entry.vehicle = String(row.source.vehicle || ''); changed = true;
    }
    if (row.state === 'completed') {
      clearCandidate(entry);
      if (entry.origin !== 'completed' && (entry.accepted || entry.pending || entry.blocked)) addReview(row, ['SOURCE_MARKED_COMPLETED']);
      else if (entry.origin !== 'completed') { entry.origin = 'completed'; changed = true; }
      continue;
    }
    if (entry.origin === 'completed') { clearCandidate(entry); addReview(row, ['COMPLETED_HISTORY_REOPENED']); continue; }
    if (row.state === 'review' || !row.order || !row.tasks.length) {
      clearCandidate(entry);
      addReview(row, row.issues.length ? row.issues : ['INVALID_SOURCE_SCOPE']); continue;
    }
    if (entry.pending) { clearCandidate(entry); addReview(row, ['DELIVERY_PENDING']); continue; }
    if (entry.blocked?.permanent) { clearCandidate(entry); addReview(row, [entry.blocked.code]); continue; }
    const tasks = [...row.tasks].sort((a, b) => a.task_key.localeCompare(b.task_key));
    const inputHash = await hash({ order: row.order, tasks });
    if (entry.accepted?.input_hash === inputHash) { clearCandidate(entry); continue; }
    if (entry.blocked?.input_hash === inputHash) { clearCandidate(entry); addReview(row, [entry.blocked.code]); continue; }
    if (quietPeriodMs > 0) {
      // Native multi-select edits arrive one click at a time. Wait for the same
      // valid canonical scope on two separate polls at least one minute apart
      // before making it claimable. Every later change restarts that window.
      if (!entry.candidate || entry.candidate.input_hash !== inputHash || entry.candidate.first_seen_at > observedAt) {
        entry.candidate = { input_hash: inputHash, first_seen_at: observedAt };
        changed = true; continue;
      }
      if (observedAt - entry.candidate.first_seen_at < quietPeriodMs) continue;
    }
    clearCandidate(entry);
    if (!entry.external_order_id) entry.external_order_id = uuid();
    const taskIds: Record<string, string> = {};
    const payloadTasks = tasks.map(task => {
      taskIds[task.task_key] = entry.accepted?.task_ids[task.task_key] || uuid();
      return { external_task_id: taskIds[task.task_key], work_code: task.work_code, options: task.options, instructions: task.instructions };
    });
    entry.pending = { input_hash: inputHash, task_ids: taskIds, attempts: 0,
      payload: { schema_version: 1, spreadsheet_id: feed.spreadsheet_id, submission_id: uuid(),
        external_order_id: entry.external_order_id, revision: (entry.accepted?.revision || 0) + 1,
        expected_order_version: entry.accepted?.order_version || null, action: 'submit', order: row.order, tasks: payloadTasks } };
    delete entry.blocked;
    changed = true; newEntries.push(entry);
  }
  if (changed) await save();
  for (const entry of newEntries) await deliver(entry);

  // Report delivery/conflict health even if that row was removed from source;
  // removal never emits a cancellation or erases the private registry.
  for (const entry of Object.values(state.entries)) {
    if (entry.pending) addReview(entry, ['DELIVERY_PENDING']);
    if (entry.blocked) addReview(entry, [entry.blocked.code]);
  }
  const entries = Object.values(state.entries);
  return { state, version, review,
    summary: { ...(parsed?.summary || {}), accepted_orders: entries.filter(entry => entry.accepted).length,
      accepted_this_run: acceptedThisRun, awaiting_stability: entries.filter(entry => entry.candidate).length, pending_deliveries: entries.filter(entry => entry.pending).length,
      review_count: review.length } };
}
