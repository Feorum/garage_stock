/* Standalone Owner-only Apps Script. Do not bind this project to the Manager
 * workbook or share its code/properties/control workbook with Managers. */
var GARAGE_ORDERS_HEADERS = ['request_ref','external_order_id','vehicle','vin','colour','vehicle_group_code','planned_date','due_date','priority','manager_label','instructions','action','delivery_state','accepted_revision','app_order_number','order_status','last_feedback'];
var GARAGE_TASKS_HEADERS = ['request_ref','external_task_id','work_code','tint_percent','instructions','task_status','working_mechanic'];
var GARAGE_CATALOGUE_HEADERS = ['work_code','work_name','vehicle_group_code','vehicle_group_name'];
var GARAGE_OUTBOX_HEADERS = ['submission_id','external_order_id','revision','expected_order_version','input_hash','payload_json','state','attempts','next_attempt_at','last_code','receipt_json','created_at'];
var GARAGE_STATE_HEADERS = ['external_order_id','accepted_revision','accepted_order_version','order_number','order_status','accepted_input_hash','updated_at'];
var GARAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var GARAGE_MESSAGES = {
  INVALID_SUBMISSION: 'Check the required order and task fields.',
  UNSUPPORTED_FIELDS: 'Use only the supported template columns.',
  SPREADSHEET_MISMATCH: 'Ask the Owner to check the registered spreadsheet.',
  SUBMISSION_ID_REUSED: 'Ask the Owner to reconcile this submission ID.',
  REVISION_CONFLICT: 'Ask the Owner to reconcile the accepted source revision.',
  ORDER_CHANGED: 'Work has changed in the application. Ask the Owner to review.',
  ORDER_CLOSED: 'The order is closed. Ask the Owner to review.',
  TASK_ID_REUSED: 'A task ID is already used. Ask the Owner to review.',
  VALIDATION_FAILED: 'Check vehicle group, work codes and required task options.',
  SOURCE_UNAVAILABLE: 'Ask the Owner to check this connection.',
  TEMPORARILY_UNAVAILABLE: 'Delivery will retry automatically.',
  INVALID_SERVICE_RESPONSE: 'Delivery was not confirmed and will retry.'
};

/** Run once, from a private standalone project, after adding Script Properties. */
function install() {
  var config = garageConfig_();
  var workbook = SpreadsheetApp.openById(config.spreadsheetId);
  garageReadInputs_(workbook);
  garageControl_(config);
  garageProtect_(workbook.getSheetByName('Orders').getRange('B:B'), 'Garage stable order IDs');
  garageProtect_(workbook.getSheetByName('Orders').getRange('M:Q'), 'Garage delivery feedback');
  garageProtect_(workbook.getSheetByName('Tasks').getRange('B:B'), 'Garage stable task IDs');
  garageProtect_(workbook.getSheetByName('Tasks').getRange('F:G'), 'Garage execution feedback');
  garageProtect_(workbook.getSheetByName('Catalogue'), 'Garage approved operational catalogue');
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'syncManagerOrders') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncManagerOrders').timeBased().everyMinutes(1).create();
  return { installed: true, note: 'The first successful delivery/status check confirms the connection.' };
}

/** Installed trigger. No credentials, rows or raw server errors are logged. */
function syncManagerOrders() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var config = garageConfig_();
    var manager = SpreadsheetApp.openById(config.spreadsheetId);
    var control = garageControl_(config);
    // Previously captured submissions are independent of later draft edits.
    // Do not let a malformed new row block durable retry/acknowledgement.
    garageDeliver_(config, manager, control);
    var inputs = garageReadInputs_(manager);
    garageEnsureIds_(inputs);
    inputs = garageReadInputs_(manager);
    garageValidateIdentities_(inputs);
    garageCapture_(config, manager, control, inputs);
    garageDeliver_(config, manager, control);
  } catch (error) {
    if (typeof inputs !== 'undefined' && inputs && inputs.orders) {
      inputs.orders.forEach(function(row) {
        row._sheet.getRange(row._row, 13).setValue('REVIEW');
        row._sheet.getRange(row._row, 17).setValue(garageLiteral_('Synchronization stopped. Check copied IDs, task references and the template with the Owner.'));
      });
    }
    throw new Error('Synchronization stopped. Check the Owner setup and template review feedback.');
  } finally {
    if (typeof config !== 'undefined' && typeof manager !== 'undefined' && typeof control !== 'undefined') {
      try { garagePoll_(config, manager, control); } catch (_) { /* Next trigger retries status feedback. */ }
    }
    lock.releaseLock();
  }
}

