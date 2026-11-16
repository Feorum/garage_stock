/* Private standalone Owner project. Uses ONLY the configured operational copy.
 * Never share this project or paste its credential into a Manager spreadsheet.
 * Manager inputs remain unchanged; verified execution results use I/J only. */
function install() {
  var config = readerConfig_();
  readerSnapshot_(config);
  feedbackPrepare_(config);
  syncManagerOrders();
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'syncManagerOrders') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncManagerOrders').timeBased().everyMinutes(1).create();
  return { installed: true, note: 'The working copy and completion feedback have been checked.' };
}

function syncManagerOrders() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var config = readerConfig_();
    var csv = readerSnapshot_(config);
    var response = UrlFetchApp.fetch(config.apiUrl, {
      method: 'post', contentType: 'application/json', followRedirects: false,
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + config.sourceId + '.' + config.secret },
      payload: JSON.stringify({ spreadsheet_id: config.spreadsheetId, sheet_gid: config.sheetGid,
        csv: csv, protocol: 'feedback_v1' })
    });
    if (response.getResponseCode() !== 200) throw new Error('READ_NOT_CONFIRMED');
    var result = JSON.parse(response.getContentText());
    if (['checked', 'busy'].indexOf(result.status) < 0) throw new Error('READ_NOT_CONFIRMED');
    var feedback = result.status === 'checked' ? feedbackApply_(config, result) : { updated: 0, deferred: 0 };
    return { status: result.status, updated: feedback.updated, deferred: feedback.deferred };
  } catch (_) {
    // No source content, credentials or raw server errors enter execution logs.
    throw new Error('The spreadsheet sync could not be confirmed. Check the Owner connection and Google authorization; the next trigger retries.');
  } finally { lock.releaseLock(); }
}

function readerConfig_() {
  var properties = PropertiesService.getScriptProperties();
  var config = {
    spreadsheetId: String(properties.getProperty('SPREADSHEET_ID') || '').trim(),
    sheetGid: String(properties.getProperty('SHEET_GID') || '').trim(),
    sourceId: String(properties.getProperty('INTEGRATION_ID') || '').trim(),
    secret: String(properties.getProperty('INTEGRATION_SECRET') || '').trim(),
    apiUrl: String(properties.getProperty('API_URL') || '').trim()
  };
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(config.spreadsheetId) || !/^\d{1,20}$/.test(config.sheetGid)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.sourceId)
      || !/^[A-Za-z0-9_-]{32,256}$/.test(config.secret)
      || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/pull-manager-sheets\/source$/.test(config.apiUrl)) {
    throw new Error('Complete the private reader settings from the Owner application.');
  }
  return config;
}

function readerSnapshot_(config) {
  return readerSnapshotData_(config).csv;
}

function readerSnapshotData_(config) {
  // REST preserves displayed inputs and native checkbox values without loading
  // any other sheet. Feedback uses the same bounded snapshot for verification.
  var workbook = readerGoogleRead_(config, {
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))'
  });
  var matches = (workbook.sheets || []).filter(function(sheet) { return String(sheet.properties.sheetId) === config.sheetGid; });
  if (matches.length !== 1) throw new Error('The configured copy tab is unavailable.');
  var sheet = matches[0].properties, grid = sheet.gridProperties || {};
  // Bound the complete allocated grid before reading it. Rejecting oversized
  // grids prevents silently ignoring content outside the supported rectangle.
  if (!Number.isInteger(grid.rowCount) || grid.rowCount < 1 || grid.rowCount > 5000
      || !Number.isInteger(grid.columnCount) || grid.columnCount < 1 || grid.columnCount > 26) {
    throw new Error('The operational copy must have at most 5000 allocated rows and 26 allocated columns.');
  }
  var range = "'" + sheet.title.replace(/'/g, "''") + "'!A1:"
    + String.fromCharCode(64 + grid.columnCount) + grid.rowCount;
  var snapshot = readerGoogleRead_(config, {
    ranges: range,
    fields: 'sheets(properties(sheetId),data(startRow,startColumn,rowData(values(formattedValue,effectiveValue,userEnteredValue))))'
  });
  var selected = (snapshot.sheets || []).filter(function(item) { return String(item.properties.sheetId) === config.sheetGid; });
  if (selected.length !== 1) throw new Error('The configured copy tab is unavailable.');
  var blocks = selected[0].data || [];
  if (blocks.length > 1 || (blocks[0] && (blocks[0].startRow || blocks[0].startColumn))) {
    throw new Error('The configured copy tab could not be read.');
  }
  var data = blocks.length ? blocks[0].rowData || [] : [], rows = 0, columns = 10;
  if (data.length > grid.rowCount) throw new Error('The operational copy has an unsupported size.');
  data.forEach(function(row, rowIndex) {
    var cells = row.values || [];
    if (cells.length > grid.columnCount) throw new Error('The operational copy has an unsupported size.');
    cells.forEach(function(cell, columnIndex) {
      // Keep the used extent of empty-result formulas, hidden display values,
      // and unchecked FALSE cells; formatting alone does not extend the CSV.
      if (Object.keys(cell.userEnteredValue || {}).length || Object.keys(cell.effectiveValue || {}).length
          || (typeof cell.formattedValue === 'string' && cell.formattedValue !== '')) {
        rows = Math.max(rows, rowIndex + 1); columns = Math.max(columns, columnIndex + 1);
      }
    });
  });
  if (rows < 1) throw new Error('The operational copy has an unsupported size.');
  var values = [];
  for (var rowIndex = 0; rowIndex < rows; rowIndex++) {
    var cells = data[rowIndex] && data[rowIndex].values || [], valuesRow = [];
    for (var columnIndex = 0; columnIndex < columns; columnIndex++) {
      var cell = cells[columnIndex] || {}, value = cell.formattedValue || '';
      // Native checkbox booleans are locale-independent; weekday formulas stay
      // cached display text and are intentionally ignored by the server parser.
      if (rowIndex > 0 && columnIndex === 8 && typeof (cell.effectiveValue || {}).boolValue === 'boolean') {
        value = cell.effectiveValue.boolValue ? 'TRUE' : 'FALSE';
      }
      valuesRow.push(value);
    }
    values.push(valuesRow);
  }
  var csv = values.map(function(row) {
    return row.map(function(value) {
      var text = String(value);
      return /[,"\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }).join(',');
  }).join('\r\n');
  return { csv: csv, values: values, sheet: sheet };
}

function readerGoogleRead_(config, parameters) {
  try {
    var query = Object.keys(parameters).map(function(key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(parameters[key]);
    }).join('&');
    var response = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'
      + encodeURIComponent(config.spreadsheetId) + '?' + query, {
      method: 'get', followRedirects: false, muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
    });
    if (response.getResponseCode() !== 200) throw new Error('READ_NOT_CONFIRMED');
    return JSON.parse(response.getContentText());
  } catch (_) {
    // This also protects install(), which runs before a trigger is created.
    throw new Error('The configured copy could not be read. Check Google authorization and the Sheets API service.');
  }
}
