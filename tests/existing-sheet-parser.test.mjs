// Synthetic source rows only. The real Managers' sheet is never changed by tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseExistingSheetCsv, parseExistingSheetRows } from '../supabase/functions/pull-manager-sheets/parser.ts';
import { actVehicleName, vehicleChoices } from '../supabase/functions/_shared/vehicle-models.ts';

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
  assert.equal(parse(row({ 3: 'MONJARO' })).rows[0].order.vehicle_group_code, 'VG12');
  assertReview(parse(row({ 6: 'W01 — different unapproved scope' })).rows[0], 'UNKNOWN_WRAPPING_WORK');
  assertReview(parse(row({ 6: 'капот 35' })).rows[0], 'UNKNOWN_WRAPPING_WORK');
});

test('model selection preserves brand, finish and year with the price group of that visit', () => {
  for (const [vehicle, group] of [['BELGEE X50+', 'VG08'], ['GEELY COOLRAY', 'VG08'],
    ['GEELY ATLAS (ФХ11)', 'VG04'], ['BELGEE X70', 'VG05'], ['GEELY ATLAS PRO', 'VG05'],
    ['GEELY MONJARO (матовый)', 'VG12'], ['GEELY OKAVANGO 2024', 'VG13']]) {
    const item = parse(row({ 3: vehicle })).rows[0];
    assert.equal(item.order.vehicle, vehicle);
    assert.equal(item.raw.vehicle, vehicle);
    assert.equal(item.order.vehicle_group_code, group);
  }
  assert.equal(parse(row({ 3: 'ФХ11' })).rows[0].order.vehicle, 'GEELY ATLAS (ФХ11)');
  assert.equal(parse(row({ 3: 'ФХ11 (Atlas)' })).rows[0].order.vehicle_group_code, 'VG04');
  assert.equal(actVehicleName('GEELY MONJARO (матовый)'), 'MONJARO');
  assert.equal(actVehicleName('GEELY MONJARO'), 'MONJARO');
  assert.equal(actVehicleName('Старая запись'), 'Старая запись');
  assertReview(parse(row({ 3: 'GEELY OKAVANGO 2025' })).rows[0], 'UNKNOWN_VEHICLE_GROUP');
  assertReview(parse(row({ 3: 'OKAVANGO' })).rows[0], 'UNKNOWN_VEHICLE_GROUP');
  const rows = [{ name: 'Okovango 20-24', code: 'old' }, { name: 'OKAVANGO 2026', code: 'new' }];
  assert.equal(vehicleChoices(rows).find(model => model.label === 'GEELY OKAVANGO 2026')?.group, 'new');
});

test('recognized Manager shorthand publishes the same closed catalogue work', () => {
  const wrapping = 'капот 45 см, полоса над лобовым';
  const item = parse(row({ 3: 'EX5', 6: wrapping })).rows[0];
  assert.equal(item.state, 'ready');
  assert.equal(item.order.vehicle_group_code, 'VG15');
  assert.deepEqual(item.tasks.map(task => task.task_key), ['W03', 'W09']);
  assert.equal(item.source.wrapping, wrapping);
  const headlights = parse(row({ 3: 'EX2', 6: 'Фары' })).rows[0];
  assert.equal(headlights.state, 'ready');
  assert.deepEqual(headlights.tasks, [{ task_key: 'W07', work_code: 'W07', options: {}, instructions: '' }]);
});

test('service abbreviations keep package identity and deduplicate canonical mentions', () => {
  const item = parse(row({ 6: 'частично капот 25 см, часть крыльев, стойки А, полоса над лобовым стеклом, зона маникюра, канты дверей 4шт., пороги внутр 4 шт, W10' })).rows[0];
  assert.equal(item.state, 'ready');
  assert.deepEqual(item.tasks.map(task => task.task_key), ['W04', 'W06', 'W10', 'W09', 'W11', 'W16', 'W17']);
  const fullWings = parse(row({ 6: 'полоса капота 45см, крылья целиком, стойки лобового стекла' })).rows[0];
  assert.equal(fullWings.state, 'ready');
  assert.deepEqual(fullWings.tasks.map(task => task.task_key), ['W03', 'W05', 'W10']);
});

test('unmatched scopes stay visible without creating a guessed package or quantity', () => {
  for (const scope of ['капот 40 см',
    'стойки', 'пороги 4шт.', 'канты дверей', 'зона погрузки багажника',
    'крылья целиком 1шт', 'часть крыльев 1шт', 'зона маникюра 2шт',
    'Фары задние', 'Фары 1шт',
    'антиманикюр (Сертификат)', 'W03 — капот 40 см']) {
    const item = parse(row({ 6: 'W01, ' + scope })).rows[0];
    assert.equal(item.state, 'ready', scope);
    assert.deepEqual(item.tasks.map(task => task.task_key), ['W01']);
    assert.equal(item.order.instructions, 'Manager comment — wrapping:\n' + scope);
    assert.equal(item.source.wrapping, 'W01, ' + scope);
  }
});