function garageConfig_() {
  var properties = PropertiesService.getScriptProperties();
  var config = {
    spreadsheetId: garageText_(properties.getProperty('SPREADSHEET_ID')),
    sourceId: garageText_(properties.getProperty('INTEGRATION_ID')),
    secret: garageText_(properties.getProperty('INTEGRATION_SECRET')),
    apiUrl: garageText_(properties.getProperty('API_URL')).replace(/\/$/, ''),
    controlId: garageText_(properties.getProperty('CONTROL_SPREADSHEET_ID'))
  };
  if (!/^[A-Za-z0-9_-]{10,}$/.test(config.spreadsheetId) || !GARAGE_UUID.test(config.sourceId)
      || !/^[A-Za-z0-9_-]{32,256}$/.test(config.secret)
      || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/manager-orders$/.test(config.apiUrl)) {
    throw new Error('Set the four private connection Script Properties before installing.');
  }
  if (config.controlId === config.spreadsheetId) throw new Error('The control workbook must be separate and Owner-private.');
  return config;
}

function garageControl_(config) {
  var control;
  if (!config.controlId) {
    control = SpreadsheetApp.create('Garage private submission control');
    config.controlId = control.getId();
    PropertiesService.getScriptProperties().setProperty('CONTROL_SPREADSHEET_ID', config.controlId);
  } else control = SpreadsheetApp.openById(config.controlId);
  var file = DriveApp.getFileById(config.controlId);
  if (file.getSharingAccess() !== DriveApp.Access.PRIVATE || file.getEditors().length || file.getViewers().length) {
    throw new Error('The submission control workbook must remain private to the Owner.');
  }
  garageControlSheet_(control, 'Outbox', GARAGE_OUTBOX_HEADERS);
  garageControlSheet_(control, 'Accepted', GARAGE_STATE_HEADERS);
  return control;
}

function garageControlSheet_(workbook, name, headers) {
  var sheet = workbook.getSheetByName(name);
  if (!sheet) { sheet = workbook.insertSheet(name); sheet.getRange(1, 1, 1, headers.length).setValues([headers]); sheet.setFrozenRows(1); }
  garageHeaders_(sheet, headers, false);
  return sheet;
}

function garageProtect_(target, description) {
  var existing = target.getProtections ? target.getProtections(SpreadsheetApp.ProtectionType.SHEET)
    : target.getSheet().getProtections(SpreadsheetApp.ProtectionType.RANGE);
  var protection = existing.filter(function(item) { return item.getDescription() === description; })[0] || target.protect();
  protection.setDescription(description);
  protection.setWarningOnly(false);
  var editors = protection.getEditors();
  if (editors.length) protection.removeEditors(editors);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}

function garageHeaders_(sheet, expected, allowExtra) {
  if (!sheet) throw new Error('The required template tab is missing.');
  var width = allowExtra ? expected.length : Math.max(expected.length, sheet.getLastColumn());
  var actual = sheet.getRange(1, 1, 1, width).getValues()[0];
  if (expected.some(function(name, index) { return garageText_(actual[index]) !== name; })
      || (!allowExtra && actual.slice(expected.length).some(function(value) { return garageText_(value) !== ''; }))) {
    throw new Error('Template headers changed. Restore the approved template before synchronizing.');
  }
}

function garageRows_(sheet, headers) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().map(function(values, index) {
    var row = { _row: index + 2, _sheet: sheet };
    headers.forEach(function(header, column) { row[header] = values[column]; });
    return row;
  });
}

