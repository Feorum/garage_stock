/* Completion feedback is restricted to the configured copy and its I/J cells.
 * Source text and OAuth/source credentials never enter logs or other hosts. */
function feedbackGoogle_(config, suffix, body) {
  var response = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'
    + encodeURIComponent(config.spreadsheetId) + suffix, {
    method: 'post', contentType: 'application/json', followRedirects: false,
    muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(body)
  });
  if (response.getResponseCode() !== 200) throw new Error('FEEDBACK_NOT_CONFIRMED');
  return JSON.parse(response.getContentText());
}

function feedbackPrepare_(config) {
  var workbook = readerGoogleRead_(config, {
    fields: 'sheets(properties(sheetId),protectedRanges(protectedRangeId,description,range,warningOnly,editors))'
  });
  var sheets = (workbook.sheets || []).filter(function(sheet) { return String(sheet.properties.sheetId) === config.sheetGid; });
  if (sheets.length !== 1) throw new Error('FEEDBACK_NOT_CONFIRMED');
  var description = 'Garage completion output: put Manager comments in column G';
  var protections = (sheets[0].protectedRanges || []).filter(function(item) { return item.description === description; });
  if (protections.length > 1) throw new Error('FEEDBACK_NOT_CONFIRMED');
  var protection = { range: { sheetId: Number(config.sheetGid), startRowIndex: 1,
    startColumnIndex: 9, endColumnIndex: 10 }, description: description,
    warningOnly: false, editors: { users: [], groups: [], domainUsersCanEdit: false } };
  var request;
  if (protections.length) {
    protection.protectedRangeId = protections[0].protectedRangeId;
    request = { updateProtectedRange: { protectedRange: protection, fields: 'range,description,warningOnly,editors' } };
  } else request = { addProtectedRange: { protectedRange: protection } };
  feedbackGoogle_(config, ':batchUpdate', { requests: [request] });
}

function feedbackValues_(cells) {
  return Array.from({ length: 10 }, function(_, index) {
    var cell = cells[index] || {};
    if (index === 8 && typeof (cell.effectiveValue || {}).boolValue === 'boolean') {
      return cell.effectiveValue.boolValue ? 'TRUE' : 'FALSE';
    }
    return String(cell.formattedValue || '');
  });
}

function feedbackHash_(values) {
  var row = Array.from({ length: 10 }, function(_, index) { return String(values[index] || ''); });
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(row), Utilities.Charset.UTF_8)
    .map(function(value) { return ('0' + (value & 255).toString(16)).slice(-2); }).join('');
}

function feedbackBaseNotes_(notes, known) {
  var outputs = known.slice().sort(function(left, right) { return right.block.length - left.block.length; });
  for (var index = 0; index < outputs.length; index++) {
    var block = outputs[index].block;
    if (notes === block) return '';
    if (notes.endsWith('\n\n' + block)) return notes.slice(0, -block.length - 2);
  }
  return notes;
}

function feedbackValid_(item) {
  return item && /^[0-9a-f-]{36}$/i.test(item.order_id) && /^G-\d{6,}$/.test(item.order_number)
    && Number.isInteger(item.row_number) && item.row_number > 1 && item.row_number <= 5000
    && typeof item.complete === 'boolean' && /^[0-9a-f]{64}$/.test(item.observation_hash)
    && typeof item.source_key === 'string' && item.source_key.length <= 200
    && Array.isArray(item.source_keys) && item.source_keys.includes(item.source_key)
    && typeof item.block === 'string' && item.block.length <= 20000
    && item.block.startsWith('[Garage ' + item.order_number + ']\n') && item.block.endsWith('\n[/Garage]')
    && Array.isArray(item.known_outputs) && item.known_outputs.length <= 1000
    && item.known_outputs.every(function(output) {
      return output && typeof output.complete === 'boolean' && typeof output.block === 'string'
        && output.block.startsWith('[Garage ' + item.order_number + ']\n') && output.block.endsWith('\n[/Garage]');
    });
}

function feedbackBinding_(config, item, rowIndex) {
  var lookup = { metadataKey: 'garage_feedback_' + config.sourceId, metadataValue: item.order_id,
    visibility: 'DOCUMENT', locationType: 'ROW' };
  var search = feedbackGoogle_(config, '/developerMetadata:search', { dataFilters: [{ developerMetadataLookup: lookup }] });
  var matches = search.matchedDeveloperMetadata || [];
  if (matches.length > 1) return null;
  if (matches.length === 1) {
    var previous = matches[0].developerMetadata;
    var previousRange = previous && previous.location && previous.location.dimensionRange;
    if (!previousRange || previousRange.sheetId !== Number(config.sheetGid)) return null;
    // Sorting cell contents can leave metadata on the old physical row. Rebind
    // only our own anchor, after finding one exact current source observation.
    if (previousRange.startIndex !== rowIndex) {
      var previousValues = feedbackBoundRow_(config, previous.metadataId);
      if (!previousValues || feedbackHash_(previousValues.values) !== item.observation_hash) {
        feedbackGoogle_(config, ':batchUpdate', { requests: [{ deleteDeveloperMetadata: {
          dataFilter: { developerMetadataLookup: { metadataId: previous.metadataId } }
        } }] });
        matches = [];
      }
    }
  }
  if (!matches.length) {
    var created = feedbackGoogle_(config, ':batchUpdate', { requests: [{ createDeveloperMetadata: {
      developerMetadata: { metadataKey: lookup.metadataKey, metadataValue: lookup.metadataValue,
        visibility: 'DOCUMENT', location: { dimensionRange: {
          sheetId: Number(config.sheetGid), dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1
        } } }
    } }] });
    var metadata = (created.replies || [])[0];
    metadata = metadata && metadata.createDeveloperMetadata && metadata.createDeveloperMetadata.developerMetadata;
    if (!metadata) return null;
    matches = [{ developerMetadata: metadata }];
  }
  var binding = matches[0].developerMetadata, range = binding && binding.location && binding.location.dimensionRange;
  if (!binding || !Number.isInteger(binding.metadataId) || !range || range.sheetId !== Number(config.sheetGid)
      || range.dimension !== 'ROWS' || range.startIndex < 1 || range.endIndex !== range.startIndex + 1) return null;
  return binding.metadataId;
}

