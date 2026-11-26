import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = ['Code.gs', 'Feedback.gs'].map(name => fs.readFileSync(new URL(`../integrations/existing-google-sheet/${name}`, import.meta.url), 'utf8')).join('\n');
const manifest = JSON.parse(fs.readFileSync(new URL('../integrations/existing-google-sheet/appsscript.json', import.meta.url), 'utf8'));
const googleToken = 'synthetic_google_oauth_token';
function setup(overrides = {}) {
  const calls = [], triggers = [];
  const properties = { SPREADSHEET_ID: 'SyntheticPrivateCopy0000000001', SHEET_GID: '12345',
    INTEGRATION_ID: '11111111-1111-4111-8111-111111111111',
    INTEGRATION_SECRET: 'synthetic_reader_secret_01234567890123456789',
    API_URL: 'https://example.supabase.co/functions/v1/pull-manager-sheets/source', ...overrides.properties };
  const displayed = [['Столбец 1', 'День', 'Менеджер', 'Автомобиль', 'VIN', 'Цвет', 'Оклейка', 'Тонировка', 'Готовность', 'Примечание'],
    ['13.11.2026', '#REF!', 'Synthetic manager', 'S50', 'TEST0000000000001', 'Grey', 'W01, W09', '', 'ЛОЖЬ', '[W01] Call "before" starting\nAdditional line']];
  const rows = displayed.map(row => ({ values: row.map(value => ({ formattedValue: value, userEnteredValue: { stringValue: value } })) }));
  rows[1].values[8] = { formattedValue: 'ЛОЖЬ', userEnteredValue: { boolValue: overrides.completed ?? false }, effectiveValue: { boolValue: overrides.completed ?? false } };
  const metadata = overrides.metadata ?? { sheets: [
    { properties: { sheetId: 999, title: 'Unrelated tab', gridProperties: { rowCount: 10000, columnCount: 100 } } },
    { properties: { sheetId: 12345, title: "Оклейка O'Brien", gridProperties: { rowCount: 978, columnCount: 26 } } }
  ] };
  const snapshot = overrides.snapshot ?? { sheets: [{ properties: { sheetId: 12345 }, data: [{ rowData: overrides.rows ?? rows }] }] };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties[name],
      setProperty: (name, value) => { properties[name] = value; } }) },
    // No SpreadsheetApp mock: a regression to openById must fail.
    ScriptApp: { getOAuthToken: () => googleToken,
      getProjectTriggers: () => [{ getHandlerFunction: () => 'unrelated' }, { getHandlerFunction: () => 'syncManagerOrders' }],
      deleteTrigger: trigger => calls.push({ name: 'deleteTrigger', handler: trigger.getHandlerFunction() }),
      newTrigger: handler => ({ timeBased: () => ({ everyMinutes: minutes => ({ create: () => triggers.push({ handler, minutes }) }) }) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => overrides.locked !== true, releaseLock: () => calls.push({ name: 'releaseLock' }) }) },
    UrlFetchApp: { fetch: (url, options) => { calls.push({ name: 'fetch', url, options });
      if (new URL(url).hostname === 'sheets.googleapis.com') {
        const body = options.method === 'post' ? { replies: [{}] } : new URL(url).searchParams.has('ranges') ? snapshot : metadata;
        if (overrides.googleException) throw new Error(overrides.googleException);
        return { getResponseCode: () => overrides.googleHttp ?? 200,
          getContentText: () => overrides.googleBody ?? JSON.stringify(body) };
      }
      return { getResponseCode: () => overrides.http ?? 200,
        getContentText: () => overrides.body ?? '{"status":"checked","checked":1,"failed":0,"protocol":"feedback_v1","feedback":[]}' }; } }
  });
  vm.runInContext(script, context);
  return { context, calls, triggers, properties };
}
const requests = calls => calls.filter(call => call.name === 'fetch');
const upload = calls => requests(calls).find(call => call.url.startsWith('https://example.supabase.co/'));