function garageReadInputs_(workbook) {
  var ordersSheet = workbook.getSheetByName('Orders');
  var tasksSheet = workbook.getSheetByName('Tasks');
  var catalogueSheet = workbook.getSheetByName('Catalogue');
  garageHeaders_(ordersSheet, GARAGE_ORDERS_HEADERS, false);
  garageHeaders_(tasksSheet, GARAGE_TASKS_HEADERS, false);
  garageHeaders_(catalogueSheet, GARAGE_CATALOGUE_HEADERS, true);
  var catalogue = Object.create(null);
  garageRows_(catalogueSheet, GARAGE_CATALOGUE_HEADERS).forEach(function(row) {
    if (garageText_(row.work_code) && garageText_(row.vehicle_group_code)) catalogue[garageText_(row.vehicle_group_code) + ':' + garageText_(row.work_code)] = true;
  });
  return { orders: garageRows_(ordersSheet, GARAGE_ORDERS_HEADERS).filter(garageOrderMeaningful_),
    tasks: garageRows_(tasksSheet, GARAGE_TASKS_HEADERS).filter(function(row) {
      return ['request_ref','work_code','tint_percent','instructions'].some(function(key) { return garageText_(row[key]) !== ''; });
    }), catalogue: catalogue, timezone: workbook.getSpreadsheetTimeZone() };
}

function garageOrderMeaningful_(row) {
  // A default priority/action alone is an empty template, not an order.
  return ['request_ref','external_order_id','vehicle','vin','colour','vehicle_group_code','planned_date','due_date','manager_label','instructions']
    .some(function(key) { return garageText_(row[key]) !== ''; });
}

function garageEnsureIds_(inputs) {
  garageValidateIdentities_(inputs, true);
  inputs.orders.forEach(function(row) {
    var id = garageText_(row.external_order_id);
    if (!id || id !== id.toLowerCase()) row._sheet.getRange(row._row, 2).setValue(id ? id.toLowerCase() : Utilities.getUuid());
  });
  inputs.tasks.forEach(function(row) {
    var id = garageText_(row.external_task_id);
    if (!id || id !== id.toLowerCase()) row._sheet.getRange(row._row, 2).setValue(id ? id.toLowerCase() : Utilities.getUuid());
  });
  SpreadsheetApp.flush();
}

function garageValidateIdentities_(inputs, allowMissing) {
  var refs = Object.create(null), ids = Object.create(null), taskIds = Object.create(null);
  inputs.orders.forEach(function(row) {
    var ref = garageText_(row.request_ref), id = garageText_(row.external_order_id).toLowerCase();
    if (ref && refs[ref]) throw new Error('Duplicate order request reference. Resolve copied rows before synchronizing.');
    if (ref) refs[ref] = true;
    if ((!id && !allowMissing) || (id && !GARAGE_UUID.test(id)) || (id && ids[id])) throw new Error('Invalid or duplicated order UUID. Ask the Owner to resolve copied identities.');
    if (id) ids[id] = true;
  });
  inputs.tasks.forEach(function(row) {
    var id = garageText_(row.external_task_id).toLowerCase();
    if ((!id && !allowMissing) || (id && !GARAGE_UUID.test(id)) || (id && taskIds[id])) throw new Error('Invalid or duplicated task UUID. Ask the Owner to resolve copied identities.');
    if (id) taskIds[id] = true;
    if (!garageText_(row.request_ref) || !refs[garageText_(row.request_ref)]) throw new Error('Every task must refer to an existing order request reference.');
  });
}

