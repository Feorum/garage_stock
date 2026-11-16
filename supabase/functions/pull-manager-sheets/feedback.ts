import { parseCsv, parseExistingSheetRows, type ParsedSheet } from './parser.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KEY = /^\d{4}-\d{2}-\d{2}\|[A-HJ-NPR-Z0-9]{17}$/;
type Output = { block: string; complete: boolean };
export type FeedbackRow = Output & {
  order_id: string; order_number: string; order_version: number; source_keys: string[];
  known_outputs: Output[]; operational_scope?: { order: Record<string, unknown>; tasks: any[] };
};

function object(value: any): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validOutput(value: any): boolean {
  return object(value) && typeof value.block === 'string' && value.block.length <= 20000 && typeof value.complete === 'boolean';
}
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function feedbackRows(value: any, version: number): FeedbackRow[] {
  if (!object(value) || value.version !== version || !Array.isArray(value.rows) || value.rows.length > 5000) throw new Error('INVALID_FEEDBACK');
  const ids = new Set<string>();
  for (const row of value.rows) {
    if (!validOutput(row) || !UUID.test(row.order_id) || ids.has(row.order_id) || !/^G-\d+$/.test(row.order_number)
        || !Number.isInteger(row.order_version) || row.order_version < 1 || !Array.isArray(row.source_keys)
        || !row.source_keys.length || row.source_keys.some((key: any) => typeof key !== 'string' || !SOURCE_KEY.test(key))
        || !Array.isArray(row.known_outputs) || row.known_outputs.length > 1000 || row.known_outputs.some((item: any) => !validOutput(item))
        || !row.known_outputs.some((item: Output) => item.block === row.block && item.complete === row.complete)
        || !row.block.startsWith(`[Garage ${row.order_number}]\n`) || !row.block.endsWith('\n[/Garage]')) throw new Error('INVALID_FEEDBACK');
    ids.add(row.order_id);
  }
  return value.rows;
}
function uniqueBindings(parsed: ParsedSheet, rows: FeedbackRow[]) {
  const counts = new Map<string, number>(), matches = new Map<string, FeedbackRow[]>();
  for (const row of parsed.rows) if (row.source_key) counts.set(row.source_key, (counts.get(row.source_key) || 0) + 1);
  for (const row of rows) for (const key of new Set(row.source_keys)) matches.set(key, [...(matches.get(key) || []), row]);
  const candidates = parsed.rows.filter(row => row.source_key && counts.get(row.source_key) === 1 && matches.get(row.source_key)?.length === 1);
  const orderCounts = new Map<string, number>();
  for (const row of candidates) {
    const id = matches.get(row.source_key!)![0].order_id;
    orderCounts.set(id, (orderCounts.get(id) || 0) + 1);
  }
  return new Map(candidates.filter(row => orderCounts.get(matches.get(row.source_key!)![0].order_id) === 1)
    .map(row => [row.source_key!, matches.get(row.source_key!)![0]]));
}

// Only exact issued suffixes bound to this source/order are application output.
// Manager-authored markers and outputs copied from another vehicle stay input.
export function normalizeFeedbackCsv(csv: string, rows: FeedbackRow[]): ParsedSheet {
  const grid = parseCsv(csv), original = parseExistingSheetRows(grid), bindings = uniqueBindings(original, rows);
  for (const row of original.rows) {
    const feedback = row.source_key ? bindings.get(row.source_key) : null;
    if (!feedback) continue;
    const cells = grid[row.row_number - 1], notes = String(cells[9] || '');
    const known = [...feedback.known_outputs].sort((a, b) => b.block.length - a.block.length)
      .find(output => notes === output.block || notes.endsWith('\n\n' + output.block));
    if (!known) continue;
    cells[9] = notes === known.block ? '' : notes.slice(0, -(known.block.length + 2));
    if (known.complete && String(cells[8]).trim().toLowerCase() === 'true') cells[8] = 'FALSE';
  }
  return parseExistingSheetRows(grid);
}