function feedbackBoundRow_(config, metadataId) {
  var result = feedbackGoogle_(config, ':getByDataFilter?fields=sheets(properties(sheetId),data(startRow,startColumn,rowData(values(formattedValue,effectiveValue,userEnteredValue))))', {
    dataFilters: [{ developerMetadataLookup: { metadataId: metadataId } }], includeGridData: true
  });
  var sheets = result.sheets || [];
  if (sheets.length !== 1 || String(sheets[0].properties.sheetId) !== config.sheetGid) return null;
  var blocks = sheets[0].data || [], rows = blocks.length === 1 ? blocks[0].rowData || [] : [];
  if (rows.length !== 1 || (blocks[0].startColumn || 0) !== 0 || (blocks[0].startRow || 0) < 1) return null;
  var cells = rows[0].values || [];
  if ((cells[8] && cells[8].userEnteredValue || {}).formulaValue
      || (cells[9] && cells[9].userEnteredValue || {}).formulaValue) return null;
  return { values: feedbackValues_(cells), rowIndex: blocks[0].startRow };
}

function feedbackApply_(config, result) {
  if (result.protocol !== 'feedback_v1' || !Array.isArray(result.feedback) || result.feedback.length > 5000
      || !result.feedback.every(feedbackValid_)) throw new Error('FEEDBACK_NOT_CONFIRMED');
  if (!result.feedback.length) return { updated: 0, deferred: 0 };
  var snapshot = readerSnapshotData_(config), hashes = {}, orderIds = {}, updated = 0, deferred = 0, attempted = 0;
  snapshot.values.forEach(function(row, index) {
    if (index === 0) return;
    var hash = feedbackHash_(row);
    if (!hashes[hash]) hashes[hash] = [];
    hashes[hash].push(index);
  });
  result.feedback.forEach(function(item) {
    if (orderIds[item.order_id]) throw new Error('FEEDBACK_NOT_CONFIRMED');
    orderIds[item.order_id] = true;
  });
  result.feedback.forEach(function(item) {
    var matches = hashes[item.observation_hash] || [];
    if (matches.length !== 1) { deferred++; return; }
    var row = snapshot.values[matches[0]], baseline = feedbackBaseNotes_(String(row[9] || ''), item.known_outputs);
    var notes = baseline ? baseline + '\n\n' + item.block : item.block;
    if (String(row[8]) === (item.complete ? 'TRUE' : 'FALSE') && String(row[9] || '') === notes) return;
    if (attempted >= 20 || notes.length > 50000) { deferred++; return; }
    attempted++;
    var metadataId = feedbackBinding_(config, item, matches[0]);
    if (metadataId === null) { deferred++; return; }
    var current = feedbackBoundRow_(config, metadataId);
    if (!current || feedbackHash_(current.values) !== item.observation_hash) { deferred++; return; }
    var values = Array.from({ length: 8 }, function() { return null; }).concat([item.complete, notes]);
    var saved = feedbackGoogle_(config, '/values:batchUpdateByDataFilter', {
      valueInputOption: 'RAW', data: [{ dataFilter: { developerMetadataLookup: { metadataId: metadataId } },
        majorDimension: 'ROWS', values: [values] }]
    });
    if (saved.totalUpdatedRows !== 1 || saved.totalUpdatedSheets !== 1 || saved.totalUpdatedCells !== 2) {
      throw new Error('FEEDBACK_NOT_CONFIRMED');
    }
    var confirmed = feedbackBoundRow_(config, metadataId);
    if (!confirmed || confirmed.values[8] !== (item.complete ? 'TRUE' : 'FALSE') || confirmed.values[9] !== notes) {
      throw new Error('FEEDBACK_NOT_CONFIRMED');
    }
    // Expand only the changed row so existing fixed heights cannot hide results.
    feedbackGoogle_(config, ':batchUpdate', { requests: [{ autoResizeDimensions: { dimensions: {
      sheetId: Number(config.sheetGid), dimension: 'ROWS', startIndex: confirmed.rowIndex, endIndex: confirmed.rowIndex + 1
    } } }] });
    updated++;
  });
  return { updated: updated, deferred: deferred };
}