function garageSnapshot_(config, inputs, row, action) {
  var ref = garageText_(row.request_ref);
  if (!ref || !garageText_(row.vehicle) || !garageText_(row.vehicle_group_code)) throw new Error('Enter request reference, vehicle and approved group.');
  var vin = garageText_(row.vin).toUpperCase();
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('Enter a valid 17-character VIN or leave it blank.');
  var priority = garageText_(row.priority) || 'normal';
  if (['normal','high','urgent'].indexOf(priority) < 0) throw new Error('Choose normal, high or urgent priority.');
  var tasks = inputs.tasks.filter(function(task) { return garageText_(task.request_ref) === ref; }).map(function(task) {
    var code = garageText_(task.work_code);
    if (!inputs.catalogue[garageText_(row.vehicle_group_code) + ':' + code]) throw new Error('Choose only works available for this vehicle group.');
    var tint = garageText_(task.tint_percent), options = {};
    if (code === 'W19') {
      if (tint !== '5' && tint !== '15') throw new Error('Choose tint level 5 or 15 for W19.');
      options.tint_percent = Number(tint);
    } else if (tint) throw new Error('Tint level applies only to W19.');
    return { external_task_id: garageText_(task.external_task_id).toLowerCase(), work_code: code,
      options: options, instructions: garageText_(task.instructions) };
  });
  if (tasks.length < 1 || tasks.length > 50) throw new Error('An order needs between 1 and 50 task rows.');
  tasks.sort(function(a, b) { return a.external_task_id.localeCompare(b.external_task_id); });
  var snapshot = { schema_version: 1, spreadsheet_id: config.spreadsheetId,
    external_order_id: garageText_(row.external_order_id).toLowerCase(), action: action,
    order: { vehicle: garageText_(row.vehicle), vin: vin, colour: garageText_(row.colour),
      vehicle_group_code: garageText_(row.vehicle_group_code), planned_date: garageDate_(row.planned_date, inputs.timezone),
      due_date: garageDate_(row.due_date, inputs.timezone), priority: priority,
      instructions: garageText_(row.instructions), manager_label: garageText_(row.manager_label) }, tasks: tasks };
  if (snapshot.order.vehicle.length > 200 || snapshot.order.colour.length > 80
      || snapshot.order.manager_label.length > 120 || snapshot.order.instructions.length > 4000
      || tasks.some(function(task) { return task.instructions.length > 2000; })) throw new Error('An order field is too long.');
  return snapshot;
}

function garageDate_(value, timezone) {
  if (value === '' || value === null || value === undefined) return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) return Utilities.formatDate(value, timezone, 'yyyy-MM-dd');
  var text = garageText_(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || new Date(text + 'T00:00:00Z').toISOString().slice(0,10) !== text) throw new Error('Use valid dates in YYYY-MM-DD form.');
  return text;
}

function garageStates_(control) {
  var map = Object.create(null);
  garageRows_(control.getSheetByName('Accepted'), GARAGE_STATE_HEADERS).forEach(function(row) { map[row.external_order_id] = row; });
  return map;
}

function garageOutbox_(control) { return garageRows_(control.getSheetByName('Outbox'), GARAGE_OUTBOX_HEADERS); }

function garageCapture_(config, manager, control, inputs) {
  var states = garageStates_(control), outbox = garageOutbox_(control);
  inputs.orders.forEach(function(row) {
    var action = garageText_(row.action).toUpperCase();
    if (action !== 'SUBMIT' && action !== 'CANCEL') return;
    try {
      var snapshot = garageSnapshot_(config, inputs, row, action === 'CANCEL' ? 'cancel' : 'submit');
      var hash = garageHash_(snapshot), state = states[snapshot.external_order_id];
      if (snapshot.action === 'cancel' && !state) throw new Error('Only an accepted order can request cancellation.');
      var pending = outbox.filter(function(item) { return item.external_order_id === snapshot.external_order_id && item.state === 'PENDING'; });
      if (pending.length) {
        if (pending[0].input_hash === hash) garageFeedback_(manager, config, snapshot, hash, { state: 'PENDING', message: 'Delivery is pending and will retry.' }, true);
        return;
      }
      if (state && state.accepted_input_hash === hash) {
        garageFeedback_(manager, config, snapshot, hash, { state: 'ACCEPTED', revision: Number(state.accepted_revision), order_number: state.order_number, order_status: state.order_status, message: 'This exact request is already accepted.' }, true);
        return;
      }
      // Re-read the full joined input before persisting an immutable snapshot.
      var fresh = garageReadInputs_(manager);
      var freshRow = fresh.orders.filter(function(item) { return garageText_(item.external_order_id).toLowerCase() === snapshot.external_order_id; })[0];
      if (!freshRow || garageText_(freshRow.action).toUpperCase() !== action || garageHash_(garageSnapshot_(config, fresh, freshRow, snapshot.action)) !== hash) return;
      var payload = Object.assign({}, snapshot, { submission_id: Utilities.getUuid(),
        revision: state ? Number(state.accepted_revision) + 1 : 1,
        expected_order_version: state ? Number(state.accepted_order_version) : null });
      var serialized = JSON.stringify(payload);
      // Outbox snapshots occupy one Google Sheets cell (50,000-character limit).
      // Also remain below the UTF-8 HTTP limit without splitting an order.
      if (serialized.length > 45000 || garageUtf8Length_(serialized) > 125000) {
        throw new Error('This order is too large for spreadsheet delivery. Shorten instructions or split the request into separate orders.');
      }
      control.getSheetByName('Outbox').appendRow([payload.submission_id, payload.external_order_id, payload.revision,
        payload.expected_order_version, hash, serialized, 'PENDING', 0, '', '', '', new Date().toISOString()]);
      SpreadsheetApp.flush();
      garageFeedback_(manager, config, snapshot, hash, { state: 'PENDING', message: 'Captured for delivery. New edits require another Submit.' }, true);
    } catch (error) {
      // Local validation errors contain only fixed template instructions.
      row._sheet.getRange(row._row, 13).setValue('REVIEW');
      row._sheet.getRange(row._row, 17).setValue(garageLiteral_(error.message || 'Check the order fields.'));
    }
  });
}

