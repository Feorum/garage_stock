// Synthetic Apps Script services: no Google account, workbook or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SOURCE = readFileSync(new URL('../integrations/google-sheets/Code.gs', import.meta.url), 'utf8');
const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'synthetic_worker_credential_0123456789';
const MANAGER_ID = 'test-manager-workbook';
const API_URL = 'https://example.supabase.co/functions/v1/manager-orders';
const ORDERS = ['request_ref','external_order_id','vehicle','vin','colour','vehicle_group_code','planned_date','due_date','priority','manager_label','instructions','action','delivery_state','accepted_revision','app_order_number','order_status','last_feedback'];
const TASKS = ['request_ref','external_task_id','work_code','tint_percent','instructions','task_status','working_mechanic'];
const CATALOGUE = ['work_code','work_name','vehicle_group_code','vehicle_group_name'];
const plain = value => JSON.parse(JSON.stringify(value));

function columnNumber(letters) {
  return [...letters].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
}

class Protection {
  description = '';
  warningOnly = true;
  domainEdit = true;
  editors = ['synthetic-editor'];
  getDescription() { return this.description; }
  setDescription(value) { this.description = value; return this; }
  setWarningOnly(value) { this.warningOnly = value; return this; }
  getEditors() { return [...this.editors]; }
  removeEditors() { this.editors = []; return this; }
  canDomainEdit() { return this.domainEdit; }
  setDomainEdit(value) { this.domainEdit = value; return this; }
}

