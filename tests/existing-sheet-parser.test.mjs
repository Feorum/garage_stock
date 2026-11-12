// Synthetic source rows only. The real Managers' sheet is never changed by tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseExistingSheetCsv, parseExistingSheetRows } from '../supabase/functions/pull-manager-sheets/parser.ts';

const HEADERS = ['Столбец 1', 'День ', 'Менеджер', 'Автомобиль', 'VIN', 'Цвет', 'Оклейка', 'Тонировка', 'Готовность', 'Примечание'];
const VIN = 'TEST0000000000001';
function row(changes = {}) {
  const value = ['13.11.2026', '#REF!', 'Synthetic manager', 'S50', VIN, 'Grey', 'W01', '', 'FALSE', ''];
  for (const [index, replacement] of Object.entries(changes)) value[Number(index)] = replacement;
  return value;
}
function parse(...data) { return parseExistingSheetRows([HEADERS, ...data]); }
function csvCell(value) { const text = String(value); return /[,\r\n"]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; }
function csv(rows) { return rows.map(row => row.map(csvCell).join(',')).join('\r\n'); }

function assertReview(item, code) {
  assert.equal(item.state, 'review'); assert.equal(item.order, null); assert.ok(item.issues.includes(code), item.issues.join(','));
}

test('reads exact existing columns and ignores weekday formula cache', () => {
  const result = parse(row({ 4: ' ' + VIN.toLowerCase() + ' ', 9: 'Collect on Friday' }));
  assert.deepEqual(result.summary, { completed: 0, ready: 1, review: 0, ignored: 0 });
  const item = result.rows[0];
  assert.equal(item.row_number, 2);
  assert.equal(item.source_key, `2026-11-13|${VIN}`);
  assert.equal(item.order.vehicle_group_code, 'VG02');
  assert.equal(item.order.instructions, 'Collect on Friday');
  assert.deepEqual(item.tasks, [{ task_key: 'W01', work_code: 'W01', options: {}, instructions: '' }]);
});

test('RFC CSV supports UTF8 BOM, escaped quotes, multiline notes and CRLF', () => {
  const text = '\uFEFF' + csv([HEADERS, row({ 9: 'Synthetic "quoted", note\nsecond line' })]) + '\r\n';
  const result = parseExistingSheetCsv(text);
  assert.equal(result.rows[0].source.notes, 'Synthetic "quoted", note\nsecond line');
  assert.equal(result.rows[0].state, 'ready');
  assert.equal(parseCsv('a,"b,c"\r\nx,""')[0][1], 'b,c');
});

test('malformed quotes or displaced/unknown headers reject the entire snapshot', () => {
  for (const text of ['a,"b', 'a,b"c', '"a"x,b']) assert.throws(() => parseCsv(text), /MALFORMED_CSV/);
  const header = [...HEADERS]; [header[4], header[5]] = [header[5], header[4]];
  assert.throws(() => parseExistingSheetRows([header, row()]), /HEADER_MISMATCH/);
  assert.throws(() => parseExistingSheetRows([[...HEADERS, 'Unknown field'], row()]), /HEADER_MISMATCH/);
  assert.throws(() => parseExistingSheetCsv('<html>Sign in</html>'), /HEADER_MISMATCH/);
});

test('caps bytes, rows and columns before accepting any snapshot', () => {
  assert.throws(() => parseCsv('x'.repeat(2 * 1024 * 1024 + 1)), /CSV_TOO_LARGE/);
  assert.throws(() => parseCsv('a\n'.repeat(5001)), /TOO_MANY_ROWS/);
  assert.throws(() => parseCsv(Array(27).fill('x').join(',')), /TOO_MANY_COLUMNS/);
  assert.throws(() => parseExistingSheetRows([HEADERS, Array(27).fill('')]), /TOO_MANY_COLUMNS/);
});

test('skips blank checkbox templates and source notices; checked history cannot become pending', () => {
  const result = parse(['', '', '', '', '', '', '', '', 'FALSE'], ['Workshop notice'],
    row({ 6: 'Unrecognized historical service', 8: 'TRUE', 9: 'Done by unknown person' }));
  assert.deepEqual(result.summary, { completed: 1, ready: 0, review: 0, ignored: 2 });
  assert.equal(result.rows[0].state, 'completed');
  assert.equal(result.rows[0].order, null);
  assert.deepEqual(result.rows[0].tasks, []);
});

test('normalizes canonical labels/codes and exact vehicle-group literal members only', () => {
  const result = parse(row({ 3: 'X70', 6: 'W01 — капот полностью; Стойки лобового (2шт)\nЗона над лобовым' }));
  assert.equal(result.rows[0].state, 'ready');
  assert.equal(result.rows[0].order.vehicle_group_code, 'VG05');
  assert.deepEqual(result.rows[0].tasks.map(task => task.work_code), ['W01', 'W10', 'W09']);
  assertReview(parse(row({ 3: 'MONJARO' })).rows[0], 'UNKNOWN_VEHICLE_GROUP');
  assertReview(parse(row({ 6: 'W01 — different unapproved scope' })).rows[0], 'UNKNOWN_WRAPPING_WORK');
  assertReview(parse(row({ 6: 'капот 35' })).rows[0], 'UNKNOWN_WRAPPING_WORK');
});

test('comma splitting preserves the parentheses in a closed-list package name', () => {
  const item = parse(row({ 6: 'W01,крылья целиком (2шт),Зона над лобовым' })).rows[0];
  assert.equal(item.state, 'ready');
  assert.deepEqual(item.tasks.map(task => task.work_code), ['W01', 'W05', 'W09']);
  const tint = parse(row({ 6: 'тонировка задней полусферы (5%,15%)' })).rows[0];
  assertReview(tint, 'UNKNOWN_WRAPPING_WORK');
});

test('explicit closed tint variants work in either column; duplicate references are one task', () => {
  const item = parse(row({ 6: 'W19:5', 7: 'тонировка задней полусферы 5%' })).rows[0];
  assert.equal(item.state, 'ready');
  assert.equal(item.tasks.length, 1);
  assert.deepEqual(item.tasks[0], { task_key: 'W19:5', work_code: 'W19', options: { tint_percent: 5 }, instructions: '' });
  const other = parse(row({ 6: '', 7: 'W19:15' })).rows[0];
  assert.equal(other.state, 'ready'); assert.equal(other.tasks[0].options.tint_percent, 15);
  assertReview(parse(row({ 6: '', 7: 'тонировка 15%' })).rows[0], 'UNKNOWN_TINT_WORK');
  assertReview(parse(row({ 6: '', 7: 'W19' })).rows[0], 'NO_APPROVED_TASKS');
  assertReview(parse(row({ 6: '', 7: 'W19:10' })).rows[0], 'UNKNOWN_TINT_WORK');
});

test('unknown fragment blocks whole row so no partial scope is published', () => {
  const item = parse(row({ 6: 'W01, door seal work' })).rows[0];
  assertReview(item, 'UNKNOWN_WRAPPING_WORK');
  assert.equal(item.tasks[0].work_code, 'W01');
  assert.equal(item.source.wrapping, 'W01, door seal work');
});

test('conflicting scopes and unavailable catalogue pairs stay for Owner review', () => {
  assertReview(parse(row({ 6: 'W01,W04' })).rows[0], 'CONFLICTING_HOOD_SCOPE');
  assertReview(parse(row({ 6: 'W19:5', 7: 'W19:15' })).rows[0], 'CONFLICTING_TINT_OPTIONS');
  assertReview(parse(row({ 3: 'е7', 6: 'W19:5' })).rows[0], 'WORK_UNAVAILABLE_FOR_VEHICLE');
  assertReview(parse(row({ 6: '(W01, W09' })).rows[0], 'MALFORMED_WORK_LIST');
});

test('invalid dates, identities, completion values, formula inputs and oversized fields cannot publish', () => {
  assertReview(parse(row({ 0: '31.02.2026' })).rows[0], 'INVALID_PLANNED_DATE');
  assertReview(parse(row({ 4: 'NOT-A-VIN' })).rows[0], 'INVALID_VIN');
  assertReview(parse(row({ 8: '' })).rows[0], 'INVALID_COMPLETION_FLAG');
  assertReview(parse(row({ 2: '' })).rows[0], 'INVALID_MANAGER');
  assertReview(parse(row({ 9: '=IMPORTDATA("https://example.invalid")' })).rows[0], 'FORMULA_OR_ERROR_IN_INPUT');
  assertReview(parse(row({ 5: 'x'.repeat(81) })).rows[0], 'FIELD_TOO_LONG');
});

test('date normalization survives sorting; VIN alone never merges separate planned visits', () => {
  const first = row({ 0: '2026-11-13' }); const second = row({ 0: '14/11/2026' });
  const before = parse(first, second).rows; const after = parse(second, first).rows;
  assert.equal(before[0].source_key, after[1].source_key);
  assert.notEqual(before[0].source_key, before[1].source_key);
  assert.ok(before.every(item => item.state === 'ready'));
});

test('same VIN/date collisions cannot silently create another copy, even against completed history', () => {
  const result = parse(row({ 8: true }), row({ 6: 'W09' }));
  assert.equal(result.rows[0].state, 'completed');
  assertReview(result.rows[1], 'DUPLICATE_SOURCE_KEY');
});

test('existing partial progress and financial notes require Owner reconciliation', () => {
  for (const notes of ['М (подг капот)', 'Подготовка уже выполнена', 'А (накинул)', 'Цена 100 BYN']) {
    const item = parse(row({ 9: notes })).rows[0];
    assert.equal(item.state, 'review', notes); assert.equal(item.order, null);
  }
  assertReview(parse(row({ 9: 'М (подг капот)' })).rows[0], 'SOURCE_PROGRESS_REQUIRES_REVIEW');
  assertReview(parse(row({ 9: 'Цена 100 BYN' })).rows[0], 'CONFIDENTIAL_NOTE_REQUIRES_REVIEW');
});

test('tagged lines become task instructions while ordinary lines remain order instructions', () => {
  const notes = 'Collect on Friday\n[W01] Позвонить перед началом\n\n[W09] Согласовать время\nOrdinary context';
  const item = parse(row({ 6: 'W01, W09', 9: notes })).rows[0];
  assert.equal(item.state, 'ready');
  assert.equal(item.tasks.find(task => task.work_code === 'W01').instructions, 'Позвонить перед началом');
  assert.equal(item.tasks.find(task => task.work_code === 'W09').instructions, 'Согласовать время');
  assert.equal(item.order.instructions, 'Collect on Friday\n\nOrdinary context');
  assert.equal(item.source.notes, notes);
});

test('tint details can target the selected variant explicitly or by its unique work code', () => {
  const item = parse(row({ 6: 'W19:5', 9: '[W19:5] Позвонить перед началом' })).rows[0];
  assert.equal(item.state, 'ready');
  assert.equal(item.tasks[0].instructions, 'Позвонить перед началом');
  assert.equal(item.order.instructions, '');
  assert.equal(parse(row({ 6: 'W19:15', 9: '[w19] Позвонить перед началом' })).rows[0].state, 'ready');
  assertReview(parse(row({ 6: 'W19:15', 9: '[W19:5] Call first' })).rows[0], 'TASK_DETAIL_TARGET_MISSING');
  assertReview(parse(row({ 6: 'W19:5, W19:15', 9: '[W19] Call first' })).rows[0], 'AMBIGUOUS_TASK_DETAIL_TAG');
});

test('missing, duplicate, malformed or empty task tags require review without dropping the source', () => {
  assertReview(parse(row({ 9: '[W09] Call first' })).rows[0], 'TASK_DETAIL_TARGET_MISSING');
  assertReview(parse(row({ 9: '[W01] First note\n[W01] Different note' })).rows[0], 'DUPLICATE_TASK_DETAIL_TAG');
  assertReview(parse(row({ 9: '[W01:5] First note' })).rows[0], 'INVALID_TASK_DETAIL_TAG');
  assertReview(parse(row({ 9: '[W01 First note' })).rows[0], 'INVALID_TASK_DETAIL_TAG');
  assertReview(parse(row({ 9: '[W01]' })).rows[0], 'EMPTY_TASK_DETAIL');
  assertReview(parse(row({ 9: '[W01] First note [W09] Different note' })).rows[0], 'AMBIGUOUS_TASK_DETAIL_TAG');
  const ordinary = parse(row({ 9: '[General] Call first' })).rows[0];
  assert.equal(ordinary.state, 'ready');
  assert.equal(ordinary.order.instructions, '[General] Call first');
});

test('dimensions and percentage details never silently modify a selected closed package', () => {
  for (const detail of ['[W01] Полоса капота 40см', '[W01] 40 cm', '[W01] 400 мм', '[W01] 400mm', '[W19:5] 15%', 'капот40см']) {
    const item = parse(row({ 6: 'W01,W19:5', 9: detail })).rows[0];
    assertReview(item, 'NONSTANDARD_TASK_DETAIL');
    assert.equal(item.source.notes, detail);
  }
  assert.equal(parse(row({ 9: '[W01] Позвонить в 10:00' })).rows[0].state, 'ready');
});

test('hood detail contradicting full or partial selected scope requires Owner review', () => {
  assertReview(parse(row({ 9: '[W01] Только частично' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  assertReview(parse(row({ 9: 'Часть капота' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  assertReview(parse(row({ 6: 'W03', 9: '[W03] Капот полностью' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  assertReview(parse(row({ 6: 'W04', 9: 'весь капот' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
});

test('tagged financial text and oversized task details cannot publish', () => {
  assertReview(parse(row({ 9: '[W01] Цена 100 BYN' })).rows[0], 'CONFIDENTIAL_NOTE_REQUIRES_REVIEW');
  assertReview(parse(row({ 9: '[W01] ' + 'x'.repeat(2001) })).rows[0], 'TASK_DETAIL_TOO_LONG');
});