function garageDeliver_(config, manager, control) {
  var sheet = control.getSheetByName('Outbox');
  garageOutbox_(control).filter(function(item) { return item.state === 'PENDING'; }).slice(0, 20).forEach(function(item) {
    if (item.next_attempt_at && Date.parse(item.next_attempt_at) > Date.now()) return;
    var payload;
    try { payload = JSON.parse(item.payload_json); } catch (_) { throw new Error('Private outbox content is invalid. Ask the Owner to review it.'); }
    var result = garageRequest_(config, '', payload);
    var attempts = Number(item.attempts || 0) + 1;
    var receipt = result.body;
    var state = 'PENDING', code = 'TEMPORARILY_UNAVAILABLE';
    if (result.status === 200 && receipt && receipt.status === 'accepted'
        && receipt.submission_id === payload.submission_id && receipt.external_order_id === payload.external_order_id
        && receipt.revision === payload.revision && /^G-\d+$/.test(receipt.order_number || '')
        && Number.isInteger(receipt.order_version) && receipt.order_version > 0) {
      state = 'ACCEPTED'; code = '';
      garageSaveAccepted_(control, item, receipt);
    } else if (receipt && receipt.status === 'conflict' && result.status === 409) {
      state = 'CONFLICT'; code = garageErrorCode_(receipt);
    } else if (receipt && receipt.status === 'rejected' && result.status >= 400 && result.status < 500 && result.status !== 429) {
      state = result.status === 401 || result.status === 403 ? 'AUTH_ERROR' : 'REJECTED'; code = garageErrorCode_(receipt);
    }
    var next = state === 'PENDING' ? new Date(Date.now() + Math.min(3600000, 60000 * Math.pow(2, Math.min(attempts - 1, 6)))).toISOString() : '';
    sheet.getRange(item._row, 7, 1, 5).setValues([[state, attempts, next, code, state === 'ACCEPTED' ? JSON.stringify(receipt) : '']]);
    garageFeedback_(manager, config, payload, item.input_hash, { state: state,
      revision: state === 'ACCEPTED' ? receipt.revision : null,
      order_number: state === 'ACCEPTED' ? receipt.order_number : null,
      order_status: state === 'ACCEPTED' ? receipt.order_status : null,
      message: state === 'ACCEPTED' ? 'Order accepted by the application.' : GARAGE_MESSAGES[code] || GARAGE_MESSAGES.VALIDATION_FAILED }, false);
  });
}

function garageSaveAccepted_(control, item, receipt) {
  var sheet = control.getSheetByName('Accepted');
  var existing = garageStates_(control)[item.external_order_id];
  var values = [item.external_order_id, receipt.revision, receipt.order_version, receipt.order_number,
    receipt.order_status, item.input_hash, new Date().toISOString()];
  if (existing) sheet.getRange(existing._row, 1, 1, GARAGE_STATE_HEADERS.length).setValues([values]);
  else sheet.appendRow(values);
  SpreadsheetApp.flush();
}