class Range {
  constructor(sheet, row, column, rows = 1, columns = 1) {
    Object.assign(this, { sheet, row, column, rows, columns });
  }
  getValues() {
    return Array.from({ length: this.rows }, (_, row) => Array.from({ length: this.columns }, (_, column) =>
      this.sheet.values[this.row + row - 1]?.[this.column + column - 1] ?? ''));
  }
  setValues(values) {
    assert.equal(values.length, this.rows);
    for (let row = 0; row < this.rows; row++) {
      assert.equal(values[row].length, this.columns);
      this.sheet.values[this.row + row - 1] ||= [];
      for (let column = 0; column < this.columns; column++) {
        this.sheet.values[this.row + row - 1][this.column + column - 1] = values[row][column];
      }
    }
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  getSheet() { return this.sheet; }
  protect() { const value = new Protection(); this.sheet.protections.push(value); return value; }
}

class Sheet {
  protections = [];
  frozenRows = 0;
  constructor(name, values = []) { this.name = name; this.values = values.map(row => [...row]); }
  getLastRow() {
    for (let index = this.values.length - 1; index >= 0; index--) {
      if (this.values[index].some(value => value !== '' && value !== null && value !== undefined)) return index + 1;
    }
    return 0;
  }
  getLastColumn() {
    return this.values.reduce((max, row) => Math.max(max, row.reduce((last, value, index) =>
      value !== '' && value !== null && value !== undefined ? index + 1 : last, 0)), 0);
  }
  getRange(row, column, rows = 1, columns = 1) {
    if (typeof row === 'string') {
      const match = row.match(/^([A-Z]+)(\d+)?:([A-Z]+)(\d+)?$/);
      assert.ok(match, `Unsupported test range: ${row}`);
      const firstColumn = columnNumber(match[1]);
      return new Range(this, Number(match[2]) || 1, firstColumn,
        match[4] ? Number(match[4]) - (Number(match[2]) || 1) + 1 : 1000,
        columnNumber(match[3]) - firstColumn + 1);
    }
    return new Range(this, row, column, rows, columns);
  }
  appendRow(values) { this.values[this.getLastRow()] = [...values]; return this; }
  setFrozenRows(value) { this.frozenRows = value; return this; }
  protect() { const value = new Protection(); this.protections.push(value); return value; }
  getProtections() { return this.protections; }
}

class Workbook {
  constructor(id, sheets) { this.id = id; this.sheets = new Map(sheets.map(sheet => [sheet.name, sheet])); }
  getId() { return this.id; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const sheet = new Sheet(name); this.sheets.set(name, sheet); return sheet; }
  getSpreadsheetTimeZone() { return 'Europe/Minsk'; }
}

function order(overrides = {}) {
  const value = { request_ref: 'REQ-A', external_order_id: '', vehicle: 'Synthetic vehicle', vin: '',
    colour: 'Synthetic colour', vehicle_group_code: 'VG02', planned_date: '2026-11-14', due_date: '',
    priority: 'normal', manager_label: 'Synthetic manager reference', instructions: '', action: 'SUBMIT',
    delivery_state: '', accepted_revision: '', app_order_number: '', order_status: '', last_feedback: '', ...overrides };
  return ORDERS.map(key => value[key]);
}

function task(overrides = {}) {
  const value = { request_ref: 'REQ-A', external_task_id: '', work_code: 'W01', tint_percent: '',
    instructions: '', task_status: '', working_mechanic: '', ...overrides };
  return TASKS.map(key => value[key]);
}

function fixture({ orders = [order()], tasks = [task()], transport, properties = {} } = {}) {
  const manager = new Workbook(MANAGER_ID, [new Sheet('Orders', [ORDERS, ...orders]),
    new Sheet('Tasks', [TASKS, ...tasks]), new Sheet('Catalogue', [CATALOGUE,
      ['W01','Synthetic bonnet package','VG02','Synthetic model group'],
      ['W19','Synthetic tint package','VG02','Synthetic model group']])]);
  const workbooks = new Map([[MANAGER_ID, manager]]);
  const fileAccess = new Map();
  const values = { SPREADSHEET_ID: MANAGER_ID, INTEGRATION_ID: SOURCE_ID,
    INTEGRATION_SECRET: SECRET, API_URL, ...properties };
  const triggers = [];
  const calls = [];
  const serverOrders = new Map();
  const clock = { now: Date.parse('2026-11-12T12:00:00Z') };
  let uuid = 0;
  let created = 0;
  let released = 0;
  class ClockDate extends Date {
    constructor(...arguments_) { super(...(arguments_.length ? arguments_ : [clock.now])); }
    static now() { return clock.now; }
  }
  const services = {
    Date: ClockDate,
    SpreadsheetApp: {
      openById(id) { assert.ok(workbooks.has(id), `Unknown synthetic workbook ${id}`); return workbooks.get(id); },
      create() {
        const id = `private-control-${++created}`;
        const workbook = new Workbook(id, [new Sheet('Sheet1')]);
        workbooks.set(id, workbook);
        return workbook;
      },
      flush() {}, ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
    },
    PropertiesService: { getScriptProperties() { return {
      getProperty(key) { return values[key] ?? null; },
      setProperty(key, value) { values[key] = value; return this; },
    }; } },
    DriveApp: { Access: { PRIVATE: 'PRIVATE' }, getFileById(id) { return {
      getSharingAccess: () => fileAccess.get(id)?.access || 'PRIVATE',
      getEditors: () => fileAccess.get(id)?.editors || [],
      getViewers: () => fileAccess.get(id)?.viewers || [],
    }; } },
    LockService: { getScriptLock() { return { tryLock: () => true, releaseLock() { released++; } }; } },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger(trigger) { triggers.splice(triggers.indexOf(trigger), 1); },
      newTrigger(handler) {
        const trigger = { handler, minutes: null, getHandlerFunction() { return this.handler; } };
        return { timeBased() { return this; }, everyMinutes(minutes) { trigger.minutes = minutes; return this; },
          create() { triggers.push(trigger); return trigger; } };
      },
    },
    Utilities: {
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest(_algorithm, text) { return [...createHash('sha256').update(text, 'utf8').digest()].map(value => value > 127 ? value - 256 : value); },
      formatDate(value, timezone) {
        return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
      },
    },
    UrlFetchApp: { fetch(url, options) {
      const body = JSON.parse(options.payload);
      const call = { url, options, body: plain(body) };
      calls.push(call);
      const result = transport ? transport(call, state) : defaultTransport(call, state);
      if (result instanceof Error) throw result;
      return { getResponseCode: () => result.status, getContentText: () => typeof result.body === 'string' ? result.body : JSON.stringify(result.body) };
    } },
  };
  const context = vm.createContext(services);
  vm.runInContext(SOURCE, context, { filename: 'Code.gs' });
  const state = { context, manager, workbooks, properties: values, triggers, calls, fileAccess,
    clock, serverOrders, advance(ms) { clock.now += ms; },
    get control() { return workbooks.get(values.CONTROL_SPREADSHEET_ID); },
    get lockReleases() { return released; },
    run() { return context.syncManagerOrders(); },
    rows(name, workbook = manager) { return workbook.getSheetByName(name).values.slice(1).map(row => [...row]); },
  };
  return state;
}

