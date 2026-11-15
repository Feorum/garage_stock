// Read-only parser for the existing Managers' sheet. No source edits, prices,
// guessed scope, row-number identities, or spreadsheet formula evaluation.
import { WORKS, VEHICLE_GROUPS, AVAILABLE_WORKS } from './catalogue.ts';

export const PARSER_VERSION = 'alfort-catalogue-comments-v4';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 26;
const HEADERS = ['Столбец 1', 'День', 'Менеджер', 'Автомобиль', 'VIN', 'Цвет', 'Оклейка', 'Тонировка', 'Готовность', 'Примечание'];
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const FINANCIAL_NOTE = /(?:[€$£₽¥]|(?:\d[\d\s.,]*\s*р\.)|(?:^|[^\p{L}])(?:BYN|EUR|USD|VAT|GBP|RUB|PLN|UAH|CNY|BR|price|cost|rate|amount|discount|НДС|руб(?:ль|ля|лей)?|цен(?:а|ы|у|е|ой|ам|ами|ах)?|стоимост[а-я]*|скидк[а-я]*|оплат[а-я]*|сумм(?:а|ы|у|е|ой)?|тариф[а-я]*|ставк[а-я]*|прайс[а-я]*)(?=$|[^\p{L}]))/iu;

export type ParsedTask = {
  task_key: string; work_code: string; options: Record<string, number>; instructions: string;
};
export type ParsedRow = {
  row_number: number;
  source_key: string | null;
  state: 'completed' | 'ready' | 'review';
  source: {
    planned_date: string | null; manager_label: string; vehicle: string; vin: string;
    colour: string; wrapping: string; tint: string; completed: boolean | null; notes: string;
  };
  order: {
    vehicle: string; vin: string; colour: string; vehicle_group_code: string;
    planned_date: string; due_date: null; priority: 'normal';
    manager_label: string; instructions: string;
  } | null;
  tasks: ParsedTask[];
  issues: string[];
};
export type ParsedSheet = {
  parser_version: string; rows: ParsedRow[];
  summary: { completed: number; ready: number; review: number; ignored: number };
};

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');
}
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error('INVALID_CELL');
  return String(value).trim();
}
function unique(values: string[]): string[] { return [...new Set(values)]; }

// RFC4180 quote handling, including quoted commas/newlines and escaped quotes.
// Reject malformed input as a whole rather than accepting a shifted column map.
export function parseCsv(csv: string): string[][] {
  if (typeof csv !== 'string' || new TextEncoder().encode(csv).length > MAX_BYTES) throw new Error('CSV_TOO_LARGE');
  if (csv.startsWith('\uFEFF')) csv = csv.slice(1);
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  const finishCell = () => {
    row.push(cell); cell = ''; closed = false;
    if (row.length > MAX_COLUMNS) throw new Error('TOO_MANY_COLUMNS');
  };
  const finishRow = () => {
    finishCell(); rows.push(row); row = [];
    if (rows.length > MAX_ROWS) throw new Error('TOO_MANY_ROWS');
  };
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += char;
      continue;
    }
    if (closed && char !== ',' && char !== '\r' && char !== '\n') throw new Error('MALFORMED_CSV');
    if (char === '"') {
      if (cell !== '' || closed) throw new Error('MALFORMED_CSV');
      quoted = true;
    } else if (char === ',') finishCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && csv[i + 1] === '\n') i++;
      finishRow();
    } else cell += char;
  }
  if (quoted) throw new Error('MALFORMED_CSV');
  if (cell !== '' || row.length || closed) finishRow();
  return rows;
}