function garageRequest_(config, suffix, payload) {
  try {
    var result = UrlFetchApp.fetch(config.apiUrl + suffix, { method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + config.sourceId + '.' + config.secret },
      payload: JSON.stringify(payload), muteHttpExceptions: true, followRedirects: false });
    var body;
    try { body = JSON.parse(result.getContentText()); } catch (_) { body = null; }
    return { status: result.getResponseCode(), body: body };
  } catch (_) { return { status: 0, body: null }; }
}

function garageFeedback_(manager, config, submitted, expectedHash, feedback, consumeAction) {
  var inputs;
  try { inputs = garageReadInputs_(manager); } catch (_) { return; }
  var matches = inputs.orders.filter(function(row) { return garageText_(row.external_order_id).toLowerCase() === submitted.external_order_id; });
  if (matches.length !== 1) return;
  var row = matches[0];
  try { if (garageHash_(garageSnapshot_(config, inputs, row, submitted.action)) !== expectedHash) return; }
  catch (_) { return; }
  if (consumeAction && garageText_(row.action).toLowerCase() === submitted.action) {
    row._sheet.getRange(row._row, 12).setValue('DRAFT');
  }
  row._sheet.getRange(row._row, 13).setValue(garageLiteral_(feedback.state));
  if (feedback.revision !== null && feedback.revision !== undefined) row._sheet.getRange(row._row, 14).setValue(feedback.revision);
  if (feedback.order_number) row._sheet.getRange(row._row, 15).setValue(garageLiteral_(feedback.order_number));
  if (feedback.order_status) row._sheet.getRange(row._row, 16).setValue(garageLiteral_(feedback.order_status));
  row._sheet.getRange(row._row, 17).setValue(garageLiteral_(feedback.message));
}

function garagePoll_(config, manager, control) {
  var states = garageStates_(control), ids = Object.keys(states);
  // Even an empty template performs an authenticated status check so the Owner
  // can distinguish a live connection from an installed-but-unused trigger.
  for (var offset = 0; offset < Math.max(ids.length, 1); offset += 100) {
    var result = garageRequest_(config, '/status', { external_order_ids: ids.slice(offset, offset + 100) });
    if (result.status !== 200 || !result.body || !Array.isArray(result.body.orders)) continue;
    var current;
    try { current = garageReadInputs_(manager); } catch (_) { continue; }
    result.body.orders.forEach(function(order) {
      if (!states[order.external_order_id] || !/^G-\d+$/.test(order.order_number || '') || !Array.isArray(order.tasks)) return;
      current.orders.filter(function(row) { return garageText_(row.external_order_id).toLowerCase() === order.external_order_id; }).forEach(function(row) {
        row._sheet.getRange(row._row, 15, 1, 2).setValues([[garageLiteral_(order.order_number), garageLiteral_(order.status)]]);
      });
      order.tasks.forEach(function(task) {
        if (!GARAGE_UUID.test(task.external_task_id || '')) return;
        current.tasks.filter(function(row) { return garageText_(row.external_task_id).toLowerCase() === task.external_task_id; }).forEach(function(row) {
          row._sheet.getRange(row._row, 6, 1, 2).setValues([[garageLiteral_(task.status), garageLiteral_(task.working_name || '')]]);
        });
      });
    });
  }
}

function garageErrorCode_(receipt) {
  return receipt && receipt.error && Object.prototype.hasOwnProperty.call(GARAGE_MESSAGES, receipt.error.code) ? receipt.error.code : 'VALIDATION_FAILED';
}
function garageText_(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function garageLiteral_(value) { var text = String(value); return /^[=+\-@\t\r]/.test(text) ? "'" + text : text; }
function garageUtf8Length_(text) {
  var size = 0;
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i);
    if (code < 128) size += 1;
    else if (code < 2048) size += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF) { size += 4; i += 1; }
    else size += 3;
  }
  return size;
}
function garageHash_(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') { var out = {}; Object.keys(item).sort().forEach(function(key) { out[key] = canonical(item[key]); }); return out; }
    return item;
  }
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(canonical(value)), Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
}