function defaultTransport(call, state) {
  if (call.url.endsWith('/status')) return { status: 200, body: { source_id: SOURCE_ID,
    orders: call.body.external_order_ids.map(id => state.serverOrders.get(id)).filter(Boolean) } };
  const payload = call.body;
  const accepted = { external_order_id: payload.external_order_id, revision: payload.revision,
    order_number: 'G-000001', status: payload.action === 'cancel' ? 'cancelled' : 'published', order_version: payload.revision,
    tasks: payload.tasks.map(item => ({ external_task_id: item.external_task_id, work_code: item.work_code,
      status: 'pending', working_name: '', completed_at: null })) };
  state.serverOrders.set(payload.external_order_id, accepted);
  return { status: 200, body: { status: 'accepted', submission_id: payload.submission_id,
    external_order_id: payload.external_order_id, revision: payload.revision, order_number: accepted.order_number,
    order_status: accepted.status, order_version: accepted.order_version, tasks: accepted.tasks } };
}

const ingestionCalls = state => state.calls.filter(call => !call.url.endsWith('/status'));
const cell = (state, sheet, row, name) => state.manager.getSheetByName(sheet).values[row - 1][(sheet === 'Orders' ? ORDERS : TASKS).indexOf(name)];
const setCell = (state, sheet, row, name, value) => state.manager.getSheetByName(sheet).getRange(row, (sheet === 'Orders' ? ORDERS : TASKS).indexOf(name) + 1).setValue(value);

test('snapshots enforce canonical availability, tint options and real calendar dates', () => {
  const state = fixture({ tasks: [task({ work_code: 'W19', tint_percent: '15' })] });
  const config = state.context.garageConfig_();
  state.context.garageEnsureIds_(state.context.garageReadInputs_(state.manager));
  let inputs = state.context.garageReadInputs_(state.manager);
  const snapshot = plain(state.context.garageSnapshot_(config, inputs, inputs.orders[0], 'submit'));
  assert.deepEqual(snapshot.tasks[0].options, { tint_percent: 15 });
  assert.equal(snapshot.order.planned_date, '2026-11-14');
  assert.equal(snapshot.order.due_date, null);
  setCell(state, 'Tasks', 2, 'tint_percent', '10');
  inputs = state.context.garageReadInputs_(state.manager);
  assert.throws(() => state.context.garageSnapshot_(config, inputs, inputs.orders[0], 'submit'), /5 or 15/);
  setCell(state, 'Tasks', 2, 'work_code', 'W02');
  inputs = state.context.garageReadInputs_(state.manager);
  assert.throws(() => state.context.garageSnapshot_(config, inputs, inputs.orders[0], 'submit'), /available/);
  assert.throws(() => state.context.garageDate_('2026-02-31', 'Europe/Minsk'), /valid dates/);
});

test('default-only template rows and completion-like values never submit or acquire IDs', () => {
  const blank = order({ request_ref: '', vehicle: '', colour: '', vehicle_group_code: '',
    planned_date: '', manager_label: '', priority: 'normal', action: 'DRAFT' });
  const state = fixture({ orders: [blank, order({ action: true })], tasks: [task()] });
  state.run();
  assert.equal(cell(state, 'Orders', 2, 'external_order_id'), '');
  assert.match(cell(state, 'Orders', 3, 'external_order_id'), /^[0-9a-f-]{36}$/);
  assert.equal(ingestionCalls(state).length, 0);
  assert.equal(state.rows('Outbox', state.control).length, 0);
});