// A comment refresh is not a request to amend work already accepted by the app.
export function unchangedScopeKeys(parsed: ParsedSheet, rows: FeedbackRow[]): string[] {
  const bindings = uniqueBindings(parsed, rows);
  const orderFields = ['vehicle', 'vin', 'colour', 'vehicle_group_code', 'planned_date', 'due_date', 'priority', 'manager_label'];
  return parsed.rows.filter(row => {
    const scope = row.source_key ? bindings.get(row.source_key)?.operational_scope : null;
    if (!row.order || !scope || !object(scope.order) || !Array.isArray(scope.tasks)) return false;
    const order = Object.fromEntries(orderFields.map(key => [key, row.order![key as keyof typeof row.order] ?? null]));
    const expected = Object.fromEntries(orderFields.map(key => [key, scope.order[key] ?? null]));
    const tasks = (values: any[]) => values.map(task => ({ work_code: task.work_code, options: task.options || {}, instructions: task.instructions || '' }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
    return canonical(order) === canonical(expected) && canonical(tasks(row.tasks)) === canonical(tasks(scope.tasks));
  }).map(row => row.source_key!);
}

export function managerComments(parsed: ParsedSheet, feedback?: FeedbackRow[]) {
  const counts = new Map<string, number>();
  const bindings = feedback ? uniqueBindings(parsed, feedback) : null;
  const knownKeys = new Set(feedback?.flatMap(row => row.source_keys) || []);
  for (const row of parsed.rows) if (row.source_key) counts.set(row.source_key, (counts.get(row.source_key) || 0) + 1);
  return parsed.rows.filter(row => row.source_key && counts.get(row.source_key) === 1 && row.state !== 'completed'
      && (!knownKeys.has(row.source_key) || bindings?.has(row.source_key))
      && !row.issues.some(code => ['CONFIDENTIAL_NOTE_REQUIRES_REVIEW', 'FIELD_TOO_LONG', 'FORMULA_OR_ERROR_IN_INPUT'].includes(code)))
    .map(row => ({ source_key: row.source_key, comment: row.manager_comment || '' }));
}

export async function publicFeedback(csv: string, rows: FeedbackRow[]) {
  const grid = parseCsv(csv), parsed = parseExistingSheetRows(grid), bindings = uniqueBindings(parsed, rows);
  const writable = parsed.rows.filter(row => {
    const value = row.source_key ? bindings.get(row.source_key) : null;
    if (!value) return false;
    const cells = grid[row.row_number - 1], flag = String(cells[8] || '').trim().toLowerCase(), notes = String(cells[9] || '');
    if (flag === 'false') return true;
    // A human checkbox is a reconciliation signal, never an output location
    // that may be cleared merely because application work is still pending.
    return flag === 'true' && value.known_outputs.some(output => output.complete
      && (notes === output.block || notes.endsWith('\n\n' + output.block)));
  });
  return await Promise.all(writable.map(async row => {
    const value = bindings.get(row.source_key!)!;
    const observed = Array.from({ length: 10 }, (_, index) => String(grid[row.row_number - 1][index] ?? ''));
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(observed)));
    const observation_hash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    return { source_key: row.source_key, source_keys: [...new Set(value.source_keys)], order_id: value.order_id,
      order_number: value.order_number, block: value.block, complete: value.complete,
      known_outputs: value.known_outputs.map(item => ({ block: item.block, complete: item.complete })),
      row_number: row.row_number, observation_hash };
  }));
}

// A successful read confirms a write only after its exact current output is
// observed back in the workbook. Issuing a block alone is not confirmation.
export function feedbackSummary(csv: string, rows: { row_number: number; block: string; complete: boolean }[]) {
  const grid = parseCsv(csv);
  let confirmed = 0;
  for (const row of rows) {
    const cells = grid[row.row_number - 1], notes = String(cells?.[9] || '');
    if (String(cells?.[8] || '').trim().toLowerCase() === String(row.complete)
        && (notes === row.block || notes.endsWith('\n\n' + row.block))) confirmed++;
  }
  return { feedback_confirmed: confirmed, feedback_pending: rows.length - confirmed };
}
