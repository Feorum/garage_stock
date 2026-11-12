import { element, renderNotice } from './ui.js';

const SHEET_ID = /^[A-Za-z0-9_-]{20,200}$/;
const TAB_ID = /^\d{1,10}$/;
const READER_GUIDE = 'https://github.com/Feorum/garage_stock/tree/main/integrations/existing-google-sheet';

function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function parseSpreadsheetId(value) {
  const input = String(value || '').trim();
  if (SHEET_ID.test(input)) return input;
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
    if (url.protocol === 'https:' && url.hostname === 'docs.google.com' && match && SHEET_ID.test(match[1])) return match[1];
  } catch { /* A malformed URL is an input error. */ }
  return null;
}

export function parseSheetGid(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!parseSpreadsheetId(value)) return null;
    const gid = new URLSearchParams(url.hash.slice(1)).get('gid') ?? url.searchParams.get('gid');
    return TAB_ID.test(gid || '') && Number(gid) <= 2147483647 ? Number(gid) : null;
  } catch { return null; }
}

function feedbackMessage(error) {
  if (['PGRST202', '42883', '42P01'].includes(error?.code)) return 'Sheet connections are not available yet. Refresh after setup is finished.';
  if (error?.code === '42501') return 'Your account cannot manage this connection. Sign in as the Owner and retry.';
  if (error?.code === '40001' || /version|changed|conflict/i.test(error?.message || '')) return 'The connection changed. Refresh its current settings before retrying.';
  if (error?.code === '23505' || /already registered|already exists/i.test(error?.message || '')) return 'This spreadsheet is already connected. Find its connection below.';
  if (!error?.code || /fetch|network|timeout/i.test(error?.message || '')) return 'The change could not be confirmed. Keep this page open and retry the same action.';
  return 'The connection could not be updated. Check its name, spreadsheet link and tab ID, then retry.';
}