test('install creates a separate private outbox and one minute trigger', () => {
  const state = fixture();
  state.context.install();
  assert.notEqual(state.properties.CONTROL_SPREADSHEET_ID, MANAGER_ID);
  assert.ok(state.control.getSheetByName('Outbox'));
  assert.ok(state.control.getSheetByName('Accepted'));
  assert.equal(state.manager.getSheetByName('Outbox'), null);
  assert.equal(state.triggers.length, 1);
  assert.equal(state.triggers[0].handler, 'syncManagerOrders');
  assert.equal(state.triggers[0].minutes, 1);
  const protections = [...state.manager.sheets.values()].flatMap(sheet => sheet.protections);
  assert.equal(protections.length, 5);
  assert.ok(protections.every(item => !item.warningOnly && !item.domainEdit && item.editors.length === 0));
  const cells = JSON.stringify([...state.manager.sheets.values()].map(sheet => sheet.values));
  assert.ok(!cells.includes(SECRET));
  assert.ok(!cells.includes(SOURCE_ID));
  const controlId = state.properties.CONTROL_SPREADSHEET_ID;
  state.context.install();
  assert.equal(state.properties.CONTROL_SPREADSHEET_ID, controlId);
  assert.equal(state.triggers.length, 1, 'reinstall replaces this worker trigger rather than duplicating it');
  assert.equal([...state.manager.sheets.values()].flatMap(sheet => sheet.protections).length, 5);
  state.fileAccess.set(state.properties.CONTROL_SPREADSHEET_ID, { editors: ['another-editor'] });
  assert.throws(() => state.context.garageControl_(state.context.garageConfig_()), /remain private/);
});

test('a Submit is persisted before delivery and acknowledged once', () => {
  let persistedBeforeSend = false;
  const state = fixture({ transport(call, state) {
    if (!call.url.endsWith('/status')) {
      const outbox = state.rows('Outbox', state.control);
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0][6], 'PENDING');
      assert.deepEqual(JSON.parse(outbox[0][5]), call.body);
      persistedBeforeSend = true;
    }
    return defaultTransport(call, state);
  } });
  state.run();
  assert.ok(persistedBeforeSend);
  assert.equal(ingestionCalls(state).length, 1);
  const sent = ingestionCalls(state)[0];
  assert.equal(sent.options.headers.Authorization, `Bearer ${SOURCE_ID}.${SECRET}`);
  assert.equal(sent.options.followRedirects, false);
  assert.equal(sent.body.revision, 1);
  assert.equal(sent.body.expected_order_version, null);
  assert.equal(cell(state, 'Orders', 2, 'action'), 'DRAFT');
  assert.equal(cell(state, 'Orders', 2, 'delivery_state'), 'ACCEPTED');
  assert.equal(cell(state, 'Orders', 2, 'accepted_revision'), 1);
  assert.equal(state.rows('Outbox', state.control)[0][6], 'ACCEPTED');
  assert.ok(!JSON.stringify(state.rows('Outbox', state.control)).includes(SECRET));
});

test('lost acknowledgement retries the same immutable submission after backoff', () => {
  let count = 0;
  const state = fixture({ transport(call, state) {
    const result = defaultTransport(call, state);
    if (!call.url.endsWith('/status') && ++count === 1) throw new Error('Synthetic lost response');
    return result;
  } });
  state.run();
  const first = plain(ingestionCalls(state)[0].body);
  assert.equal(state.rows('Outbox', state.control)[0][6], 'PENDING');
  state.run();
  assert.equal(ingestionCalls(state).length, 1, 'backoff prevents an immediate duplicate network attempt');
  state.advance(60_001);
  state.run();
  assert.equal(ingestionCalls(state).length, 2);
  assert.deepEqual(ingestionCalls(state)[1].body, first);
  assert.equal(state.rows('Accepted', state.control).length, 1);
  assert.equal(state.rows('Outbox', state.control).length, 1);
});

