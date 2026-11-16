// Synthetic records for isolated browser checks; never uploaded business data.
globalThis.__garageCreateLedgerFake = fixture => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const source = clone(fixture.ledger || { imports: [], sheets: [] });
  const imports = source.imports, sheets = source.sheets, receipts = new Map(), histories = new Map();
  let serial = 0, lostResponse = false, conflicted = false, failRefresh = false;
  const error = (message, code = 'P0001') => ({ data: null, error: { message, code } });
  const workbook = sheet => imports.find(item => item.id === sheet.import_id);
  const fullRow = id => sheets.flatMap(sheet => sheet.rows.map(row => ({ sheet, row }))).find(item => item.row.id === id);
  for (const sheet of sheets) for (const row of sheet.rows) histories.set(row.id, [{ id: 'source', version: 1, action: 'import',
    actor_name: 'Source', created_at: '2026-11-01T10:00:00Z', reason: 'Original source snapshot',
    after_state: { cells: clone(row.original_cells), section: row.section, archived: false } }]);
  globalThis.__garageLedgerState = { imports, sheets, receipts, histories };
  return async (name, args, owner) => {
    if (!owner) return error('Owner access required.', '42501');
    if (name === 'garage_ledger_imports') return { data: imports.map(item => ({ ...clone(item), sheets: sheets.filter(sheet => sheet.import_id === item.id)
      .map(({ rows, ...sheet }) => clone(sheet)) })), error: null };
    if (name === 'garage_ledger_sheet') {
      const sheet = sheets.find(item => item.id === args.p_sheet_id);
      if (fixture.ledgerSheetError === args.p_sheet_id || failRefresh) { failRefresh = false; return error('Synthetic read failure.', 'NETWORK'); }
      return sheet ? { data: { import: clone(workbook(sheet)), sheet: clone(sheet), rows: clone(sheet.rows) }, error: null } : error('Sheet unavailable.');
    }
    if (name === 'garage_ledger_context') return { data: { revision: imports.find(item => item.id === args.p_import_id).revision,
      sheets: sheets.filter(sheet => sheet.import_id === args.p_import_id).map(sheet => ({ name: sheet.name,
        rows: sheet.rows.map(row => ({ source_row: row.source_row, cells: clone(row.cells), archived: row.archived })) })) }, error: null };
    if (name === 'garage_ledger_history') return { data: clone(histories.get(args.p_row_id) || []), error: null };
    if (!['garage_ledger_save_row', 'garage_ledger_restore'].includes(name)) return error('Unknown ledger operation.');
    const payload = clone(args); delete payload.p_request_id;
    const cached = receipts.get(args.p_request_id);
    if (cached) return cached.fingerprint === JSON.stringify(payload) ? { data: clone(cached.response), error: null } : error('Retry payload changed.', '40001');
    const selected = args.p_row_id ? fullRow(args.p_row_id) : null;
    const sheet = selected?.sheet || sheets.find(item => item.id === args.p_sheet_id);
    let row = selected?.row;
    if (fixture.ledgerConflictOnce && !conflicted && row) {
      conflicted = true; row.cells.C.value = 'Changed by another Owner'; row.version++; workbook(sheet).revision++;
      return error('This record changed.', '40001');
    }
    if (row ? row.version !== args.p_expected_version : args.p_expected_version !== 0) return error('The record version changed.', '40001');
    if (!args.p_reason?.trim()) return error('A reason is required.', '22023');
    let next;
    if (name === 'garage_ledger_restore') {
      const event = histories.get(row.id).find(item => String(item.id) === args.p_revision_id);
      if (!event) return error('Revision unavailable.');
      next = clone(event.after_state);
    } else next = { cells: clone(args.p_cells), section: args.p_section, archived: args.p_archived };
    if (row) {
      for (const [column, cell] of Object.entries(row.original_cells || {})) if (cell.formula && next.cells[column]?.formula !== cell.formula) return error('The source formula changed.');
      Object.assign(row, next); row.version++;
    } else {
      row = { id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(++serial + 100).padStart(12, '0')}`, source_row: null,
        position: sheet.rows.length + 1, original_cells: null, version: 1, ...next };
      sheet.rows.push(row); histories.set(row.id, []);
    }
    const events = histories.get(row.id);
    events.unshift({ id: `revision-${++serial}`, version: row.version, actor_name: 'Test Owner', action: name === 'garage_ledger_restore' ? 'restore' : next.archived ? 'archive' : 'save',
      reason: args.p_reason, created_at: '2026-11-16T12:00:00Z', after_state: clone(next) });
    const response = { row: clone(row), revision: ++workbook(sheet).revision };
    receipts.set(args.p_request_id, { fingerprint: JSON.stringify(payload), response: clone(response) });
    if (fixture.ledgerFailRefreshAfterSave) failRefresh = true;
    if (fixture.loseLedgerResponseOnce && !lostResponse) { lostResponse = true; return error('Synthetic response lost.', 'NETWORK'); }
    return { data: response, error: null };
  };
};