const REVIEW_MESSAGES = {
  NONSTANDARD_TASK_DETAIL: 'The additional instructions change the selected scope or dimensions. The Owner must clarify the request; it will not be treated as full, 25 cm or 45 cm hood coverage automatically.',
  UNKNOWN_WRAPPING_WORK: 'Choose wrapping work from the approved closed list.',
  UNKNOWN_TINT_WORK: 'Choose an approved rear-hemisphere tint package with an explicit 5% or 15% option.',
  INVALID_PLANNED_DATE: 'Enter a valid requested date.',
  INVALID_VIN: 'Enter a valid vehicle VIN.',
  INVALID_COMPLETION_FLAG: 'Restore the completed checkbox to a valid checked or unchecked value.',
  INVALID_MANAGER: 'Enter a Manager label within the supported length.',
  INVALID_VEHICLE: 'Enter a vehicle description within the supported length.',
  FIELD_TOO_LONG: 'Shorten the vehicle, work or instruction text to the supported length.',
  NO_APPROVED_TASKS: 'Select at least one approved work item.',
  WORK_UNAVAILABLE_FOR_VEHICLE: 'This work is unavailable for the selected vehicle model.',
  SOURCE_PROGRESS_REQUIRES_REVIEW: 'The notes indicate work may already have been performed. The Owner must reconcile it.',
  CONFIDENTIAL_NOTE_REQUIRES_REVIEW: 'The note may contain confidential financial information. The Owner must review it before sharing the request with Mechanics.',
  CONFLICTING_HOOD_SCOPE: 'Select one hood coverage option for this request.',
  CONFLICTING_TINT_OPTIONS: 'Select one tint percentage for this request.',
  MALFORMED_WORK_LIST: 'Check the selected work list and its separators.',
  TASK_DETAIL_TARGET_MISSING: 'An additional instruction refers to a work item that is not selected.',
  AMBIGUOUS_TASK_DETAIL_TAG: 'Clarify which selected work item the additional instruction belongs to.',
  INVALID_TASK_DETAIL_TAG: 'Use a valid approved work reference for the additional instruction.',
  DUPLICATE_TASK_DETAIL_TAG: 'Combine the additional instructions for the same work item into one entry.',
  EMPTY_TASK_DETAIL: 'Add text to the selected work instruction or remove its empty reference.',
  TASK_DETAIL_TOO_LONG: 'Shorten the additional work instruction.',
  SOURCE_IDENTITY_CHANGED: 'The vehicle visit identity changed or is ambiguous. The Owner must reconcile it.',
  COMPLETED_HISTORY_REOPENED: 'This visit was already completed in the source history. The Owner must review it before any new work is created.',
  SOURCE_MARKED_COMPLETED: 'The source now marks an imported visit completed. The Owner must reconcile it with the app; the checkbox does not complete app tasks.',
  DUPLICATE_SOURCE_IDENTITY: 'More than one row describes this vehicle visit. The Owner must reconcile them.',
  DUPLICATE_SOURCE_KEY: 'More than one row describes this vehicle visit. The Owner must reconcile them.',
  DELIVERY_PENDING: 'Delivery is awaiting confirmation and will retry automatically.',

  invalid_or_missing_vin: 'Enter a valid vehicle VIN.',
  date_missing_or_ambiguous: 'Clarify the requested date.',
  missing_vehicle_group: 'Select the vehicle model from the approved list.',
  unknown_vehicle_group: 'Select the vehicle model from the approved list.',
  ambiguous_atlas_group: 'Select the exact Atlas model from the approved list.',
  model_alias_requires_confirmation: 'Clarify the vehicle model using the approved list.',
  unapproved_finish_variant: 'The requested film finish needs Owner review.',
  unrecognized_scope_fragment: 'Clarify the requested work using the closed work list.',
  work_alias_requires_confirmation: 'Clarify the requested work using the closed work list.',
  unsupported_hood_width: 'Select an approved hood coverage option.',
  unsupported_tint_percentage: 'Select an approved tint option: 5% or 15%.',
  tint_percentage_required: 'Select the tint percentage: 5% or 15%.',
  tint_scope_requires_confirmation: 'Clarify the tint package using the approved list.',
  unavailable_work: 'This work is unavailable for the selected vehicle model.',
  work_unavailable_for_model: 'This work is unavailable for the selected vehicle model.',
  partial_completion_in_notes: 'The notes indicate work may already have been performed. Review it with the Owner.',
  partial_work_in_notes: 'The notes indicate work may already have been performed. Review it with the Owner.',
  duplicate_source_identity: 'More than one row describes this vehicle visit. The Owner must reconcile them.',
  ambiguous_source_identity: 'The vehicle visit identity changed or is ambiguous. The Owner must reconcile it.',
  missing_requested_work: 'Select at least one work item from the approved list.',
  no_tasks: 'Select at least one work item from the approved list.',
  formula_or_error_in_input: 'Replace the formula or error in the order input with a valid selection.',
  ORDER_CHANGED: 'The order has changed in the app. The Owner must review the requested amendment.',
  ORDER_CLOSED: 'The order is closed in the app. The Owner must review this row.',
  VALIDATION_FAILED: 'Check the vehicle model and approved work selections.',
};

function connectionUrl(source, row) {
  if (!SHEET_ID.test(String(source.spreadsheet_id || ''))) return null;
  const gid = Number(source.sheet_gid);
  if (!Number.isSafeInteger(gid) || gid < 0 || gid > 2147483647) return null;
  const rowNumber = Number(row);
  const range = Number.isSafeInteger(rowNumber) && rowNumber > 0 ? `&range=A${rowNumber}:J${rowNumber}` : '';
  return `https://docs.google.com/spreadsheets/d/${source.spreadsheet_id}/edit#gid=${gid}${range}`;
}