test('draft edits stay unsubmitted and a delayed old receipt cannot accept their changed scope', () => {
  let count = 0;
  const state = fixture({ transport(call, state) {
    const result = defaultTransport(call, state);
    if (!call.url.endsWith('/status') && ++count === 1) throw new Error('Synthetic lost response');
    return result;
  } });
  state.run();
  const original = plain(ingestionCalls(state)[0].body);
  setCell(state, 'Orders', 2, 'vehicle', 'A newly edited synthetic vehicle');
  state.advance(60_001);
  state.run();
  assert.deepEqual(ingestionCalls(state)[1].body, original);
  assert.notEqual(cell(state, 'Orders', 2, 'delivery_state'), 'ACCEPTED');
  assert.equal(cell(state, 'Orders', 2, 'accepted_revision'), '');
  state.run();
  assert.equal(ingestionCalls(state).length, 2, 'DRAFT edits must not allocate a new revision');
  setCell(state, 'Orders', 2, 'action', 'SUBMIT');
  state.run();
  const revised = ingestionCalls(state)[2].body;
  assert.equal(revised.revision, 2);
  assert.equal(revised.expected_order_version, 1);
  assert.notEqual(revised.submission_id, original.submission_id);
  assert.equal(revised.order.vehicle, 'A newly edited synthetic vehicle');
});

test('an accepted old scope cannot consume a new Submit while another scope is pending', () => {
  let attempts = 0;
  const state = fixture({ transport(call, state) {
    const result = defaultTransport(call, state);
    if (!call.url.endsWith('/status') && ++attempts === 2) throw new Error('Synthetic amendment response lost');
    return result;
  } });
  state.run();
  assert.equal(state.rows('Accepted', state.control)[0][1], 1);
  setCell(state, 'Orders', 2, 'vehicle', 'Synthetic scope B');
  setCell(state, 'Orders', 2, 'action', 'SUBMIT');
  state.run();
  assert.equal(state.rows('Outbox', state.control)[1][6], 'PENDING');
  setCell(state, 'Orders', 2, 'vehicle', 'Synthetic vehicle');
  setCell(state, 'Orders', 2, 'action', 'SUBMIT');
  state.run();
  assert.equal(cell(state, 'Orders', 2, 'action'), 'SUBMIT', 'the pending amendment must resolve before recognizing the old accepted hash');
  assert.deepEqual(state.rows('Outbox', state.control).map(row => row[2]), [1, 2]);
  assert.equal(ingestionCalls(state).length, 2);
  state.advance(60_001);
  state.run();
  assert.equal(state.rows('Accepted', state.control)[0][1], 3,
    'the durable acknowledgement may resolve before capturing the preserved Submit in the same tick');
  assert.deepEqual(ingestionCalls(state).map(call => call.body.revision), [1, 2, 2, 3]);
  assert.deepEqual(ingestionCalls(state)[2].body, ingestionCalls(state)[1].body, 'the pending amendment is retried unchanged');
  assert.deepEqual(state.rows('Outbox', state.control).map(row => row[2]), [1, 2, 3]);
  const latest = ingestionCalls(state).at(-1).body;
  assert.equal(latest.revision, 3);
  assert.equal(latest.expected_order_version, 2);
  assert.equal(latest.order.vehicle, 'Synthetic vehicle');
  assert.equal(cell(state, 'Orders', 2, 'action'), 'DRAFT');
});