test('installs the exact model selector in column D of the configured copy once', () => {
  const choices = ['BELGEE X50+', 'GEELY MONJARO (матовый)'];
  const { context, calls } = setup({ body: JSON.stringify({ status: 'checked', protocol: 'feedback_v1',
    vehicle_choices: choices, feedback: [] }) });
  context.syncManagerOrders();
  context.syncManagerOrders();
  const writes = requests(calls).filter(call => call.url.endsWith(':batchUpdate'));
  assert.equal(writes.length, 1);
  const [{ setDataValidation }] = JSON.parse(writes[0].options.payload).requests;
  assert.deepEqual(setDataValidation.range, { sheetId: 12345, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 });
  assert.equal(setDataValidation.rule.strict, false);
  assert.deepEqual(setDataValidation.rule.condition.values.map(value => value.userEnteredValue), choices);
});

test('manifest requests Sheets editing for configured-copy feedback and enables its API', () => {
  assert.deepEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/script.scriptapp']);
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [{ userSymbol: 'Sheets', version: 'v4', serviceId: 'sheets' }]);
});

test('installation checks the configured tab, protects Notes and replaces only its own minute trigger', () => {
  const { context, calls, triggers, properties } = setup();
  assert.equal(context.install().installed, true);
  assert.deepEqual(triggers, [{ handler: 'syncManagerOrders', minutes: 1 }]);
  assert.deepEqual(calls.filter(call => call.name === 'deleteTrigger').map(call => call.handler), ['syncManagerOrders']);
  assert.equal(JSON.parse(upload(calls).options.payload).protocol, 'feedback_v1');
  const google = requests(calls);
  const reads = google.filter(request => request.options.method === 'get');
  assert.equal(reads.length, 5);
  for (const request of reads) {
    const url = new URL(request.url);
    assert.equal(url.hostname, 'sheets.googleapis.com');
    assert.equal(url.pathname, `/v4/spreadsheets/${properties.SPREADSHEET_ID}`);
    assert.equal(request.options.method, 'get');
    assert.equal(request.options.followRedirects, false);
    assert.equal(request.options.muteHttpExceptions, true);
    assert.equal(request.options.headers.Authorization, `Bearer ${googleToken}`);
    assert.ok(!JSON.stringify(request).includes(properties.INTEGRATION_SECRET));
  }
  assert.equal(new URL(reads[0].url).searchParams.has('ranges'), false);
  assert.equal(new URL(reads[1].url).searchParams.get('ranges'), "'Оклейка O''Brien'!A1:Z978");
  assert.match(new URL(reads[1].url).searchParams.get('fields'), /formattedValue,effectiveValue,userEnteredValue/);
  const protectedRequest = google.find(request => request.url.endsWith(':batchUpdate'));
  const protection = JSON.parse(protectedRequest.options.payload).requests[0].addProtectedRange.protectedRange;
  assert.deepEqual(protection.range, { sheetId: 12345, startRowIndex: 1, startColumnIndex: 9, endColumnIndex: 10 });
  assert.equal(protection.warningOnly, false);
});

test('private reader preserves displayed CSV, native completion and credential destinations', () => {
  const { context, calls, properties } = setup({ completed: true });
  assert.equal(context.syncManagerOrders().status, 'checked');
  const request = upload(calls);
  assert.equal(request.url, properties.API_URL); assert.equal(request.options.followRedirects, false);
  assert.equal(request.options.method, 'post');
  assert.equal(request.options.headers.Authorization, `Bearer ${properties.INTEGRATION_ID}.${properties.INTEGRATION_SECRET}`);
  assert.ok(!JSON.stringify(request).includes(googleToken));
  const payload = JSON.parse(request.options.payload);
  assert.deepEqual(Object.keys(payload).sort(), ['csv', 'protocol', 'sheet_gid', 'spreadsheet_id']);
  assert.equal(payload.sheet_gid, properties.SHEET_GID);
  assert.equal(payload.spreadsheet_id, properties.SPREADSHEET_ID);
  assert.ok(payload.csv.includes('13.11.2026,#REF!,'));
  assert.ok(payload.csv.includes('"W01, W09"')); assert.ok(payload.csv.includes(',TRUE,'));
  assert.ok(payload.csv.includes('""before""')); assert.ok(payload.csv.includes('\r\n'));
  assert.equal(calls.at(-1).name, 'releaseLock');
});