test('recognized wrapping preserves unknown tint and preparation notes as comments', () => {
  const wrapping = 'капот 45 см, полоса над лобовым, частично крылья, стойки лобового, зона маникюра';
  const tinted = parse(row({ 6: wrapping, 7: 'тонировка 5%' })).rows[0];
  assert.equal(tinted.state, 'ready');
  assert.equal(tinted.order.instructions, 'Manager comment — tint:\nтонировка 5%');
  assert.ok(tinted.tasks.every(task => task.work_code !== 'W19'));
  const preparation = parse(row({ 6: wrapping, 9: 'М (подг капот)' })).rows[0];
  assert.equal(preparation.state, 'ready');
  assert.equal(preparation.order.instructions, 'М (подг капот)');
  assertReview(parse(row({ 6: '(капот 45 см, полоса над лобовым' })).rows[0], 'NO_APPROVED_TASKS');
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

test('independent catalogue work imports with the unknown fragment as a visible Manager comment', () => {
  const item = parse(row({ 6: 'W01, door seal work' })).rows[0];
  assert.equal(item.state, 'ready');
  assert.deepEqual(item.issues, []);
  assert.equal(item.tasks[0].work_code, 'W01');
  assert.equal(item.order.instructions, 'Manager comment — wrapping:\ndoor seal work');
  assert.equal(item.source.wrapping, 'W01, door seal work');
});

test('conflicting scopes and unavailable catalogue pairs stay for Owner review', () => {
  assertReview(parse(row({ 6: 'W01,W04' })).rows[0], 'CONFLICTING_HOOD_SCOPE');
  assertReview(parse(row({ 6: 'W19:5', 7: 'W19:15' })).rows[0], 'CONFLICTING_TINT_OPTIONS');
  assertReview(parse(row({ 3: 'е7', 6: 'W19:5' })).rows[0], 'WORK_UNAVAILABLE_FOR_VEHICLE');
  assertReview(parse(row({ 6: '(W01, W09' })).rows[0], 'NO_APPROVED_TASKS');
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

test('preparation and placement notes do not invent task status', () => {
  for (const notes of ['М (подг капот)', 'Подготовка уже выполнена', 'А (накинул)',
    'Капот будет готов завтра', 'Капот не готов', 'Капот готов к оклейке', 'Не все работы сделаны', 'W01 not yet done']) {
    const item = parse(row({ 9: notes })).rows[0];
    assert.equal(item.state, 'ready', notes);
    assert.equal(item.order.instructions, notes);
    assert.equal(item.source.completed, false);
    assert.deepEqual(item.tasks, [{ task_key: 'W01', work_code: 'W01', options: {}, instructions: '' }]);
  }
});

test('explicit completion of selected work or all work still requires reconciliation', () => {
  for (const notes of ['Капот сделан', '[W01] Сделано', 'W01 выполнен', 'Все работы завершены',
    'Капот подготовлен и полностью сделан', 'Все работы завершены после подготовки', 'Подготовка выполнена и капот сделан']) {
    assertReview(parse(row({ 9: notes })).rows[0], 'SOURCE_PROGRESS_REQUIRES_REVIEW');
  }
  assert.equal(parse(row({ 6: 'W09', 9: 'Капот сделан' })).rows[0].state, 'ready');
  assertReview(parse(row({ 6: 'W01, капот готов' })).rows[0], 'SOURCE_PROGRESS_REQUIRES_REVIEW');
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
  const missing = parse(row({ 6: 'W19:15', 9: '[W19:5] Call first' })).rows[0];
  assert.equal(missing.state, 'ready');
  assert.equal(missing.order.instructions, '[W19:5] Call first');
  assertReview(parse(row({ 6: 'W19:5, W19:15', 9: '[W19] Call first' })).rows[0], 'CONFLICTING_TINT_OPTIONS');
});

test('unplaceable task tags remain visible as order comments and never create work', () => {
  for (const notes of ['[W09] Call first', '[W20] Custom work', '[W01:5] First note', '[W01 First note',
    '[W01]', '[W01] First note [W09] Different note']) {
    const item = parse(row({ 9: notes })).rows[0];
    assert.equal(item.state, 'ready', notes);
    assert.equal(item.order.instructions, notes);
    assert.deepEqual(item.tasks, [{ task_key: 'W01', work_code: 'W01', options: {}, instructions: '' }]);
    assert.equal(item.source.notes, notes);
  }
  const duplicate = parse(row({ 9: '[W01] First note\n[W01] Different note' })).rows[0];
  assert.equal(duplicate.state, 'ready');
  assert.equal(duplicate.tasks[0].instructions, 'First note');
  assert.equal(duplicate.order.instructions, '[W01] Different note');
  const ordinary = parse(row({ 9: '[General] Call first' })).rows[0];
  assert.equal(ordinary.state, 'ready');
  assert.equal(ordinary.order.instructions, '[General] Call first');
});

test('dimensions and percentage details never silently modify a selected closed package', () => {
  for (const detail of ['[W01] 40 cm', '[W01] 400 мм', '[W01] 400mm', 'капот40см']) {
    const item = parse(row({ 6: 'W01,W19:5', 9: detail })).rows[0];
    assert.equal(item.state, 'ready', detail);
    assert.deepEqual(item.tasks.map(task => [task.task_key, task.options]), [['W01', {}], ['W19:5', { tint_percent: 5 }]]);
    assert.ok((item.order.instructions + item.tasks.map(task => task.instructions).join('\n')).includes(detail.replace('[W01] ', '')));
    assert.equal(item.source.notes, detail);
  }
  for (const detail of ['[W01] Полоса капота 40см', '[W19:5] 15%', 'тонировка 15%']) {
    assertReview(parse(row({ 6: 'W01,W19:5', 9: detail })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  }
  assert.equal(parse(row({ 9: '[W01] Позвонить в 10:00' })).rows[0].state, 'ready');
});

test('hood detail contradicting full or partial selected scope requires Owner review', () => {
  assertReview(parse(row({ 9: '[W01] Только частично' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  assertReview(parse(row({ 9: 'Часть капота' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  assertReview(parse(row({ 6: 'W03', 9: '[W03] Капот полностью' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  assertReview(parse(row({ 6: 'W04', 9: 'весь капот' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  for (const wrapping of ['W01; капот полностью - полоса 40 см', 'W01; Часть капота', 'W01; Частикапота']) {
    assertReview(parse(row({ 6: wrapping })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  }
  assertReview(parse(row({ 6: 'W19:5; тонировка 15%' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
  assertReview(parse(row({ 6: 'W19:5', 9: '[W19:15] 15%' })).rows[0], 'NONSTANDARD_TASK_DETAIL');
});

test('tagged financial text and oversized task details cannot publish', () => {
  assertReview(parse(row({ 9: '[W01] Цена 100 BYN' })).rows[0], 'CONFIDENTIAL_NOTE_REQUIRES_REVIEW');
  assertReview(parse(row({ 9: '[W01] ' + 'x'.repeat(2001) })).rows[0], 'TASK_DETAIL_TOO_LONG');
});

test('W09 width and separated free-text annotations remain manual comments on exact selections', () => {
  for (const scope of ['полоса над лобовым стеклом 20 см', 'Зона над лобовым 200мм', 'полоса над лобовым 25 cm']) {
    const item = parse(row({ 6: scope })).rows[0];
    assert.equal(item.state, 'ready', scope);
    assert.deepEqual(item.tasks, [{ task_key: 'W09', work_code: 'W09', options: {}, instructions: '' }]);
    assert.equal(item.order.instructions, 'Manager comment — wrapping:\n' + scope);
    assert.equal(item.source.wrapping, scope);
  }
  const annotated = parse(row({ 6: 'зона маникюра - Synthetic person', 9: 'Call first' })).rows[0];
  assert.equal(annotated.state, 'ready');
  assert.deepEqual(annotated.tasks, [{ task_key: 'W11', work_code: 'W11', options: {}, instructions: '' }]);
  assert.equal(annotated.order.instructions, 'Call first\n\nManager comment — wrapping:\nзона маникюра - Synthetic person');
  assert.equal(annotated.order.manager_label, 'Synthetic manager');
  for (const scope of ['капот 40 см', 'капот полностью - полоса 40 см', 'Полоса капот 45см. - 40см',
    'зона маникюра - 2шт', 'Фары - задние', 'Фары - rear', 'пороги внутренние 4шт - outer', 'Фары передние - только одна',
    'Погрузочная зона 20 см*1м - 2м', 'W01 — different scope']) {
    const item = parse(row({ 6: scope, 7: 'W19:5' })).rows[0];
    assert.equal(item.state, 'ready', scope);
    assert.deepEqual(item.tasks.map(task => task.task_key), ['W19:5']);
    assert.equal(item.order.instructions, 'Manager comment — wrapping:\n' + scope);
  }
});

test('malformed lists preserve the whole cell while independent selections in the other column remain valid', () => {
  for (const wrapping of ['(', '(W01, W09', 'W01, custom (W09; W10)', 'W01, custom (W09\nW10)']) {
    const item = parse(row({ 6: wrapping, 7: 'W19:15' })).rows[0];
    assert.equal(item.state, 'ready', wrapping);
    assert.equal(item.source.wrapping, wrapping);
    assert.ok(item.order.instructions.startsWith('Manager comment — wrapping:\n'));
    assert.ok(item.tasks.every(task => !['W09', 'W10'].includes(task.task_key)));
    assert.ok(item.tasks.some(task => task.task_key === 'W19:15'));
    if (wrapping.startsWith('(')) {
      assert.deepEqual(item.tasks.map(task => task.task_key), ['W19:15']);
      assert.equal(item.order.instructions, 'Manager comment — wrapping:\n' + wrapping);
    }
  }
});

test('all unmatched content has origin labels, no tint inference, and no loss of source text', () => {
  const wrapping = 'W01; Custom body work; unknown dimensions 35 см';
  const tint = 'Тонер 5; tint percentage to be confirmed';
  const notes = '[W99] Additional manual request\nCollect on Friday';
  const item = parse(row({ 6: wrapping, 7: tint, 9: notes })).rows[0];
  assert.equal(item.state, 'ready');
  assert.deepEqual(item.tasks.map(task => task.task_key), ['W01']);
  assert.equal(item.order.instructions, notes + '\n\nManager comment — wrapping:\nCustom body work\nunknown dimensions 35 см'
    + '\n\nManager comment — tint:\nТонер 5\ntint percentage to be confirmed');
  assert.equal(item.source.wrapping, wrapping); assert.equal(item.source.tint, tint); assert.equal(item.source.notes, notes);
  assertReview(parse(row({ 6: 'Custom body work', 7: 'Тонер 5' })).rows[0], 'NO_APPROVED_TASKS');
});

test('unknown comments cannot expose financial values or overflow the combined instruction limit', () => {
  for (const changes of [{ 6: 'W01; Цена 100 BYN' }, { 7: 'USD 10 custom tint' }, { 9: '[W99] Стоимость согласовать' },
    { 6: 'W01; Price $100' }, { 7: 'Cost €100' }, { 9: '[W99] rate 100' },
    { 6: 'W01; £100 custom service' }, { 7: 'Скидка 15%' }, { 9: 'Amount to be agreed' },
    { 6: 'W01; ＄100' }, { 7: 'скидка100' }, { 9: 'discount20' }, { 7: 'тариф 100' }, { 9: 'ставка100' }, { 6: 'W01; прайс уточнить' }]) {
    assertReview(parse(row(changes)).rows[0], 'CONFIDENTIAL_NOTE_REQUIRES_REVIEW');
  }
  const item = parse(row({ 6: 'W01,' + 'a'.repeat(1400), 7: 'b'.repeat(1400), 9: 'c'.repeat(1400) })).rows[0];
  assertReview(item, 'FIELD_TOO_LONG');
  assert.equal(item.source.wrapping.length, 1404);
  assert.equal(parse(row({ 9: 'Приставка, выставка, оценка качества' })).rows[0].state, 'ready');
});

test('independent comment lines do not invent a conflict by combining unrelated nouns', () => {
  const item = parse(row({ 6: 'W01; капот40см; полоса над лобовым стеклом 20 см' })).rows[0];
  assert.equal(item.state, 'ready');
  assert.deepEqual(item.tasks.map(task => task.task_key), ['W01', 'W09']);
  assert.ok(item.order.instructions.includes('капот40см\nполоса над лобовым стеклом 20 см'));
});

test('existing canonical requests with no unmatched text preserve exact order and task fingerprint inputs', () => {
  const item = parse(row({ 6: 'W01, W09', 9: 'Collect on Friday\n[W01] Call before starting' })).rows[0];
  assert.deepEqual(item.order, { vehicle: 'S50', vin: VIN, colour: 'Grey', vehicle_group_code: 'VG02',
    planned_date: '2026-11-13', due_date: null, priority: 'normal', manager_label: 'Synthetic manager', instructions: 'Collect on Friday' });
  assert.deepEqual(item.tasks, [{ task_key: 'W01', work_code: 'W01', options: {}, instructions: 'Call before starting' },
    { task_key: 'W09', work_code: 'W09', options: {}, instructions: '' }]);
  assert.equal(parse(row()).rows[0].order.instructions, '');
});