function plannedDate(value: string): string | null {
  let year: number, month: number, day: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) [, year, month, day] = match.map(Number);
  else {
    match = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(value);
    if (!match) return null;
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  }
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}
function completion(value: string): boolean | null {
  if (normalized(value) === 'true') return true;
  if (normalized(value) === 'false') return false;
  return null;
}
function vehicleGroup(value: string): string | null {
  const name = normalized(value);
  const matches = VEHICLE_GROUPS.filter(group => [group.code, group.name, ...group.name.split(/[/\\]/)]
    .some(member => normalized(member) === name));
  return matches.length === 1 ? matches[0].code : null;
}
function scopeParts(value: string): { parts: string[]; malformed: boolean } {
  let depth = 0, start = 0, malformed = false;
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '(') depth++;
    if (char === ')') { depth--; if (depth < 0) { malformed = true; depth = 0; } }
    if (depth === 0 && [',', ';', '\n', '\r'].includes(char)) {
      const part = value.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return { parts, malformed: malformed || depth !== 0 };
}
function canonicalTint(name: string): number | null {
  const match = /^тонировка задней полусферы\s*\(?\s*(5|15)\s*%\s*\)?$/.exec(normalized(name));
  return match ? Number(match[1]) : null;
}
// Recognized shorthand for existing catalogue packages only. Match the entire
// fragment: dimensions, quantities and trailing details must never be discarded.
// Generic pillars/sills, custom sizes and unknown tint scope remain comments;
// they never become a guessed catalogue task.
const WORK_ALIASES: Record<string, string> = {
  'крылья целиком': 'W05',
  'часть крыльев': 'W06',
  'частично крылья': 'W06',
  'фары': 'W07',
  'полоса над лобовым': 'W09',
  'полоса над лобовым стеклом': 'W09',
  'стойки а': 'W10',
  'стойки лобового': 'W10',
  'стойки лобового стекла': 'W10',
  'зона маникюра': 'W11',
};
function recognizedWorkCode(name: string): string | null {
  if (Object.hasOwn(WORK_ALIASES, name)) return WORK_ALIASES[name];
  if (/^(?:капот|полоса капота|полоса капот)\s*45\s*см\.?$/.test(name)) return 'W03';
  if (/^(?:частично капот|часть капота|узкая полоса капот)\s*25\s*см\.?$/.test(name)) return 'W04';
  if (/^канты дверей 4\s*шт\.?$/.test(name)) return 'W16';
  if (/^пороги (?:внутр\.?|внутренние) 4\s*шт\.?$/.test(name)) return 'W17';
  return null;
}
function workTask(value: string): ParsedTask | null {
  const name = normalized(value);
  const tintCode = /^w19:(5|15)(?:\s*[—–-]\s*(.+))?$/.exec(name);
  if (tintCode) {
    const amount = Number(tintCode[1]);
    const baseName = normalized(WORKS.find(work => work.code === 'W19')!.name);
    if (tintCode[2] && tintCode[2] !== baseName && canonicalTint(tintCode[2]) !== amount) return null;
    return { task_key: `W19:${amount}`, work_code: 'W19', options: { tint_percent: amount }, instructions: '' };
  }
  const tintPercent = canonicalTint(name);
  if (tintPercent !== null) return { task_key: `W19:${tintPercent}`, work_code: 'W19', options: { tint_percent: tintPercent }, instructions: '' };
  const codeLabel = /^(w\d{2})(?:\s*[—–-]\s*(.+))?$/.exec(name);
  const alias = recognizedWorkCode(name);
  const work = codeLabel
    ? WORKS.find(work => normalized(work.code) === codeLabel[1] && (!codeLabel[2] || normalized(work.name) === codeLabel[2]))
    : WORKS.find(work => normalized(work.name) === name || work.code === alias);
  if (!work || work.code === 'W19') return null;
  return { task_key: work.code, work_code: work.code, options: {}, instructions: '' };
}

function workSelection(value: string): { task: ParsedTask | null; comment: string | null } {
  const exact = workTask(value);
  if (exact) return { task: exact, comment: null };
  // W09 has no catalogue width constraint. A width after its exact known name
  // is a manual detail, not a different priced package or an inferred dimension.
  const width = /^(.*?)\s+\d+(?:[.,]\d+)?\s*(?:см|мм|cm|mm)\.?$/iu.exec(value);
  if (width && workTask(width[1])?.work_code === 'W09') return { task: workTask(width[1]), comment: value };
  // A separated free-text annotation may follow an independently selected name.
  // Do not reinterpret a mismatched code-label pair or changed fixed dimensions
  // / package quantities as that work. The complete fragment remains visible.
  const annotated = /^(.*?)\s+[—–-]\s+(.+)$/u.exec(value);
  if (annotated && !/^w\d{2}(?::\d+)?$/iu.test(annotated[1].trim())
      && !/\d+(?:[.,]\d+)?\s*(?:см|мм|cm|mm|м|m|%|шт\.?|pcs|pieces)(?!\p{L})/iu.test(annotated[2])
      && !/^\d+(?:[.,]\d+)?$/u.test(annotated[2].trim())
      && !/\b(?:rear|front|inner|outer|repair|replace|paint|partial|whole|full)\b/iu.test(annotated[2])
      && !/частич|част[ьи]\s+капот|полос|не\s+полност|целик|полност|full\s+hood|hood\s+strip|задн|передн|наруж|внешн|внутр|ремонт|замен|покрас|окрас|(?:^|\s)(?:один|одна|одно|одну|два|две|три|четыре|one|two|three|four)(?:\s|$)/iu.test(annotated[2])) {
    const task = workTask(annotated[1]);
    if (task) return { task, comment: value };
  }
  return { task: null, comment: value };
}