test('oversized snapshots are reviewed before outbox persistence or submission HTTP', () => {
  const scenarios = [
    { tasks: Array.from({ length: 24 }, () => task({ instructions: 'x'.repeat(2000) })), kind: 'characters' },
    { tasks: Array.from({ length: 21 }, () => task({ instructions: '漢'.repeat(1950) })), kind: 'utf8' },
  ];
  for (const scenario of scenarios) {
    const state = fixture({ tasks: scenario.tasks });
    const config = state.context.garageConfig_();
    state.context.garageEnsureIds_(state.context.garageReadInputs_(state.manager));
    const inputs = state.context.garageReadInputs_(state.manager);
    const snapshot = state.context.garageSnapshot_(config, inputs, inputs.orders[0], 'submit');
    const serialized = JSON.stringify({ ...plain(snapshot), submission_id: SOURCE_ID, revision: 1, expected_order_version: null });
    if (scenario.kind === 'characters') assert.ok(serialized.length > 45_000);
    else {
      assert.ok(serialized.length <= 45_000, 'the byte scenario must exercise the separate UTF-8 bound');
      assert.ok(new TextEncoder().encode(serialized).length > 125_000);
    }
    state.run();
    assert.equal(state.rows('Outbox', state.control).length, 0);
    assert.equal(ingestionCalls(state).length, 0);
    assert.equal(cell(state, 'Orders', 2, 'delivery_state'), 'REVIEW');
    assert.equal(cell(state, 'Orders', 2, 'last_feedback'), 'This order is too large for spreadsheet delivery. Shorten instructions or split the request into separate orders.');
    assert.ok(state.calls.every(call => call.url.endsWith('/status')), 'only the safe empty-source health poll may run');
  }
  const state = fixture();
  assert.equal(state.context.garageUtf8Length_('ASCII é 漢 😀'), new TextEncoder().encode('ASCII é 漢 😀').length);
});

test('sorting during a delivery preserves UUIDs and directs feedback to the current row', () => {
  let sorted = false;
  const state = fixture({ orders: [order(), order({ request_ref: 'REQ-B', vehicle: 'Second synthetic vehicle', action: 'DRAFT' })],
    tasks: [task(), task({ request_ref: 'REQ-B' })], transport(call, state) {
      if (!call.url.endsWith('/status') && !sorted) {
        sorted = true;
        for (const name of ['Orders', 'Tasks']) {
          const sheet = state.manager.getSheetByName(name);
          [sheet.values[1], sheet.values[2]] = [sheet.values[2], sheet.values[1]];
        }
      }
      return defaultTransport(call, state);
    } });
  state.run();
  const submitted = ingestionCalls(state)[0].body;
  assert.equal(cell(state, 'Orders', 3, 'external_order_id'), submitted.external_order_id);
  assert.equal(cell(state, 'Orders', 3, 'delivery_state'), 'ACCEPTED');
  assert.equal(cell(state, 'Orders', 2, 'delivery_state'), '');
  assert.equal(cell(state, 'Tasks', 3, 'external_task_id'), submitted.tasks[0].external_task_id);
  assert.equal(cell(state, 'Tasks', 3, 'task_status'), 'pending');
});

test('feedback for an older Submit cannot erase a newly selected Cancel action', () => {
  const state = fixture();
  const config = state.context.garageConfig_();
  state.context.garageEnsureIds_(state.context.garageReadInputs_(state.manager));
  const inputs = state.context.garageReadInputs_(state.manager);
  const submitted = state.context.garageSnapshot_(config, inputs, inputs.orders[0], 'submit');
  const hash = state.context.garageHash_(submitted);
  setCell(state, 'Orders', 2, 'action', 'CANCEL');
  state.context.garageFeedback_(state.manager, config, submitted, hash,
    { state: 'PENDING', message: 'Synthetic earlier delivery' }, true);
  assert.equal(cell(state, 'Orders', 2, 'action'), 'CANCEL');
});

