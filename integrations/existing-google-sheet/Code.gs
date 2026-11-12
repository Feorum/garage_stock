/* Private standalone Owner project. Reads ONLY the configured operational copy.
 * Never share this project or paste its credential into a Manager spreadsheet.
 * It does not modify any source cell, rule, comment, sharing permission or price. */
function install() {
  var config = readerConfig_();
  readerSnapshot_(config);
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'syncManagerOrders') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncManagerOrders').timeBased().everyMinutes(1).create();
  return { installed: true, note: 'The next successful read confirms the connection in the application.' };
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
      payload: JSON.stringify({ spreadsheet_id: config.spreadsheetId, sheet_gid: config.sheetGid, csv: csv })
    });
    if (response.getResponseCode() !== 200) throw new Error('READ_NOT_CONFIRMED');
    var result = JSON.parse(response.getContentText());
    if (['checked', 'busy'].indexOf(result.status) < 0) throw new Error('READ_NOT_CONFIRMED');
    return { status: result.status };
  } catch (_) {
    // No source content, credentials or raw server errors enter execution logs.
    throw new Error('The spreadsheet read could not be confirmed. Check the Owner connection; the next trigger retries.');
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
  var workbook = SpreadsheetApp.openById(config.spreadsheetId);
  var matches = workbook.getSheets().filter(function(sheet) { return String(sheet.getSheetId()) === config.sheetGid; });
  if (matches.length !== 1) throw new Error('The configured copy tab is unavailable.');
  var sheet = matches[0], rows = sheet.getLastRow(), columns = Math.max(10, sheet.getLastColumn());
  if (rows < 1 || rows > 5000 || columns > 26) throw new Error('The operational copy has an unsupported size.');
  var values = sheet.getRange(1, 1, rows, columns).getDisplayValues();
  // Native checkbox booleans are locale-independent; weekday formulas remain
  // cached display text and are intentionally ignored by the server parser.
  var flags = rows > 1 ? sheet.getRange(2, 9, rows - 1, 1).getValues() : [];
  flags.forEach(function(row, index) {
    if (typeof row[0] === 'boolean') values[index + 1][8] = row[0] ? 'TRUE' : 'FALSE';
  });
  return values.map(function(row) {
    return row.map(function(value) {
      var text = String(value);
      return /[,"\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }).join(',');
  }).join('\r\n');
}