function hoodConflict(detail: string, selected: ParsedTask[]): boolean {
  const value = normalized(detail);
  if (selected.some(task => task.work_code === 'W01') && /(?:частич|част[ьи]\s*(?:капот|hood)|полос|не\s+полност|partial|hood\s+strip)/iu.test(value)) return true;
  return selected.some(task => ['W03', 'W04'].includes(task.work_code))
    && /(?:полност|целик|весь\s+капот|full\s+hood|whole\s+hood)/iu.test(value);
}
function tintConflict(detail: string, selected: ParsedTask[]): boolean {
  return selected.some(task => task.work_code === 'W19'
    && [...detail.matchAll(/(\d+(?:[.,]\d+)?)\s*%/gu)].some(match => Number(match[1].replace(',', '.')) !== task.options.tint_percent));
}
function generalDetailConflict(detail: string, selected: ParsedTask[]): boolean {
  return (/капот|hood/iu.test(detail) && hoodConflict(detail, selected))
    || (/тонир|полусфер|tint|w19/iu.test(detail) && tintConflict(detail, selected));
}

// J may contain ordinary order instructions and explicit per-task lines.
// Keep the original J value in source.notes. Unplaceable tags stay visible as
// ordinary comments; no detail creates a package, option or reassignment.
function taskNotes(notes: string, tasks: ParsedTask[]): { instructions: string; issues: string[] } {
  const ordinary: string[] = [], issues: string[] = [];
  const targets = new Set<string>();
  for (const line of notes.split(/\r?\n/)) {
    const trimmed = line.trim();
    const tag = /^\[\s*(W\d{2})(?::(\d+))?\s*\]\s*(.*)$/iu.exec(trimmed);
    if (!tag) {
      ordinary.push(line);
      if (generalDetailConflict(trimmed, tasks)) issues.push('NONSTANDARD_TASK_DETAIL');
      continue;
    }
    const workCode = tag[1].toUpperCase(), option = tag[2], detail = tag[3].trim();
    const candidates = tasks.filter(task => task.work_code === workCode
      && (option === undefined || task.task_key === `${workCode}:${option}`));
    const validOption = option === undefined || (workCode === 'W19' && ['5', '15'].includes(option));
    if (!validOption || candidates.length !== 1 || !detail || /\[\s*w\d/iu.test(detail)
        || (candidates.length === 1 && targets.has(candidates[0].task_key)) || detail.length > 2000) {
      ordinary.push(line);
    } else {
      const task = candidates[0];
      task.instructions = detail; targets.add(task.task_key);
    }
    if (detail.length > 2000) issues.push('TASK_DETAIL_TOO_LONG');
    if (hoodConflict(detail, candidates) || tintConflict(detail, candidates) || generalDetailConflict(trimmed, tasks)) issues.push('NONSTANDARD_TASK_DETAIL');
  }
  return { instructions: ordinary.join('\n').trim(), issues: unique(issues) };
}

// Preparation/placement notes are comments, not task status. Hold only explicit
// completion of a selected task or the whole order; never complete app work here.
function completedSelectedWork(value: string, tasks: ParsedTask[]): boolean {
  const mentions: Record<string, RegExp> = {
    W01: /капот|hood/iu, W02: /бампер|bumper/iu, W03: /капот|hood/iu, W04: /капот|hood/iu,
    W05: /крыл|wing/iu, W06: /крыл|wing/iu, W07: /фар|headlight/iu, W08: /птф|fog\s*light/iu,
    W09: /над\s+лобов|above.*windshield/iu, W10: /стойк.*(?:лобов|\sа(?:\W|$))|windshield.*pillar/iu,
    W11: /маникюр|manicure/iu, W12: /погруз|loading\s+zone/iu, W13: /зеркал|mirror/iu,
    W14: /нижн.*передн.*двер/iu, W15: /нижн.*задн.*двер/iu, W16: /кант.*двер|door\s+edge/iu,
    W17: /порог|sill/iu, W18: /арки|акрки|arch/iu, W19: /тонир|полусфер|tint/iu,
  };
  return value.split(/[\r\n;,]/u).some(clause => {
    let subject: string[] = [];
    // An explicit completion elsewhere must not disappear behind a preparation
    // clause. A trailing "after preparation" also does not undo completion.
    return normalized(clause).replace(/(?:после|до)\s+подготовк[а-я]*/giu, '').split(/\s+и\s+/u).some(note => {
      const mentioned = Object.entries(mentions).filter(([code, name]) => name.test(note)
        || new RegExp(`(?:^|[^\\p{L}\\p{N}])${code}(?:[^\\p{L}\\p{N}]|$)`, 'iu').test(note)).map(([code]) => code);
      const preparation = /подготовк|(?:^|[^а-я])подг(?:[^а-я]|$)|накин/iu.test(note);
      if (mentioned.length && !preparation) subject = mentioned;
      if (preparation || !/(?:^|[^\p{L}])(?:сделан[аоы]?|готов[аоы]?|завершен[аоы]?|выполнен[аоы]?|закончен[аоы]?|completed|done|finished)(?:[^\p{L}]|$)/iu.test(note)) return false;
      if (/будет|будут|когда|если|\b(?:when|if)\b/iu.test(note)
          || /не\s+(?:все|весь|сделан|готов|заверш|выполн|закончен)|\b(?:not|isn't|wasn't)\s+(?:(?:yet|all)\s+)?(?:done|finished|completed|work|tasks)\b/iu.test(note)
          || /готов[аоы]?\s+к(?:\s|$)/iu.test(note)) return false;
      if (/все\s+работы|весь\s+заказ|заказ\s+полностью|все\s+сделано|all\s+(?:work|tasks)/iu.test(note)) return true;
      return tasks.some(task => subject.includes(task.work_code));
    });
  });
}

export function parseExistingSheetRows(input: unknown[][]): ParsedSheet {
  if (!Array.isArray(input) || !input.length || input.length > MAX_ROWS) throw new Error('INVALID_ROWS');
  const grid = input.map(row => {
    if (!Array.isArray(row) || row.length > MAX_COLUMNS) throw new Error('TOO_MANY_COLUMNS');
    return row.map(text);
  });
  if (new TextEncoder().encode(JSON.stringify(grid)).length > MAX_BYTES) throw new Error('CSV_TOO_LARGE');
  const header = grid[0];
  if (HEADERS.some((value, index) => normalized(header[index] || '') !== normalized(value))
      || header.slice(10).some(Boolean)) throw new Error('HEADER_MISMATCH');
  const rows: ParsedRow[] = [];
  let ignored = 0;
  for (let index = 1; index < grid.length; index++) {
    const values = Array.from({ length: MAX_COLUMNS }, (_, column) => grid[index][column] || '');
    // Notice/date-only rows and prefilled empty checkboxes have no order content.
    if (![2, 3, 4, 5, 6, 7, 9].some(column => values[column] !== '')) { ignored++; continue; }
    const source = {
      planned_date: plannedDate(values[0]), manager_label: values[2], vehicle: values[3],
      vin: values[4].toUpperCase(), colour: values[5], wrapping: values[6], tint: values[7],
      completed: completion(values[8]), notes: values[9],
    };
    const sourceKey = source.planned_date && VIN.test(source.vin) ? `${source.planned_date}|${source.vin}` : null;
    const item: ParsedRow = { row_number: index + 1, source_key: sourceKey, source,
      state: source.completed === true ? 'completed' : 'review', order: null, tasks: [], issues: [] };
    rows.push(item);
    if (source.completed === true) continue;
    const issues: string[] = [];
    if (!source.planned_date) issues.push('INVALID_PLANNED_DATE');
    if (!VIN.test(source.vin)) issues.push('INVALID_VIN');
    if (source.completed !== false) issues.push('INVALID_COMPLETION_FLAG');
    if (!source.manager_label || source.manager_label.length > 120) issues.push('INVALID_MANAGER');
    if (!source.vehicle || source.vehicle.length > 200) issues.push('INVALID_VEHICLE');
    if (source.colour.length > 80 || source.notes.length > 4000 || source.wrapping.length > 4000 || source.tint.length > 4000) issues.push('FIELD_TOO_LONG');
    if (values.slice(10).some(Boolean)) issues.push('UNEXPECTED_COLUMN_CONTENT');
    if ([0, 2, 3, 4, 5, 6, 7, 8, 9].some(column => /^(?:=|#REF!|#VALUE!|#ERROR!|#N\/A\b)/i.test(values[column]))) issues.push('FORMULA_OR_ERROR_IN_INPUT');
    const group = vehicleGroup(source.vehicle);
    if (!group) issues.push('UNKNOWN_VEHICLE_GROUP');
    const tasks: ParsedTask[] = [];
    const comments: string[] = [], unmatchedFields: string[] = [];
    for (const field of ['wrapping', 'tint'] as const) {
      const scope = source[field];
      if (!scope) continue;
      const fragments = scopeParts(scope);
      const unmatched: string[] = [];
      // Unbalanced free text cannot be split into reliable task selections.
      // Preserve that whole cell as a comment; the other column is independent.
      if (fragments.malformed) unmatched.push(scope);
      for (const fragment of fragments.malformed ? [] : fragments.parts) {
        const selected = workSelection(fragment), task = selected.task;
        if (selected.comment) unmatched.push(selected.comment);
        if (task && !tasks.some(existing => existing.task_key === task.task_key)) tasks.push(task);
      }
      if (unmatched.length) {
        unmatchedFields.push(field === 'wrapping' ? 'UNKNOWN_WRAPPING_WORK' : 'UNKNOWN_TINT_WORK');
        comments.push(`Manager comment — ${field}:\n${unmatched.join('\n')}`);
      }
    }
    if (!tasks.length) issues.push('NO_APPROVED_TASKS', ...unmatchedFields);
    if (tasks.filter(task => ['W01', 'W03', 'W04'].includes(task.work_code)).length > 1) issues.push('CONFLICTING_HOOD_SCOPE');
    if (tasks.filter(task => task.work_code === 'W19').length > 1) issues.push('CONFLICTING_TINT_OPTIONS');
    if (comments.some(comment => comment.split(/\r?\n/u).some(detail => generalDetailConflict(detail, tasks)))) issues.push('NONSTANDARD_TASK_DETAIL');
    if (group && tasks.some(task => !(AVAILABLE_WORKS as Record<string, string[]>)[group]?.includes(task.work_code))) issues.push('WORK_UNAVAILABLE_FOR_VEHICLE');
    if ([source.wrapping, source.tint, source.notes].some(value => completedSelectedWork(value, tasks))) issues.push('SOURCE_PROGRESS_REQUIRES_REVIEW');
    if ([source.wrapping, source.tint, source.notes].some(value => FINANCIAL_NOTE.test(normalized(value)))) issues.push('CONFIDENTIAL_NOTE_REQUIRES_REVIEW');
    const notes = taskNotes(source.notes, tasks);
    issues.push(...notes.issues);
    const instructions = [notes.instructions, ...comments].filter(Boolean).join('\n\n');
    if (instructions.length > 4000) issues.push('FIELD_TOO_LONG');
    item.tasks = tasks;
    item.issues = unique(issues);
    if (!item.issues.length && group && source.planned_date) {
      item.state = 'ready';
      item.order = { vehicle: source.vehicle, vin: source.vin, colour: source.colour,
        vehicle_group_code: group, planned_date: source.planned_date, due_date: null,
        priority: 'normal', manager_label: source.manager_label, instructions };
    }
  }
  const identities = new Map<string, ParsedRow[]>();
  for (const row of rows) if (row.source_key) identities.set(row.source_key, [...(identities.get(row.source_key) || []), row]);
  for (const duplicates of identities.values()) if (duplicates.length > 1) {
    for (const row of duplicates) {
      row.issues = unique([...row.issues, 'DUPLICATE_SOURCE_KEY']);
      if (row.state !== 'completed') { row.state = 'review'; row.order = null; }
    }
  }
  return { parser_version: PARSER_VERSION, rows, summary: {
    completed: rows.filter(row => row.state === 'completed').length,
    ready: rows.filter(row => row.state === 'ready').length,
    review: rows.filter(row => row.state === 'review').length, ignored,
  } };
}

export function parseExistingSheetCsv(csv: string): ParsedSheet {
  return parseExistingSheetRows(parseCsv(csv));
}
