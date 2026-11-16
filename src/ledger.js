import { element, renderNotice } from './ui.js';
import { createLedgerCalculator } from './ledger-calculations.js';
import { ledgerButton, ledgerField, ledgerFailure, ledgerReadOnly, rowDescription, ledgerHeaders, ledgerIssues, resultFor } from './ledger-shared.js';
import { renderLedgerRows, sectionTotals } from './ledger-table.js';
import { createLedgerEditor } from './ledger-editor.js';
import { createLedgerHistory } from './ledger-history.js';

export function mountLedger({ profile, client }) {
  if (profile?.role !== 'admin' || !client) return { element: element('div'), dispose() {} };
  const root = element('section', { class: 'ledger-workspace', 'aria-label': 'Owner business ledger' });
  const abort = new AbortController(), receipts = new Map(), expanded = new Set();
  let active = true, loading = 0, pending = false, sheetLoading = false, staleCalculations = false;
  let imports = [], data = null, calculator = null, contextCache = null, editor = null, page = 0;
  const feedback = element('div', { 'aria-live': 'polite' }), source = element('div'), counts = element('div');
  const formArea = element('div'), list = element('div'), totals = element('div'), pages = element('div');
  const importSelect = element('select', { id: 'ledger-import', onchange: () => { setWorksheets(); loadSheet(); } });
  const sheetSelect = element('select', { id: 'ledger-sheet', onchange: () => loadSheet() });
  const sectionSelect = element('select', { id: 'ledger-section', onchange: () => { page = 0; draw(); } });
  const search = element('input', { id: 'ledger-search', type: 'search', placeholder: 'Description, payer, invoice or value', oninput: () => { page = 0; draw(); } });
  const archived = element('select', { id: 'ledger-archived', onchange: () => { page = 0; draw(); } },
    element('option', { value: 'active' }, 'Active entries'), element('option', { value: 'all' }, 'Include archived'), element('option', { value: 'archived' }, 'Archived only'));
  const refresh = ledgerButton('Refresh ledger', () => loadSheet());
  const add = ledgerButton('Add entry', () => openEditor(null), true);
  root.append(element('div', { class: 'ledger-toolbar' }, ledgerField('Workbook version', importSelect),
    ledgerField('Worksheet / period', sheetSelect), ledgerField('Section', sectionSelect), refresh, add), source,
    element('div', { class: 'ledger-toolbar' }, ledgerField('Search ledger', search), ledgerField('Records', archived)),
    counts, feedback, formArea, list, totals, pages);
  const controls = [importSelect, sheetSelect, sectionSelect, search, archived];

  async function rpc(name, parameters = {}) {
    const request = client.rpc(name, parameters);
    const response = await (typeof request.abortSignal === 'function' ? request.abortSignal(abort.signal) : request);
    if (response.error) throw response.error;
    return response.data;
  }
  function tell(title, message, error = false) { if (active) feedback.replaceChildren(renderNotice(title, message, error ? 'error' : 'info')); }
  function lock() {
    for (const control of controls) control.disabled = pending || sheetLoading || Boolean(editor);
    for (const control of root.querySelectorAll('[data-ledger-action], [data-ledger-fields]')) {
      control.disabled = pending || sheetLoading || staleCalculations && !control.closest('.ledger-form');
    }
    const section = data?.sheet.metadata?.sections?.find(item => item.id === sectionSelect.value);
    add.disabled = pending || sheetLoading || staleCalculations || !data || Boolean(editor) || section?.addable === false || /summary|totals|header|template/i.test(sectionSelect.value);
    refresh.disabled = pending || sheetLoading;
    root.setAttribute('aria-busy', String(pending || sheetLoading));
  }
  function closeEditor() { editor?.dispose(); editor = null; formArea.replaceChildren(); lock(); }
  function openEditor(row, history = false) {
    if (!data || pending || sheetLoading || staleCalculations || ledgerReadOnly(data.sheet, sectionSelect.value, row)) return;
    closeEditor();
    const selectedRows = data.rows.filter(item => item.section === sectionSelect.value);
    editor = history ? createLedgerHistory({ row, rpc, save, close: closeEditor })
      : createLedgerEditor({ sheet: data.sheet, section: sectionSelect.value, row, sampleRows: selectedRows,
        getCalculator: () => calculator, save, close: closeEditor });
    formArea.replaceChildren(editor.element); lock();
    formArea.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  function setWorksheets() {
    const selected = imports.find(item => item.id === importSelect.value), sheets = selected?.sheets || [];
    sheetSelect.replaceChildren(...sheets.map(sheet => element('option', { value: sheet.id }, sheet.name)));
    const period = sheet => {
      const value = sheet.metadata?.source_period;
      return value?.year && value?.month ? `${value.year}-${String(value.month).padStart(2, '0')}` : '';
    };
    const latest = [...sheets].filter(sheet => period(sheet)).sort((a, b) => period(b).localeCompare(period(a)))[0];
    if (latest) sheetSelect.value = latest.id;
  }
  async function loadSheet(showLoading = true) {
    if (!active || !sheetSelect.value) return false;
    const version = ++loading;
    sheetLoading = true; lock();
    if (showLoading) { list.replaceChildren(element('p', { role: 'status', class: 'ledger-notice' }, 'Loading private ledger records…')); refresh.disabled = true; }
    try {
      let next, context;
      for (let attempt = 0; attempt < 3; attempt++) {
        next = await rpc('garage_ledger_sheet', { p_sheet_id: sheetSelect.value });
        if (!active || version !== loading) return false;
        if (!next?.import || !next.sheet || !Array.isArray(next.rows)) throw new Error('Invalid ledger');
        context = contextCache?.id === next.import.id && contextCache.value.revision === next.import.revision
          ? contextCache.value : await rpc('garage_ledger_context', { p_import_id: next.import.id });
        if (context?.revision === next.import.revision) break;
        context = null;
      }
      if (!active || version !== loading) return false;
      if (!context) throw { code: '40001' };
      contextCache = { id: next.import.id, value: context }; calculator = createLedgerCalculator(context); staleCalculations = false;
      const previousSection = data?.sheet.id === next.sheet.id ? sectionSelect.value : '';
      data = next;
      const sections = data.sheet.metadata?.sections || [...new Set(data.rows.map(row => row.section))].map(id => ({ id, label: id }));
      sectionSelect.replaceChildren(...sections.map(section => element('option', { value: section.id }, section.label || section.id)));
      if (sections.some(section => section.id === previousSection)) sectionSelect.value = previousSection;
      else {
        const primary = sections.find(section => section.id === 'ledger' || section.id === 'entries' || section.kind === 'entries');
        if (primary) sectionSelect.value = primary.id;
      }
      page = 0; draw();
      if (showLoading) feedback.replaceChildren();
      return true;
    } catch (error) {
      if (active && version === loading) {
        if (data) { importSelect.value = data.import.id; setWorksheets(); sheetSelect.value = data.sheet.id; draw(); }
        else list.replaceChildren();
        tell('Ledger unavailable', ledgerFailure(error), true);
      }
      return false;
    } finally { if (active && version === loading) { sheetLoading = false; lock(); } }
  }
  function draw() {
    if (!active || !data) return;
    const { sheet } = data, section = sectionSelect.value;
    const sectionRows = data.rows.filter(row => row.section === section), needle = search.value.trim().toLocaleLowerCase();
    const headers = ledgerHeaders(sheet, section, sectionRows);
    const shown = sectionRows.filter(row => (archived.value === 'all' || row.archived === (archived.value === 'archived'))
      && (!needle || JSON.stringify([rowDescription(row, headers), row.source_row, row.cells]).toLocaleLowerCase().includes(needle)));
    const errorRows = sectionRows.filter(row => !row.archived && (ledgerIssues(sheet, row, headers, calculator).length
      || Object.keys(row.cells).some(column => resultFor(sheet, row, column, calculator).status === 'error'))).length;
    const manual = sectionRows.filter(row => !row.archived && row.source_row === null).length;
    const warnings = sheet.metadata?.warnings || [];
    source.replaceChildren(...[element('div', { class: 'ledger-source' }, element('div', {}, element('p', {}, data.import.name || data.import.filename || 'Imported workbook'),
      element('small', {}, `${sheet.name} · working revision ${data.import.revision} · Owner only`)),
      element('p', { class: 'ledger-notice' }, 'Original values remain available on every record.')),
      staleCalculations ? renderNotice('Refresh required', 'The current calculation context could not be confirmed. Refresh before starting another edit.', 'error') : null,
      warnings.length ? element('details', { class: 'ledger-source-detail' }, element('summary', {}, `${warnings.length} source review note${warnings.length === 1 ? '' : 's'}`),
        ...warnings.map(warning => element('p', { class: 'ledger-notice' }, typeof warning === 'string' ? warning : warning.message || warning.code || JSON.stringify(warning)))) : null].filter(Boolean));
    counts.replaceChildren(element('dl', { class: 'ledger-counts' }, ...[['Active records', sectionRows.filter(row => !row.archived).length],
      ['Need calculation review', errorRows], ['Manual entries', manual]].map(([label, number]) => element('div', {}, element('dt', {}, label), element('dd', {}, String(number))))));
    const maxPage = Math.max(0, Math.ceil(shown.length / 40) - 1); page = Math.min(page, maxPage);
    list.replaceChildren(renderLedgerRows({ sheet, rows: shown.slice(page * 40, page * 40 + 40), section, calculator, expanded,
      edit: row => openEditor(row), history: row => openEditor(row, true) }));
    const selected = sheet.metadata?.sections?.find(item => item.id === section);
    const totalable = selected?.totalable === true || selected?.kind === 'entries' || /^(ledger|entries|work_entries|main)$/.test(section);
    totals.replaceChildren(...(totalable ? [sectionTotals({ sheet, rows: sectionRows, section, calculator })] : []));
    pages.replaceChildren(element('div', { class: 'ledger-pagination' }, element('span', {}, shown.length
      ? `${page * 40 + 1}–${Math.min(shown.length, page * 40 + 40)} of ${shown.length} records` : '0 records'),
      element('div', { class: 'button-row' }, element('button', { type: 'button', class: 'button button-small', disabled: page === 0,
        onclick: () => { page--; draw(); } }, 'Previous records'), element('button', { type: 'button', class: 'button button-small', disabled: page >= maxPage,
        onclick: () => { page++; draw(); } }, 'Next records')))); lock();
  }
  async function save(name, parameters) {
    if (pending || sheetLoading || !active) return false;
    const args = { ...parameters, ...(name === 'garage_ledger_save_row' ? { p_sheet_id: data.sheet.id } : {}) };
    const fingerprint = JSON.stringify([name, args]);
    if (!receipts.has(fingerprint)) receipts.set(fingerprint, crypto.randomUUID());
    pending = true; lock();
    try {
      const result = await rpc(name, { ...args, p_request_id: receipts.get(fingerprint) });
      if (!active) return false;
      if (!result?.row || !Number.isInteger(result.revision)) throw new Error('Unconfirmed ledger save');
      receipts.delete(fingerprint); contextCache = null; calculator = null; staleCalculations = true;
      const existing = data.rows.findIndex(row => row.id === result.row.id);
      if (existing < 0) data.rows.push(result.row); else data.rows[existing] = result.row;
      data.import.revision = result.revision;
      const refreshed = await loadSheet(false);
      tell('Saved', refreshed ? 'The working ledger was updated. Its original workbook record is preserved.'
        : 'Your change was saved. Refresh the ledger to reload current calculations.'); return true;
    } catch (error) {
      if (active) {
        contextCache = null; calculator = null; staleCalculations = true;
        const refreshed = await loadSheet(false);
        if (refreshed && (error?.code === '40001' || /version|conflict|changed/i.test(error?.message || ''))) {
          editor?.showConflict?.(data?.rows.find(row => row.id === parameters.p_row_id));
        }
        tell('Change not confirmed', ledgerFailure(error), true);
      }
      return false;
    } finally { if (active) { pending = false; lock(); } }
  }
  async function initialize() {
    pending = true; lock(); list.replaceChildren(element('p', { role: 'status', class: 'ledger-notice' }, 'Loading private workbook versions…'));
    try {
      imports = await rpc('garage_ledger_imports');
      if (!active) return;
      if (!Array.isArray(imports)) throw new Error('Invalid workbook list');
      importSelect.replaceChildren(...imports.map(item => element('option', { value: item.id }, item.name || item.filename || 'Imported workbook')));
      if (!imports.length) {
        list.replaceChildren(renderNotice('No workbook imported', 'Import the private workbook before adding or editing its ledger records.')); return;
      }
      setWorksheets(); await loadSheet();
    } catch (error) { if (active) { list.replaceChildren(); tell('Ledger unavailable', ledgerFailure(error), true); list.append(ledgerButton('Retry ledger', initialize)); } }
    finally { if (active) { pending = false; lock(); } }
  }
  initialize();
  return { element: root, dispose() { active = false; loading++; abort.abort(); editor?.dispose();
    imports = []; data = null; calculator = null; contextCache = null; receipts.clear(); expanded.clear(); root.replaceChildren(); } };
}