export function mountSheets({ profile, client }) {
  if (profile?.role !== 'admin' || !client) return { element: element('div'), dispose() {} };
  const root = element('section', { class: 'sheets-workspace', 'aria-label': 'Sheet connections' });
  const abort = new AbortController();
  let active = true, pending = false, loadVersion = 0, reviewVersion = 0, sources = [];
  let setup = null, readerAttempt = null;
  const feedback = element('div', { class: 'sheets-feedback', 'aria-live': 'polite' });
  const sourceList = element('div', { class: 'sheet-source-list' });
  const setupArea = element('div', { class: 'sheet-setup-area' });
  const reviewArea = element('div', { class: 'sheet-review-area sheet-source-list', 'aria-live': 'polite' });
  const sourceName = element('input', { id: 'sheet-name', type: 'text', required: true, maxlength: '120', autocomplete: 'off', placeholder: 'Working copy of Manager orders' });
  const spreadsheet = element('input', { id: 'sheet-url', type: 'text', required: true, autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the link to the existing order tab' });
  const tab = element('input', { id: 'sheet-tab', type: 'text', inputmode: 'numeric', required: true, pattern: '[0-9]{1,10}', autocomplete: 'off', placeholder: 'The gid number in the tab link' });
  spreadsheet.addEventListener('input', () => { const gid = parseSheetGid(spreadsheet.value); if (gid !== null) tab.value = String(gid); });
  const connect = actionButton('Connect working copy', () => {}, 'button button-primary');
  connect.type = 'submit';
  const connectionFields = element('fieldset', { class: 'sheet-registration-fields' },
    element('legend', {}, 'Connect a working copy'),
    element('div', { class: 'form-grid' }, field('Connection name', sourceName), field('Spreadsheet link or ID', spreadsheet), field('Order tab ID (gid)', tab)),
    element('p', { class: 'field-hint' }, 'Use a full working copy of the existing Manager spreadsheet. Pasting its tab link fills the tab ID automatically. The original is not connected or modified.'),
    element('div', { class: 'button-row form-actions' }, connect));
  const form = element('form', { class: 'sheet-registration', onsubmit: connectSource }, connectionFields);
  const refreshButton = actionButton('Refresh status', () => refresh(), 'button');
  root.append(element('div', { class: 'sheet-introduction' },
    element('p', {}, 'The importer reads a working copy of the Manager spreadsheet in its existing layout and sends valid unfinished requests to the shared mechanic queue.'),
    element('p', { class: 'muted' }, 'The original stays untouched. Completed rows are excluded; unclear selections wait for Owner review. Private copies need a one-time Owner Google reader setup. Managers need no app account or Submit step.')),
    feedback, setupArea, form, element('div', { class: 'sheet-list-heading' }, element('h2', {}, 'Connected spreadsheets'), refreshButton), sourceList, reviewArea);

  function actionButton(text, onclick, className = 'button button-small') {
    return element('button', { type: 'button', class: className, 'data-sheet-action': '', onclick }, text);
  }
  function field(label, input) { return element('div', { class: 'order-field' }, element('label', { for: input.id }, label), input); }
  function lock(value) {
    pending = value;
    if (value) { loadVersion += 1; sourceList.removeAttribute('aria-busy'); }
    root.setAttribute('aria-busy', String(value));
    connectionFields.disabled = value;
    for (const button of root.querySelectorAll('[data-sheet-action]')) button.disabled = value;
  }
  function tell(title, message, error = false) { if (active) feedback.replaceChildren(renderNotice(title, message, error ? 'error' : 'info')); }
  async function rpc(name, parameters = {}) {
    const request = client.rpc(name, parameters);
    const response = await (typeof request.abortSignal === 'function' ? request.abortSignal(abort.signal) : request);
    if (response.error) throw response.error;
    return response.data;
  }
  function formatTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString(); }
  function drawSources() {
    if (!active) return;
    if (!sources.length) {
      sourceList.replaceChildren(element('div', { class: 'empty-state' }, element('h2', {}, 'No working copy connected'), element('p', {}, 'Connect a full working copy in the existing Manager spreadsheet layout.')));
      return;
    }
    sourceList.replaceChildren(...sources.map(source => {
      const url = connectionUrl(source), checked = Boolean(source.last_success_at), failed = Boolean(source.last_error_code);
      const status = !source.active ? 'Imports paused' : failed ? 'Check needed' : checked ? 'Has synchronized' : source.reader_only ? 'Waiting for private reader' : 'Waiting for first sync';
      const detail = !source.active ? 'New spreadsheet imports are paused. Existing app orders remain available.'
        : failed ? 'The latest check could not finish. The server will retry; existing app orders are preserved.'
          : checked ? `Last successful check: ${formatTime(source.last_success_at)}` : source.reader_only ? 'Connected. Set up the private Google reader once; the copy stays private.' : 'Connected. Waiting for the scheduled server check.';
      const count = Number(source.review_count) || 0;
      const settling = Number(source.summary?.awaiting_stability) || 0;
      return element('article', { class: 'sheet-source-card', 'data-source-id': source.id || source.source_id },
        element('div', { class: 'sheet-source-heading' }, element('h3', {}, source.name), element('span', { class: 'tag tag-neutral' }, status)),
        element('p', { class: 'sheet-source-detail' }, detail),
        element('p', { class: 'sheet-source-detail' }, count ? `${count} spreadsheet ${count === 1 ? 'row needs' : 'rows need'} Owner review.` : checked ? 'No rows are currently waiting for review.' : 'Review results appear after the first successful read.'),
        settling ? element('p', { class: 'sheet-source-detail' }, `${settling} ${settling === 1 ? 'request is' : 'requests are'} waiting for a second unchanged read, at least one minute apart, before publication.`) : null,
        element('div', { class: 'sheet-source-actions' },
          url ? element('a', { class: 'button button-small', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open working copy') : null,
          actionButton(source.active ? 'Pause imports' : 'Resume imports', () => setActive(source)), actionButton('Review rows', () => showReviews(source)),
          actionButton('Set up private reader', () => prepareReader(source))),
        element('p', { class: 'field-hint' }, 'Work choices belong to the approved closed catalogue. Prices are kept separately in the Owner account.'));
    }));
    if (pending) lock(true);
  }
  function readerProperties() {
    if (!setup) return null;
    let apiUrl = '';
    try {
      const url = new URL(client.supabaseUrl);
      if (url.protocol === 'https:') apiUrl = `${url.origin}/functions/v1/pull-manager-sheets/source`;
    } catch { /* The configured public API URL is required for installation. */ }
    return { SPREADSHEET_ID: setup.spreadsheetId, SHEET_GID: String(setup.sheetGid),
      INTEGRATION_ID: setup.sourceId, INTEGRATION_SECRET: setup.secret, API_URL: apiUrl };
  }
  function drawSetup() {
    if (!active || !setup) return;
    const fields = Object.entries(readerProperties()).map(([key, value]) => {
      const input = element('input', { id: `setup-${key.toLowerCase()}`, type: key === 'INTEGRATION_SECRET' ? 'password' : 'text',
        value, readonly: '', autocomplete: 'off', spellcheck: 'false' });
      const wrap = field(key, input);
      if (key === 'INTEGRATION_SECRET') wrap.append(actionButton('Show secret', event => {
        const reveal = input.type === 'password'; input.type = reveal ? 'text' : 'password';
        event.currentTarget.textContent = reveal ? 'Hide secret' : 'Show secret';
      }));
      return wrap;
    });
    setupArea.replaceChildren(element('section', { class: 'sheet-setup', 'aria-label': 'Private reader setup' },
      element('div', { class: 'sheet-source-heading' }, element('h2', {}, 'Private reader setup'), element('span', { class: 'tag' }, 'Owner only')),
      element('p', {}, 'The reader uses your Google access to read only the configured working copy. It does not edit either spreadsheet or make the copy public.'),
      element('ol', { class: 'sheet-setup-steps' },
        element('li', {}, 'Create a standalone Google Apps Script project that only you can edit.'),
        element('li', {}, 'Copy the reader code and manifest from the instructions, then add the setup function below.'),
        element('li', {}, 'Run setupConnection once and complete Google authorization. It installs a reader trigger that checks the copy every minute.'),
        element('li', {}, 'Delete the temporary setupConnection function afterward. Keep the reader project private.')),
      element('div', { class: 'sheet-setup-links' }, element('a', { href: READER_GUIDE, target: '_blank', rel: 'noopener noreferrer' }, 'Open reader code and instructions')),
      element('div', { class: 'sheet-setup-properties' }, ...fields),
      element('p', { class: 'field-hint' }, 'Copy the settings now; the key cannot be retrieved later. Never place it in a shared spreadsheet. Setting up a new reader key disables the previous one.'),
      element('div', { class: 'button-row form-actions' }, actionButton('Copy setup function', copySetup, 'button button-primary'),
        actionButton('Hide setup credentials', () => { setup = null; setupArea.replaceChildren(); }))));
  }
  async function copySetup() {
    if (!active || !setup) return;
    const text = `function setupConnection() {\n  PropertiesService.getScriptProperties().setProperties(${JSON.stringify(readerProperties(), null, 2)});\n  install();\n}\n`;
    try {
      await navigator.clipboard.writeText(text);
      if (active) tell('Copied', 'Paste this only into your private standalone reader project. It includes the connection key.');
    } catch { if (active) tell('Copy unavailable', 'Copy the displayed settings, or allow clipboard access in your browser.', true); }
  }
  async function prepareReader(source) {
    if (!active || pending) return;
    const sourceId = source.id || source.source_id;
    if (!readerAttempt || readerAttempt.sourceId !== sourceId || readerAttempt.version !== source.version) {
      readerAttempt = { sourceId, version: source.version, secret: generateSecret() };
    }
    lock(true);
    try {
      const result = await rpc('garage_prepare_sheet_reader', {
        p_source_id: sourceId, p_secret: readerAttempt.secret, p_expected_version: readerAttempt.version,
      });
      if (!active) return;
      setup = { sourceId, secret: readerAttempt.secret, spreadsheetId: source.spreadsheet_id, sheetGid: source.sheet_gid };
      readerAttempt = null;
      sources = sources.map(item => (item.id || item.source_id) === sourceId ? { ...item, ...result } : item);
      drawSources(); drawSetup();
      tell('Private reader settings ready', 'Complete the Google setup below. Synchronization is confirmed only after an actual successful read.');
    } catch (error) { if (active) tell('Reader setup not confirmed', feedbackMessage(error), true); }
    finally { if (active) lock(false); }
  }
  async function refresh({ preserveFeedback = false } = {}) {
    if (!active || pending) return;
    const request = ++loadVersion;
    refreshButton.disabled = true;
    sourceList.setAttribute('aria-busy', 'true');
    if (!sources.length) sourceList.replaceChildren(element('p', { class: 'orders-loading' }, 'Loading spreadsheet connections…'));
    try {
      const result = await rpc('garage_sheet_pull_sources');
      if (!active || request !== loadVersion) return;
      sources = Array.isArray(result) ? result : [];
      drawSources();
      if (!preserveFeedback) feedback.replaceChildren();
    } catch (error) {
      if (active && request === loadVersion) { sourceList.replaceChildren(); tell('Connections unavailable', feedbackMessage(error), true); }
    } finally {
      if (active && request === loadVersion) { refreshButton.disabled = false; sourceList.removeAttribute('aria-busy'); }
    }
  }
  async function connectSource(event) {
    event.preventDefault();
    if (!active || pending) return;
    const name = sourceName.value.trim(), spreadsheetId = parseSpreadsheetId(spreadsheet.value), gid = tab.value.trim();
    if (!name || !spreadsheetId || !TAB_ID.test(gid) || Number(gid) > 2147483647) {
      tell('Check the connection', 'Enter a name, a valid Google Sheets link or ID, and the order tab ID.', true); return;
    }
    lock(true);
    try {
      const result = await rpc('garage_connect_sheet_pull', { p_name: name, p_spreadsheet_id: spreadsheetId, p_sheet_gid: Number(gid) });
      if (!active) return;
      sourceName.value = ''; spreadsheet.value = ''; tab.value = '';
      sources = [result, ...sources.filter(source => (source.id || source.source_id) !== (result.id || result.source_id))];
      drawSources();
      tell('Working copy connected', 'Complete the private reader setup to start importing. The original spreadsheet is not connected.');
    } catch (error) { if (active) tell('Connection not confirmed', feedbackMessage(error), true); }
    finally { if (active) lock(false); }
  }
  async function setActive(source) {
    if (!active || pending) return;
    const sourceId = source.id || source.source_id;
    lock(true);
    try {
      const result = await rpc('garage_set_sheet_active', { p_source_id: sourceId, p_active: !source.active, p_expected_version: source.version });
      if (!active) return;
      sources = sources.map(item => (item.id || item.source_id) === sourceId ? { ...item, ...result } : item);
      drawSources();
      tell(result.active ? 'Imports resumed' : 'Imports paused', result.active ? 'The configured reader can check the working copy again on its schedule.' : 'New spreadsheet requests are paused. Existing orders remain in the app.');
    } catch (error) { if (active) tell('Connection change not confirmed', feedbackMessage(error), true); }
    finally { if (active) lock(false); }
  }
  async function showReviews(source) {
    if (!active || pending) return;
    const request = ++reviewVersion;
    reviewArea.replaceChildren(element('p', { class: 'orders-loading' }, 'Loading rows for Owner review…'));
    try {
      const result = await rpc('garage_sheet_pull_reviews', { p_source_id: source.id || source.source_id });
      if (!active || request !== reviewVersion) return;
      const rows = Array.isArray(result) ? result : [];
      const cards = rows.map(row => {
        const url = connectionUrl(source, row.row_number), reasons = Array.isArray(row.reason_codes) ? row.reason_codes : [];
        const messages = [...new Set(reasons.map(code => REVIEW_MESSAGES[code] || REVIEW_MESSAGES[String(code).toLowerCase()] || 'This row needs Owner review before it can be imported.'))];
        return element('article', { class: 'sheet-source-card' },
          element('h3', {}, `Row ${Number.isSafeInteger(Number(row.row_number)) ? Number(row.row_number) : '—'}${row.vehicle ? ` · ${String(row.vehicle)}` : ''}`),
          row.planned_date ? element('p', { class: 'sheet-source-detail' }, `Requested date: ${String(row.planned_date)}`) : null,
          element('ul', { class: 'sheet-setup-steps' }, ...messages.map(message => element('li', {}, message))),
          url ? element('a', { class: 'button button-small', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open source row') : null);
      });
      reviewArea.replaceChildren(
        element('div', { class: 'sheet-list-heading' }, element('h2', {}, 'Rows for Owner review'), actionButton('Close review', () => { reviewVersion += 1; reviewArea.replaceChildren(); })),
        element('p', { class: 'sheet-source-detail' }, rows.length ? 'Clarify ambiguous vehicle or work selections in the working copy; the next check will retry. Changes to work already started in the app need Owner reconciliation.' : 'No rows are currently waiting for review.'), ...cards);
    } catch (error) {
      if (active && request === reviewVersion) reviewArea.replaceChildren(renderNotice('Review unavailable', feedbackMessage(error), 'error'));
    }
  }
  refresh();
  return { element: root, dispose() { active = false; loadVersion += 1; reviewVersion += 1; abort.abort(); sources = []; setup = null; readerAttempt = null; root.replaceChildren(); } };
}
