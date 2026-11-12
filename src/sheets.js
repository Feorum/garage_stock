import { element, renderNotice } from './ui.js';

const WORKER_GUIDE = 'https://github.com/Feorum/garage_stock/tree/main/integrations/google-sheets';
const SHEET_ID = /^[A-Za-z0-9_-]{20,200}$/;

export function parseSpreadsheetId(value) {
  const input = String(value || '').trim();
  if (SHEET_ID.test(input)) return input;
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
    if (url.protocol === 'https:' && url.hostname === 'docs.google.com' && match && SHEET_ID.test(match[1])) return match[1];
  } catch { /* A malformed URL is an input error, not a different source. */ }
  return null;
}

function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function feedbackMessage(error) {
  if (['PGRST202', '42883', '42P01'].includes(error?.code)) return 'Sheet connections are not available yet. Refresh after setup is finished.';
  if (error?.code === '42501') return 'Your account cannot manage this connection. Sign in as the Owner and retry.';
  if (error?.code === '40001' || /version|changed|conflict/i.test(error?.message || '')) return 'The connection changed. Refresh its current settings before retrying.';
  if (error?.code === '23505' || /already registered|already exists/i.test(error?.message || '')) return 'This spreadsheet is already registered. Find its connection below instead of creating another.';
  if (!error?.code || /fetch|network|timeout/i.test(error?.message || '')) return 'The change could not be confirmed. Keep this page open and retry the same action.';
  return 'The connection could not be updated. Check its name and spreadsheet link, then retry.';
}

function connectionUrl(id) {
  return SHEET_ID.test(String(id || '')) ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null;
}

