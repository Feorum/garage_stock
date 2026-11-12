import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../integrations/existing-google-sheet/Code.gs', import.meta.url), 'utf8');
function setup(overrides = {}) {
  const calls = [], triggers = [];
  const properties = { SPREADSHEET_ID: 'SyntheticPrivateCopy0000000001', SHEET_GID: '12345',
    INTEGRATION_ID: '11111111-1111-4111-8111-111111111111',
    INTEGRATION_SECRET: 'synthetic_reader_secret_01234567890123456789',
    API_URL: 'https://example.supabase.co/functions/v1/pull-manager-sheets/source', ...overrides.properties };
  const data = [['Столбец 1', 'День', 'Менеджер', 'Автомобиль', 'VIN', 'Цвет', 'Оклейка', 'Тонировка', 'Готовность', 'Примечание'],
    ['13.11.2026', '#REF!', 'Synthetic manager', 'S50', 'TEST0000000000001', 'Grey', 'W01, W09', '', 'FALSE', '[W01] Call "before" starting\nAdditional line']];
  const sheet = { getSheetId: () => 12345, getLastRow: () => data.length, getLastColumn: () => 10,
    getRange: (...args) => {
      calls.push({ name: 'getRange', args });
      if (args[1] === 9) return { getValues: () => [[overrides.completed ?? false]] };
      return { getDisplayValues: () => data };
    } };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties[name] }) },
    SpreadsheetApp: { openById: id => { calls.push({ name: 'openById', id }); return { getSheets: () => [sheet] }; } },
    ScriptApp: { getProjectTriggers: () => [{ getHandlerFunction: () => 'unrelated' }, { getHandlerFunction: () => 'syncManagerOrders' }],
      deleteTrigger: trigger => calls.push({ name: 'deleteTrigger', handler: trigger.getHandlerFunction() }),
      newTrigger: handler => ({ timeBased: () => ({ everyMinutes: minutes => ({ create: () => triggers.push({ handler, minutes }) }) }) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => overrides.locked !== true, releaseLock: () => calls.push({ name: 'releaseLock' }) }) },
    UrlFetchApp: { fetch: (url, options) => { calls.push({ name: 'fetch', url, options });
      return { getResponseCode: () => overrides.http ?? 200,
        getContentText: () => overrides.body ?? '{"status":"checked","checked":1,"failed":0}' }; } }
  });
  vm.runInContext(script, context);
  return { context, calls, triggers, properties };
}
test('installation reads only the configured copy and installs a minute trigger without source writes', () => {
  const { context, calls, triggers, properties } = setup();
  assert.equal(context.install().installed, true);
  assert.deepEqual(triggers, [{ handler: 'syncManagerOrders', minutes: 1 }]);
  assert.equal(calls.find(call => call.name === 'openById').id, properties.SPREADSHEET_ID);
  assert.deepEqual(calls.filter(call => call.name === 'deleteTrigger').map(call => call.handler), ['syncManagerOrders']);
  assert.ok(!calls.some(call => call.name === 'fetch'));
});
test('private reader sends a bounded-column CSV snapshot with locale-independent completion', () => {
  const { context, calls, properties } = setup({ completed: true });
  assert.equal(context.syncManagerOrders().status, 'checked');
  const request = calls.find(call => call.name === 'fetch');
  assert.equal(request.url, properties.API_URL); assert.equal(request.options.followRedirects, false);
  assert.equal(request.options.headers.Authorization, `Bearer ${properties.INTEGRATION_ID}.${properties.INTEGRATION_SECRET}`);
  const payload = JSON.parse(request.options.payload);
  assert.deepEqual(Object.keys(payload).sort(), ['csv', 'sheet_gid', 'spreadsheet_id']);
  assert.equal(payload.sheet_gid, properties.SHEET_GID);
  assert.equal(payload.spreadsheet_id, properties.SPREADSHEET_ID);
  assert.ok(payload.csv.includes('"W01, W09"')); assert.ok(payload.csv.includes(',TRUE,'));
  assert.ok(payload.csv.includes('""before""')); assert.ok(payload.csv.includes('\r\n'));
  assert.deepEqual(calls.filter(call => call.name === 'getRange').map(call => call.args), [[1, 1, 2, 10], [2, 9, 1, 1]]);
  assert.equal(calls.at(-1).name, 'releaseLock');
});
test('reader rejects an arbitrary upload host before opening any spreadsheet', () => {
  const { context, calls } = setup({ properties: { API_URL: 'https://attacker.invalid/collect' } });
  assert.throws(() => context.syncManagerOrders(), /spreadsheet read could not be confirmed/);
  assert.ok(!calls.some(call => call.name === 'openById' || call.name === 'fetch'));
});
test('an HTTP error or unconfirmed server body never leaks secrets into execution errors', () => {
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