test('unchecked native FALSE cells extend the used range even with empty display text', () => {
  const rows = [{ values: [{ formattedValue: 'Header' }] }, {}, {}, {}, {},
    { values: [...Array.from({ length: 8 }, () => ({})), { effectiveValue: { boolValue: false }, formattedValue: '' }] }, {},
    { values: Array.from({ length: 26 }, () => ({})) }];
  const { context, calls } = setup({ rows }); context.syncManagerOrders();
  const lines = JSON.parse(upload(calls).options.payload).csv.split('\r\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0], 'Header,,,,,,,,,');
  assert.equal(lines[5], ',,,,,,,,FALSE,');
});

test('empty-result formulas and hidden display values retain sparse row and column positions', () => {
  const rows = [{ values: [{ formattedValue: 'Header' }] }, {}, {},
    { values: [...Array.from({ length: 11 }, () => ({})), { userEnteredValue: { formulaValue: '=IF(TRUE,"",1)' }, effectiveValue: { stringValue: '' }, formattedValue: '' }] }];
  const { context, calls } = setup({ rows }); context.syncManagerOrders();
  const lines = JSON.parse(upload(calls).options.payload).csv.split('\r\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0].split(',').length, 12);
  assert.equal(lines[3], ',,,,,,,,,,,');
});

test('missing configured gid fails before reading other tab contents or installing a trigger', () => {
  const { context, calls, triggers } = setup({ properties: { SHEET_GID: '404' } });
  assert.throws(() => context.install(), /configured copy tab is unavailable/);
  assert.equal(requests(calls).length, 1);
  assert.equal(triggers.length, 0);
});

test('oversized allocated grids are rejected before a cell read, even when empty', () => {
  for (const gridProperties of [{ rowCount: 5001, columnCount: 26 }, { rowCount: 978, columnCount: 27 }]) {
    const metadata = { sheets: [{ properties: { sheetId: 12345, title: 'Copy', gridProperties } }] };
    const { context, calls, triggers } = setup({ metadata });
    assert.throws(() => context.install(), /5000 allocated rows and 26 allocated columns/);
    assert.equal(requests(calls).length, 1);
    assert.equal(triggers.length, 0);
  }
});

test('out-of-bounds or shifted API snapshots fail closed instead of truncating data', () => {
  for (const data of [
    [{ rowData: Array.from({ length: 979 }, () => ({})) }],
    [{ rowData: [{ values: Array.from({ length: 27 }, () => ({})) }] }],
    [{ startRow: 1, rowData: [{ values: [{ formattedValue: 'shifted' }] }] }],
    [{ rowData: [] }, { rowData: [] }]
  ]) {
    const { context, calls } = setup({ snapshot: { sheets: [{ properties: { sheetId: 12345 }, data }] } });
    assert.throws(() => context.syncManagerOrders(), /could not be confirmed/);
    assert.equal(upload(calls), undefined);
  }
});

test('reader rejects an arbitrary upload host before any Google or upload request', () => {
  const { context, calls } = setup({ properties: { API_URL: 'https://attacker.invalid/collect' } });
  assert.throws(() => context.syncManagerOrders(), /spreadsheet sync could not be confirmed/);
  assert.equal(requests(calls).length, 0);
});

test('Google authorization failures are safe during install and never create triggers', () => {
  for (const overrides of [{ googleHttp: 403, googleBody: `SECRET TRACE ${googleToken}` },
    { googleBody: `SECRET TRACE ${googleToken}` }, { googleException: `SECRET TRACE ${googleToken}` }]) {
    const { context, calls, triggers, properties } = setup(overrides);
    assert.throws(() => context.install(), error => {
      assert.ok(!error.message.includes(properties.INTEGRATION_SECRET));
      assert.ok(!error.message.includes(googleToken)); assert.ok(!error.message.includes('TRACE'));
      return /Check Google authorization and the Sheets API service/.test(error.message);
    });
    assert.equal(triggers.length, 0);
    assert.equal(upload(calls), undefined);
  }
});

test('an HTTP error or unconfirmed upload body never leaks secrets into execution errors', () => {
  for (const overrides of [{ http: 401 }, { body: 'SECRET DATABASE TRACE' }, { body: '{"status":"attention"}' }]) {
    const { context, properties } = setup(overrides);
    assert.throws(() => context.syncManagerOrders(), error => {
      assert.ok(!error.message.includes(properties.INTEGRATION_SECRET)); assert.ok(!error.message.includes('TRACE'));
      return /could not be confirmed/.test(error.message);
    });
  }
});

test('an overlapping local trigger performs no read or request', () => {
  const { context, calls } = setup({ locked: true }); context.syncManagerOrders(); assert.equal(calls.length, 0);
});