// Credentials exist only in this Owner view's memory/DOM. Navigation and logout
// dispose the entire mount, including pending requests and one-time setup data.
export function mountSheets({ profile, client }) {
  if (profile?.role !== 'admin' || !client) return { element: element('div'), dispose() {} };

  const root = element('section', { class: 'sheets-workspace', 'aria-label': 'Sheet connections' });
  const abort = new AbortController();
  let active = true;
  let pending = false;
  let loadVersion = 0;
  let sources = [];
  let registrationAttempt = null;
  let rotationAttempt = null;
  let setup = null;

  const feedback = element('div', { class: 'sheets-feedback', 'aria-live': 'polite' });
  const sourceList = element('div', { class: 'sheet-source-list' });
  const setupArea = element('div', { class: 'sheet-setup-area' });
  const sourceName = element('input', { id: 'sheet-name', name: 'sheet-name', type: 'text', required: true, maxlength: '120', autocomplete: 'off', placeholder: 'Manager order workbook' });
  const spreadsheet = element('input', { id: 'sheet-url', name: 'sheet-url', type: 'text', required: true, autocomplete: 'off', spellcheck: 'false', placeholder: 'https://docs.google.com/spreadsheets/d/…' });
  const register = actionButton('Register spreadsheet', () => {}, 'button button-primary');
  register.type = 'submit';
  const registrationFields = element('fieldset', { class: 'sheet-registration-fields' },
    element('legend', {}, 'Register a Manager workbook'),
    element('div', { class: 'form-grid' },
      field('Connection name', sourceName), field('Spreadsheet link or ID', spreadsheet)),
    element('p', { class: 'field-hint' }, 'Use the sanitized Manager template. Keep pricing and accounting workbooks separate.'),
    element('div', { class: 'button-row form-actions' }, register));
  const form = element('form', { class: 'sheet-registration', onsubmit: registerSource }, registrationFields);
  const refreshButton = actionButton('Refresh status', () => refresh(), 'button');

  root.append(
    element('div', { class: 'sheet-introduction' },
      element('p', {}, 'Managers submit vehicle orders through a separate workbook. Valid submissions enter the shared queue automatically.'),
      element('p', { class: 'muted' }, 'The Google worker needs a one-time setup in a standalone project owned only by you. Registration alone does not start synchronization.')),
    feedback, setupArea, form,
    element('div', { class: 'sheet-list-heading' }, element('h2', {}, 'Registered workbooks'), refreshButton), sourceList);

  function actionButton(text, onclick, className = 'button button-small') {
    return element('button', { type: 'button', class: className, 'data-sheet-action': '', onclick }, text);
  }

  function field(label, input) {
    return element('div', { class: 'order-field' }, element('label', { for: input.id }, label), input);
  }

  function lock(value) {
    pending = value;
    if (value) {
      // A slow pre-mutation list read must not overwrite the mutation result.
      loadVersion += 1;
      sourceList.removeAttribute('aria-busy');
    }
    root.setAttribute('aria-busy', String(value));
    registrationFields.disabled = value;
    for (const button of root.querySelectorAll('[data-sheet-action]')) button.disabled = value;
  }

  function tell(title, message, error = false) {
    if (active) feedback.replaceChildren(renderNotice(title, message, error ? 'error' : 'info'));
  }

  async function rpc(name, parameters = {}) {
    const request = client.rpc(name, parameters);
    const response = await (typeof request.abortSignal === 'function' ? request.abortSignal(abort.signal) : request);
    if (response.error) throw response.error;
    return response.data;
  }

  function apiUrl() {
    try {
      const url = new URL(client.supabaseUrl);
      if (url.protocol === 'https:') return `${url.origin}/functions/v1/manager-orders`;
    } catch { /* The user can still inspect the source without an endpoint hint. */ }
    return '';
  }

  function drawSources() {
    if (!active) return;
    if (!sources.length) {
      sourceList.replaceChildren(element('div', { class: 'empty-state' },
        element('h2', {}, 'No Manager workbook registered'),
        element('p', {}, 'Register the workbook you want to use, then complete its private worker setup.')));
      return;
    }
    sourceList.replaceChildren(...sources.map(source => {
      const url = connectionUrl(source.spreadsheet_id);
      const synced = Boolean(source.last_success_at);
      const sourceStatus = !source.active ? 'Imports paused' : synced ? 'Has synchronized' : 'Waiting for first sync';
      const detail = !source.active ? 'The server will not accept new submissions from this connection.'
        : synced ? `Last successful sync: ${formatTime(source.last_success_at)}`
          : 'Registered. Complete the Google worker setup to start delivering submissions.';
      const card = element('article', { class: 'sheet-source-card', 'data-source-id': source.id || source.source_id },
        element('div', { class: 'sheet-source-heading' },
          element('h3', {}, source.name), element('span', { class: 'tag tag-neutral' }, sourceStatus)),
        element('p', { class: 'sheet-source-detail' }, detail),
        element('p', { class: 'sheet-source-id' }, `Connection ID: ${source.id || source.source_id}`),
        source.last_error ? element('p', { class: 'sheet-source-error' }, 'A submission needs attention. Check the workbook’s delivery feedback before retrying.') : null,
        element('div', { class: 'sheet-source-actions' },
          url ? element('a', { class: 'button button-small', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open workbook') : null,
          actionButton(source.active ? 'Pause imports' : 'Resume imports', () => setActive(source)),
          actionButton('Replace worker secret', () => rotateSecret(source))),
        element('p', { class: 'field-hint' }, 'Replacing the secret stops the old worker until you update its private settings.'));
      return card;
    }));
    if (pending) lock(true);
  }

  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
  }

  function setupProperties() {
    if (!setup) return null;
    return {
      SPREADSHEET_ID: setup.spreadsheetId,
      INTEGRATION_ID: setup.sourceId,
      INTEGRATION_SECRET: setup.secret,
      API_URL: apiUrl()
    };
  }

  async function copySetup(asFunction) {
    if (!active || !setup) return;
    const properties = setupProperties();
    const text = asFunction
      ? `function setupConnection() {\n  PropertiesService.getScriptProperties().setProperties(${JSON.stringify(properties, null, 2)});\n  install();\n}\n`
      : JSON.stringify(properties, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      if (active) tell('Copied', 'Paste this only into your private standalone worker project. It includes the connection secret.');
    } catch {
      if (active) tell('Copy unavailable', 'Select and copy the property values below, or allow clipboard access in your browser.', true);
    }
  }

  function hideSetup() {
    setup = null;
    setupArea.replaceChildren();
  }

  function drawSetup() {
    if (!active || !setup) return;
    const properties = setupProperties();
    const values = Object.entries(properties).map(([key, value]) => {
      const input = element('input', {
        id: `setup-${key.toLowerCase()}`, type: key === 'INTEGRATION_SECRET' ? 'password' : 'text',
        value, readonly: '', autocomplete: 'off', spellcheck: 'false'
      });
      const wrap = field(key, input);
      if (key === 'INTEGRATION_SECRET') {
        wrap.append(actionButton('Show secret', event => {
          const revealed = input.type === 'password';
          input.type = revealed ? 'text' : 'password';
          event.currentTarget.textContent = revealed ? 'Hide secret' : 'Show secret';
        }, 'button button-small secret-toggle'));
      }
      return wrap;
    });
    setupArea.replaceChildren(element('section', { class: 'sheet-setup', 'aria-label': 'Private worker setup' },
      element('div', { class: 'sheet-source-heading' }, element('h2', {}, 'Private worker setup'), element('span', { class: 'tag' }, 'Owner only')),
      element('p', {}, 'Copy these settings now. The secret is not stored in this browser and cannot be retrieved from the connection list.'),
      element('ol', { class: 'sheet-setup-steps' },
        element('li', {}, 'Create a standalone Google Apps Script project that only you can edit.'),
        element('li', {}, 'Copy the worker code, then add the setup function from this page.'),
        element('li', {}, 'Run setupConnection once and complete Google authorization. The worker creates a private control workbook and a timed trigger.'),
        element('li', {}, 'Delete the temporary setupConnection function after setup. Keep the worker project private.')),
      element('div', { class: 'sheet-setup-links' },
        element('a', { href: WORKER_GUIDE, target: '_blank', rel: 'noopener noreferrer' }, 'Open worker code and instructions')),
      element('div', { class: 'sheet-setup-properties' }, values),
      element('p', { class: 'field-hint' }, 'Keep the worker and its control workbook private. Never paste the secret into the shared Manager workbook. CONTROL_SPREADSHEET_ID is created automatically for the separate private outbox.'),
      element('div', { class: 'button-row form-actions' },
        actionButton('Copy setup function', () => copySetup(true), 'button button-primary'),
        actionButton('Copy properties JSON', () => copySetup(false)),
        actionButton('Hide setup credentials', hideSetup))));
  }

  async function refresh({ preserveFeedback = false } = {}) {
    if (!active || pending) return;
    const request = ++loadVersion;
    refreshButton.disabled = true;
    sourceList.setAttribute('aria-busy', 'true');
    if (!sources.length) sourceList.replaceChildren(element('p', { class: 'orders-loading' }, 'Loading workbook connections…'));
    try {
      const result = await rpc('garage_sheet_sources');
      if (!active || request !== loadVersion) return;
      sources = Array.isArray(result) ? result : [];
      drawSources();
      if (!preserveFeedback) feedback.replaceChildren();
    } catch (error) {
      if (active && request === loadVersion) {
        sourceList.replaceChildren();
        tell('Connections unavailable', feedbackMessage(error), true);
      }
    } finally {
      if (active && request === loadVersion) {
        refreshButton.disabled = false;
        sourceList.removeAttribute('aria-busy');
      }
    }
  }

  async function registerSource(event) {
    event.preventDefault();
    if (!active || pending) return;
    const name = sourceName.value.trim();
    const spreadsheetId = parseSpreadsheetId(spreadsheet.value);
    if (!name || !spreadsheetId) {
      tell('Check the connection', 'Enter a name and a valid Google Sheets link or spreadsheet ID.', true);
      return;
    }
    if (!registrationAttempt || registrationAttempt.name !== name || registrationAttempt.spreadsheetId !== spreadsheetId) {
      registrationAttempt = { name, spreadsheetId, sourceId: crypto.randomUUID(), secret: generateSecret() };
    }
    lock(true);
    try {
      const result = await rpc('garage_register_sheet', {
        p_name: name, p_spreadsheet_id: spreadsheetId,
        p_source_id: registrationAttempt.sourceId, p_secret: registrationAttempt.secret
      });
      if (!active) return;
      setup = { ...registrationAttempt };
      registrationAttempt = null;
      drawSetup();
      sourceName.value = '';
      spreadsheet.value = '';
      sources = [result, ...sources.filter(source => (source.id || source.source_id) !== (result.id || result.source_id))];
      drawSources();
      tell('Spreadsheet registered', 'Complete the private Google worker setup. Synchronization will be confirmed only after a successful request.');
    } catch (error) {
      if (active) tell('Registration not confirmed', feedbackMessage(error), true);
    } finally {
      if (active) lock(false);
    }
  }

  async function rotateSecret(source) {
    if (!active || pending) return;
    const sourceId = source.id || source.source_id;
    if (!rotationAttempt || rotationAttempt.sourceId !== sourceId || rotationAttempt.version !== source.version) {
      rotationAttempt = { sourceId, version: source.version, secret: generateSecret() };
    }
    lock(true);
    try {
      const result = await rpc('garage_rotate_sheet_secret', {
        p_source_id: sourceId, p_secret: rotationAttempt.secret, p_expected_version: rotationAttempt.version
      });
      if (!active) return;
      setup = { sourceId, secret: rotationAttempt.secret, spreadsheetId: source.spreadsheet_id, name: source.name };
      rotationAttempt = null;
      sources = sources.map(item => (item.id || item.source_id) === sourceId ? result : item);
      drawSetup();
      drawSources();
      tell('Worker secret replaced', 'Update the secret in your private worker project. The previous secret no longer accepts submissions.');
    } catch (error) {
      if (active) tell('Replacement not confirmed', feedbackMessage(error), true);
    } finally {
      if (active) lock(false);
    }
  }

  async function setActive(source) {
    if (!active || pending) return;
    const sourceId = source.id || source.source_id;
    lock(true);
    try {
      const result = await rpc('garage_set_sheet_active', {
        p_source_id: sourceId, p_active: !source.active, p_expected_version: source.version
      });
      if (!active) return;
      sources = sources.map(item => (item.id || item.source_id) === sourceId ? result : item);
      drawSources();
      tell(result.active ? 'Imports resumed' : 'Imports paused', result.active
        ? 'The connection can accept submissions again. Its Google worker must still be configured.'
        : 'The server will reject new requests from this connection until you resume it.');
    } catch (error) {
      if (active) tell('Connection change not confirmed', feedbackMessage(error), true);
    } finally {
      if (active) lock(false);
    }
  }

  refresh();
  return {
    element: root,
    dispose() {
      active = false;
      loadVersion += 1;
      abort.abort();
      registrationAttempt = null;
      rotationAttempt = null;
      setup = null;
      sources = [];
      root.replaceChildren();
    }
  };
}
