import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = ['Code.gs', 'Feedback.gs'].map(name => fs.readFileSync(new URL(`../integrations/existing-google-sheet/${name}`, import.meta.url), 'utf8')).join('\n');
const SOURCE = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const block = '[Garage G-000015]\nA-pillars — completed · Synthetic mechanic\n[/Garage]';
const initial = () => ['12.11.2026', '#REF!', 'Manager', 'EX2', 'TEST0000000000001', 'Grey', 'W10', '', 'FALSE', 'Keep this existing note'];
const hash = row => createHash('sha256').update(JSON.stringify(Array.from({ length: 10 }, (_, i) => String(row[i] || '')))).digest('hex');
const item = (row, extra = {}) => ({ source_key: '2026-11-12|TEST0000000000001', source_keys: ['2026-11-12|TEST0000000000001'],
  order_id: ORDER, order_number: 'G-000015', row_number: 2, observation_hash: hash(row), block, complete: true,
  known_outputs: [{ block, complete: true }], ...extra });
const result = feedback => ({ protocol: 'feedback_v1', feedback });
function setup(options = {}) {
  const calls = [], rows = [['Date', 'Day', 'Manager', 'Vehicle', 'VIN', 'Colour', 'Works', 'Tint', 'Done', 'Notes'], ...(options.rows || [initial()])];
  let metadata = options.metadata || null;
  const cells = row => row.map((value, i) => i === 8 ? { formattedValue: value,
    effectiveValue: { boolValue: value === 'TRUE' }, userEnteredValue: { boolValue: value === 'TRUE' } }
    : { formattedValue: value, userEnteredValue: { stringValue: value } });
  const response = data => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(data) });
  const config = { spreadsheetId: 'SyntheticPrivateCopy0000000001', sheetGid: '12345', sourceId: SOURCE, secret: 'never_google' };
  const context = vm.createContext({
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, text) => Array.from(createHash('sha256').update(text).digest()) },
    ScriptApp: { getOAuthToken: () => 'google_only' },
    UrlFetchApp: { fetch(url, request) {
      calls.push({ url, request });
      assert.equal(new URL(url).hostname, 'sheets.googleapis.com');
      assert.ok(url.includes(config.spreadsheetId));
      assert.equal(request.headers.Authorization, 'Bearer google_only');
      assert.ok(!JSON.stringify(request).includes('never_google'));
      const payload = request.payload ? JSON.parse(request.payload) : {};
      if (request.method === 'get') {
        if (new URL(url).searchParams.has('ranges')) return response({ sheets: [{ properties: { sheetId: 12345 }, data: [{ rowData: rows.map(row => ({ values: cells(row) })) }] }] });
        return response({ sheets: [{ properties: { sheetId: 12345, title: 'Orders', gridProperties: { rowCount: 978, columnCount: 26 } }, protectedRanges: options.protections || [] }] });
      }
      if (url.endsWith('/developerMetadata:search')) return response({ matchedDeveloperMetadata: options.duplicateMetadata ? [{ developerMetadata: metadata }, { developerMetadata: metadata }] : metadata ? [{ developerMetadata: metadata }] : [] });
      if (url.endsWith(':batchUpdate')) {
        if (payload.requests[0].deleteDeveloperMetadata) {
          assert.equal(payload.requests[0].deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataId, metadata.metadataId);
          metadata = null; return response({ replies: [{}] });
        }
        if (payload.requests[0].createDeveloperMetadata) {
          metadata = { ...payload.requests[0].createDeveloperMetadata.developerMetadata, metadataId: 123 };
          if (options.afterBinding) options.afterBinding(rows, metadata);
          return response({ replies: [{ createDeveloperMetadata: { developerMetadata: metadata } }] });
        }
        return response({ replies: [{}] });
      }
      if (url.includes(':getByDataFilter')) {
        const range = metadata.location.dimensionRange, rowCells = cells(rows[range.startIndex]);
        if (options.noteFormula) rowCells[9].userEnteredValue = { formulaValue: '=A2' };
        return response({ sheets: [{ properties: { sheetId: range.sheetId }, data: [{ startRow: range.startIndex, rowData: [{ values: rowCells }] }] }] });
      }
      if (url.endsWith('/values:batchUpdateByDataFilter')) {
        assert.equal(payload.valueInputOption, 'RAW');
        assert.equal(payload.data.length, 1);
        assert.equal(payload.data[0].dataFilter.developerMetadataLookup.metadataId, metadata.metadataId);
        const values = payload.data[0].values[0];
        assert.deepEqual(values.slice(0, 8), Array(8).fill(null));
        const row = rows[metadata.location.dimensionRange.startIndex];
        row[8] = values[8] ? 'TRUE' : 'FALSE'; row[9] = values[9];
        return response({ totalUpdatedRows: 1, totalUpdatedSheets: 1, totalUpdatedCells: options.badWriteCount ? 10 : 2 });
      }
      throw new Error('Unexpected Google call');
    } }
  });
  vm.runInContext(source, context);
  return { context, calls, config, rows, metadata: () => metadata,
    apply: feedback => context.feedbackApply_(config, result(feedback)) };
}
const writes = state => state.calls.filter(call => call.url.endsWith('/values:batchUpdateByDataFilter'));
test('completion writes exactly I/J, preserves old notes and confirms saved values', () => {
  const state = setup(), original = [...state.rows[1]];
  assert.deepEqual(JSON.parse(JSON.stringify(state.apply([item(original)]))), { updated: 1, deferred: 0 });
  assert.deepEqual(state.rows[1].slice(0, 8), original.slice(0, 8));
  assert.equal(state.rows[1][8], 'TRUE');
  assert.equal(state.rows[1][9], original[9] + '\n\n' + block);
  assert.equal(writes(state).length, 1);
  const resize = state.calls.map(call => call.request.payload ? JSON.parse(call.request.payload) : {})
    .flatMap(payload => payload.requests || []).find(request => request.autoResizeDimensions);
  assert.deepEqual(resize.autoResizeDimensions.dimensions, { sheetId: 12345, dimension: 'ROWS', startIndex: 1, endIndex: 2 });
});
test('retries replace known output without duplicate blocks and skip already saved output', () => {
  const old = '[Garage G-000015]\nA-pillars — in_progress\n[/Garage]';
  const row = initial(); row[9] += '\n\n' + old;
  const state = setup({ rows: [row] });
  state.apply([item([...row], { known_outputs: [{ block: old, complete: false }, { block, complete: true }] })]);
  assert.equal(state.rows[1][9].split('[Garage').length - 1, 1);
  const again = state.apply([item([...state.rows[1]])]);
  assert.equal(again.updated, 0); assert.equal(again.deferred, 0);
  assert.equal(writes(state).length, 1);
});
test('partial completion adds attribution while leaving the checkbox false', () => {
  const state = setup(); state.apply([item(initial(), { complete: false, known_outputs: [{ block, complete: false }] })]);
  assert.equal(state.rows[1][8], 'FALSE'); assert.ok(state.rows[1][9].includes('Synthetic mechanic'));
});
test('a moved row is located from its current content rather than the stale row number', () => {
  const other = initial(); other[4] = 'TEST0000000000002';
  const state = setup({ rows: [other, initial()] }); state.apply([item(initial())]);
  assert.equal(state.metadata().location.dimensionRange.startIndex, 2);
  assert.equal(state.rows[1][8], 'FALSE'); assert.equal(state.rows[2][8], 'TRUE');
});
test('a row move after binding still writes through its metadata location', () => {
  const other = initial(); other[4] = 'TEST0000000000002';
  const state = setup({ rows: [initial(), other], afterBinding(rows, metadata) {
    [rows[1], rows[2]] = [rows[2], rows[1]];
    metadata.location.dimensionRange = { sheetId: 12345, dimension: 'ROWS', startIndex: 2, endIndex: 3 };
  } });
  state.apply([item(initial())]); assert.equal(state.rows[1][8], 'FALSE'); assert.equal(state.rows[2][8], 'TRUE');
});
test('sorting cell contents safely rebinds only the existing application anchor', () => {
  const other = initial(); other[4] = 'TEST0000000000002';
  const metadata = { metadataId: 122, metadataKey: 'garage_feedback_' + SOURCE, metadataValue: ORDER,
    location: { dimensionRange: { sheetId: 12345, dimension: 'ROWS', startIndex: 1, endIndex: 2 } } };
  const state = setup({ rows: [other, initial()], metadata });
  assert.equal(state.apply([item(initial())]).updated, 1);
  assert.equal(state.metadata().location.dimensionRange.startIndex, 2);
  assert.equal(state.rows[1][8], 'FALSE'); assert.equal(state.rows[2][8], 'TRUE');
});
test('duplicate observations, stale inputs and concurrent edits defer without output writes', () => {
  for (const options of [{ rows: [initial(), initial()] }, { rows: [[...initial().slice(0, 9), 'Changed note']] },
    { afterBinding(rows) { rows[1][4] = 'TEST0000000000999'; } }]) {
    const state = setup(options), answer = state.apply([item(initial())]);
    assert.equal(answer.updated, 0); assert.equal(answer.deferred, 1); assert.equal(writes(state).length, 0);
  }
});
test('foreign-tab metadata and duplicate metadata cannot redirect a write', () => {
  const metadata = { metadataId: 123, location: { dimensionRange: { sheetId: 999, dimension: 'ROWS', startIndex: 1, endIndex: 2 } } };
  for (const options of [{ metadata }, { metadata, duplicateMetadata: true }]) {
    const state = setup(options); assert.equal(state.apply([item(initial())]).deferred, 1); assert.equal(writes(state).length, 0);
  }
});
test('Notes formulas are preserved and an unconfirmed write is reported safely', () => {
  const state = setup({ noteFormula: true }); assert.equal(state.apply([item(initial())]).deferred, 1); assert.equal(writes(state).length, 0);
  const failed = setup({ badWriteCount: true }); assert.throws(() => failed.apply([item(initial())]), /FEEDBACK_NOT_CONFIRMED/);
});
test('malformed protocol, another order block and duplicate order entries fail before Google writes', () => {
  for (const bad of [result([item(initial(), { block: '[Garage G-000099]\nOther\n[/Garage]' })]),
    result([item(initial()), item(initial())]), { protocol: 'other', feedback: [] }]) {
    const state = setup(); assert.throws(() => state.context.feedbackApply_(state.config, bad), /FEEDBACK_NOT_CONFIRMED/);
    assert.equal(state.calls.length, bad.feedback?.length === 2 ? 2 : 0);
    assert.equal(writes(state).length, 0);
  }
});
test('installation protects only Notes and never touches existing Manager inputs or sharing', () => {
  const state = setup(); state.context.feedbackPrepare_(state.config);
  const request = JSON.parse(state.calls.find(call => call.url.endsWith(':batchUpdate')).request.payload).requests[0];
  assert.deepEqual(request.addProtectedRange.protectedRange.range,
    { sheetId: 12345, startRowIndex: 1, startColumnIndex: 9, endColumnIndex: 10 });
  assert.deepEqual(request.addProtectedRange.protectedRange.editors, { users: [], groups: [], domainUsersCanEdit: false });
  assert.equal(writes(state).length, 0);
});