test('copied duplicate identities and orphan tasks stop new submissions before ingest', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  for (const inputs of [
    { orders: [order({ external_order_id: id }), order({ request_ref: 'REQ-B', external_order_id: id })] },
    { tasks: [task({ external_task_id: id }), task({ external_task_id: id })] },
    { orders: [order({ external_order_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      order({ request_ref: 'REQ-B', external_order_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' })] },
    { tasks: [task({ request_ref: 'MISSING-ORDER' })] },
  ]) {
    const state = fixture(inputs);
    assert.throws(() => state.run(), /Synchronization stopped/);
    assert.equal(ingestionCalls(state).length, 0);
    assert.ok(state.calls.every(call => call.url.endsWith('/status')), 'safe authenticated health polling may continue');
    assert.equal(state.rows('Outbox', state.control).length, 0);
    assert.equal(state.lockReleases, 1);
    assert.equal(cell(state, 'Orders', 2, 'delivery_state'), 'REVIEW');
  }
});

test('an unrelated invalid draft cannot block acknowledgement of a durable pending submission', () => {
  let attempts = 0;
  const state = fixture({ transport(call, state) {
    const result = defaultTransport(call, state);
    if (!call.url.endsWith('/status') && ++attempts === 1) throw new Error('Synthetic response lost');
    return result;
  } });
  state.run();
  const captured = plain(ingestionCalls(state)[0].body);
  assert.equal(state.rows('Outbox', state.control)[0][6], 'PENDING');
  state.manager.getSheetByName('Tasks').appendRow(task({ request_ref: 'UNRELATED-MISSING-ORDER' }));
  state.advance(60_001);
  assert.throws(() => state.run(), /Synchronization stopped/);
  assert.equal(ingestionCalls(state).length, 2);
  assert.deepEqual(ingestionCalls(state)[1].body, captured);
  assert.equal(state.rows('Outbox', state.control).length, 1, 'invalid fresh scope never creates a second submission');
  assert.equal(state.rows('Outbox', state.control)[0][6], 'ACCEPTED');
  assert.equal(state.rows('Accepted', state.control)[0][1], 1);
  assert.equal(cell(state, 'Tasks', 3, 'external_task_id'), '', 'the unrelated orphan draft was not normalized into a new submission');
  assert.ok(state.calls.at(-1).url.endsWith('/status'), 'safe feedback polling still runs after local input validation fails');
});

test('feedback polls neither submit orders nor advance accepted revisions and escape formula text', () => {
  const state = fixture();
  state.run();
  const id = cell(state, 'Orders', 2, 'external_order_id');
  const existing = state.serverOrders.get(id);
  existing.order_version = 9;
  existing.tasks[0].status = 'in_progress';
  existing.tasks[0].working_name = '=SYNTHETIC_FORMULA()';
  state.run();
  assert.equal(ingestionCalls(state).length, 1);
  assert.equal(state.rows('Outbox', state.control).length, 1);
  assert.equal(state.rows('Accepted', state.control)[0][1], 1);
  assert.equal(state.rows('Accepted', state.control)[0][2], 1, 'operational status must not rewrite the accepted amendment base');
  assert.equal(cell(state, 'Tasks', 2, 'task_status'), 'in_progress');
  assert.equal(cell(state, 'Tasks', 2, 'working_mechanic'), "'=SYNTHETIC_FORMULA()");
});

test('unrecognized upstream error content is replaced with fixed safe feedback', () => {
  const secretTrace = `PRIVATE_TRACE_SENTINEL ${SECRET}`;
  const state = fixture({ transport() { return { status: 422, body: { status: 'rejected',
    error: { code: 'UNKNOWN_PRIVATE_CODE', message: secretTrace, net_amount: 'PRIVATE_RATE_SENTINEL' } } }; } });
  state.run();
  assert.equal(cell(state, 'Orders', 2, 'delivery_state'), 'REJECTED');
  const feedback = cell(state, 'Orders', 2, 'last_feedback');
  assert.equal(feedback, 'Check vehicle group, work codes and required task options.');
  const cells = JSON.stringify([...state.workbooks.values()].flatMap(book => [...book.sheets.values()].map(sheet => sheet.values)));
  assert.ok(!cells.includes(SECRET));
  assert.ok(!cells.includes('PRIVATE_TRACE_SENTINEL'));
  assert.ok(!cells.includes('PRIVATE_RATE_SENTINEL'));
});
