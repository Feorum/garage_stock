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
  if (['PGRST202', '42883', '42P01'].includes(error?.code)) return 'Подключения таблиц пока недоступны. Обновите страницу после завершения настройки.';
  if (error?.code === '42501') return 'У вашей учётной записи нет доступа к управлению подключением. Войдите как владелец и повторите попытку.';
  if (error?.code === '40001' || /version|changed|conflict/i.test(error?.message || '')) return 'Подключение изменилось. Обновите его настройки и повторите попытку.';
  if (error?.code === '23505' || /already registered|already exists/i.test(error?.message || '')) return 'Эта таблица уже подключена. Найдите её подключение ниже.';
  if (!error?.code || /fetch|network|timeout/i.test(error?.message || '')) return 'Не удалось подтвердить изменение. Оставьте страницу открытой и повторите то же действие.';
  return 'Не удалось обновить подключение. Проверьте название, ссылку на таблицу и идентификатор листа, затем повторите попытку.';
}

const REVIEW_MESSAGES = {
  NONSTANDARD_TASK_DETAIL: 'Дополнительные указания меняют выбранный объём или размеры работы. Владельцу нужно уточнить запрос: он не будет автоматически считаться полной оклейкой капота или полосой 25 либо 45 см.',
  UNKNOWN_WRAPPING_WORK: 'Выберите работу по оклейке из утверждённого списка.',
  UNKNOWN_TINT_WORK: 'Выберите утверждённую тонировку задней полусферы и явно укажите 5% или 15%.',
  INVALID_PLANNED_DATE: 'Укажите корректную планируемую дату.',
  INVALID_VIN: 'Укажите корректный идентификационный номер автомобиля.',
  INVALID_COMPLETION_FLAG: 'Установите или снимите отметку о выполнении в соответствующей ячейке.',
  INVALID_MANAGER: 'Сократите имя менеджера до допустимой длины.',
  INVALID_VEHICLE: 'Сократите описание автомобиля до допустимой длины.',
  FIELD_TOO_LONG: 'Сократите описание автомобиля, работы или указания до допустимой длины.',
  NO_APPROVED_TASKS: 'Выберите хотя бы одну работу из утверждённого списка.',
  WORK_UNAVAILABLE_FOR_VEHICLE: 'Эта работа недоступна для выбранной модели автомобиля.',
  SOURCE_PROGRESS_REQUIRES_REVIEW: 'В примечаниях указано, что работы могли быть выполнены. Владельцу нужно проверить их состояние.',
  CONFIDENTIAL_NOTE_REQUIRES_REVIEW: 'Примечание может содержать закрытые финансовые данные. Владельцу нужно проверить его перед передачей запроса механикам.',
  CONFLICTING_HOOD_SCOPE: 'Выберите один вариант оклейки капота для этого запроса.',
  CONFLICTING_TINT_OPTIONS: 'Выберите один процент тонировки для этого запроса.',
  MALFORMED_WORK_LIST: 'Проверьте выбранные работы и разделители в списке.',
  TASK_DETAIL_TARGET_MISSING: 'Дополнительное указание относится к работе, которая не выбрана.',
  AMBIGUOUS_TASK_DETAIL_TAG: 'Уточните, к какой выбранной работе относится дополнительное указание.',
  INVALID_TASK_DETAIL_TAG: 'Укажите корректную ссылку на утверждённую работу для дополнительного указания.',
  DUPLICATE_TASK_DETAIL_TAG: 'Объедините дополнительные указания к одной работе в одну запись.',
  EMPTY_TASK_DETAIL: 'Добавьте текст указания к выбранной работе или удалите пустую ссылку.',
  TASK_DETAIL_TOO_LONG: 'Сократите дополнительное указание к работе.',
  SOURCE_IDENTITY_CHANGED: 'Данные о визите автомобиля изменились или неоднозначны. Владельцу нужно проверить их.',
  COMPLETED_HISTORY_REOPENED: 'Этот визит уже завершён в исходной истории. Перед созданием новых работ его должен проверить владелец.',
  SOURCE_MARKED_COMPLETED: 'В исходной таблице импортированный визит отмечен как завершённый. Владельцу нужно сверить его с приложением: отметка в таблице не завершает задачи в приложении.',
  DUPLICATE_SOURCE_IDENTITY: 'Несколько строк описывают один визит автомобиля. Владельцу нужно сверить их.',
  DUPLICATE_SOURCE_KEY: 'Несколько строк описывают один визит автомобиля. Владельцу нужно сверить их.',
  DELIVERY_PENDING: 'Ожидается подтверждение передачи. Повторная попытка будет выполнена автоматически.',

  invalid_or_missing_vin: 'Укажите корректный идентификационный номер автомобиля.',
  date_missing_or_ambiguous: 'Уточните планируемую дату.',
  missing_vehicle_group: 'Выберите модель автомобиля из утверждённого списка.',
  unknown_vehicle_group: 'Выберите модель автомобиля из утверждённого списка.',
  ambiguous_atlas_group: 'Выберите точную модель автомобиля из утверждённого списка.',
  model_alias_requires_confirmation: 'Уточните модель автомобиля по утверждённому списку.',
  unapproved_finish_variant: 'Запрошенный вариант плёнки должен проверить владелец.',
  unrecognized_scope_fragment: 'Уточните запрошенную работу по утверждённому списку.',
  work_alias_requires_confirmation: 'Уточните запрошенную работу по утверждённому списку.',
  unsupported_hood_width: 'Выберите утверждённый вариант оклейки капота.',
  unsupported_tint_percentage: 'Выберите утверждённый процент тонировки: 5% или 15%.',
  tint_percentage_required: 'Выберите процент тонировки: 5% или 15%.',
  tint_scope_requires_confirmation: 'Уточните вариант тонировки по утверждённому списку.',
  unavailable_work: 'Эта работа недоступна для выбранной модели автомобиля.',
  work_unavailable_for_model: 'Эта работа недоступна для выбранной модели автомобиля.',
  partial_completion_in_notes: 'В примечаниях указано, что работы могли быть выполнены. Проверьте их вместе с владельцем.',
  partial_work_in_notes: 'В примечаниях указано, что работы могли быть выполнены. Проверьте их вместе с владельцем.',
  duplicate_source_identity: 'Несколько строк описывают один визит автомобиля. Владельцу нужно сверить их.',
  ambiguous_source_identity: 'Данные о визите автомобиля изменились или неоднозначны. Владельцу нужно проверить их.',
  missing_requested_work: 'Выберите хотя бы одну работу из утверждённого списка.',
  no_tasks: 'Выберите хотя бы одну работу из утверждённого списка.',
  formula_or_error_in_input: 'Замените формулу или ошибку в данных заказа корректным выбором.',
  ORDER_CHANGED: 'Заказ изменился в приложении. Владельцу нужно проверить запрошенное изменение.',
  ORDER_CLOSED: 'Заказ закрыт в приложении. Владельцу нужно проверить эту строку.',
  VALIDATION_FAILED: 'Проверьте модель автомобиля и выбранные работы из утверждённого списка.',
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
  const root = element('section', { class: 'sheets-workspace', 'aria-label': 'Подключения таблиц' });
  const abort = new AbortController();
  let active = true, pending = false, loadVersion = 0, reviewVersion = 0, sources = [];
  let setup = null, readerAttempt = null;
  const feedback = element('div', { class: 'sheets-feedback', 'aria-live': 'polite' });
  const sourceList = element('div', { class: 'sheet-source-list' });
  const setupArea = element('div', { class: 'sheet-setup-area' });
  const reviewArea = element('div', { class: 'sheet-review-area sheet-source-list', 'aria-live': 'polite' });
  const sourceName = element('input', { id: 'sheet-name', type: 'text', required: true, maxlength: '120', autocomplete: 'off', placeholder: 'Рабочая копия заказов менеджеров' });
  const spreadsheet = element('input', { id: 'sheet-url', type: 'text', required: true, autocomplete: 'off', spellcheck: 'false', placeholder: 'Вставьте ссылку на существующий лист заказов' });
  const tab = element('input', { id: 'sheet-tab', type: 'text', inputmode: 'numeric', required: true, pattern: '[0-9]{1,10}', autocomplete: 'off', placeholder: 'Номер листа из ссылки' });
  spreadsheet.addEventListener('input', () => { const gid = parseSheetGid(spreadsheet.value); if (gid !== null) { tab.value = String(gid); tab.setCustomValidity(''); } });
  const connect = actionButton('Подключить рабочую копию', () => {}, 'button button-primary');
  connect.type = 'submit';
  const connectionFields = element('fieldset', { class: 'sheet-registration-fields' },
    element('legend', {}, 'Подключение рабочей копии'),
    element('div', { class: 'form-grid' }, field('Название подключения', sourceName), field('Ссылка или идентификатор таблицы', spreadsheet), field('Идентификатор листа заказов', tab)),
    element('p', { class: 'field-hint' }, 'Используйте полную рабочую копию существующей таблицы менеджеров. При вставке ссылки идентификатор листа заполнится автоматически. Исходная таблица не подключается и не изменяется.'),
    element('div', { class: 'button-row form-actions' }, connect));
  const form = element('form', { class: 'sheet-registration', onsubmit: connectSource }, connectionFields);
  const refreshButton = actionButton('Обновить состояние', () => refresh(), 'button');
  root.append(element('div', { class: 'sheet-introduction' },
    element('p', {}, 'Подключение загружает запросы менеджеров и записывает выполненные работы и имена механиков в ту же рабочую копию.'),
    element('p', { class: 'muted' }, 'Исходная таблица не изменяется. Менеджеры выбирают работы из каталога и вводят дополнительные комментарии в столбце «Оклейка» (G). Приложение обновляет столбцы «Статус» (I) и «Примечания» (J). Неясные запросы ждут проверки владельца. Менеджерам не нужны учётная запись в приложении или отдельная отправка запроса.')),
    feedback, setupArea, form, element('div', { class: 'sheet-list-heading' }, element('h2', {}, 'Подключённые таблицы'), refreshButton), sourceList, reviewArea);

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
  function formatTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Недоступно' : date.toLocaleString('ru-RU'); }
  function drawSources() {
    if (!active) return;
    if (!sources.length) {
      sourceList.replaceChildren(element('div', { class: 'empty-state' }, element('h2', {}, 'Рабочая копия не подключена'), element('p', {}, 'Подключите полную рабочую копию в существующем формате таблицы менеджеров.')));
      return;
    }
    sourceList.replaceChildren(...sources.map(source => {
      const url = connectionUrl(source), checked = Boolean(source.last_success_at), failed = Boolean(source.last_error_code);
      const status = !source.active ? 'Импорт приостановлен' : failed ? 'Требуется проверка' : checked ? 'Синхронизация выполнена' : source.reader_only ? 'Ожидается настройка загрузчика' : 'Ожидается первая синхронизация';
      const detail = !source.active ? 'Импорт новых данных из таблицы приостановлен. Существующие заказы доступны в приложении.'
        : failed ? 'Последняя проверка не завершена. Сервер повторит попытку; существующие заказы сохранены.'
          : checked ? `Последняя успешная проверка: ${formatTime(source.last_success_at)}` : source.reader_only ? 'Подключено. Настройте закрытый загрузчик Google один раз; копия останется закрытой.' : 'Подключено. Ожидается плановая проверка сервером.';
      const count = Number(source.review_count) || 0;
      const settling = Number(source.summary?.awaiting_stability) || 0;
      const feedbackConfirmed = source.summary?.feedback_confirmed, feedbackPending = source.summary?.feedback_pending;
      const hasFeedbackStatus = Number.isSafeInteger(feedbackConfirmed) && feedbackConfirmed >= 0
        && Number.isSafeInteger(feedbackPending) && feedbackPending >= 0;
      return element('article', { class: 'sheet-source-card', 'data-source-id': source.id || source.source_id },
        element('div', { class: 'sheet-source-heading' }, element('h3', {}, source.name), element('span', { class: 'tag tag-neutral' }, status)),
        element('p', { class: 'sheet-source-detail' }, detail),
        element('p', { class: 'sheet-source-detail' }, count ? `Строк на проверке у владельца: ${count}.` : checked ? 'Сейчас нет строк, ожидающих проверки.' : 'Результаты проверки появятся после первого успешного чтения.'),
        settling ? element('p', { class: 'sheet-source-detail' }, `Ожидают повторного чтения: ${settling}. Перед публикацией данные должны остаться неизменными при двух чтениях с интервалом не менее минуты.`) : null,
        hasFeedbackStatus ? element('p', { class: 'sheet-source-detail' }, `Результаты выполнения: подтверждено ${feedbackConfirmed} · ожидает ${feedbackPending}.`) : null,
        element('div', { class: 'sheet-source-actions' },
          url ? element('a', { class: 'button button-small', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть рабочую копию') : null,
          actionButton(source.active ? 'Приостановить импорт' : 'Возобновить импорт', () => setActive(source)), actionButton('Проверить строки', () => showReviews(source)),
          actionButton('Настроить закрытый загрузчик', () => prepareReader(source))),
        element('p', { class: 'field-hint' }, 'Работы выбираются из утверждённого каталога. Цены хранятся отдельно в учётной записи владельца.'));
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
      const labels = { SPREADSHEET_ID: 'Идентификатор таблицы', SHEET_GID: 'Идентификатор листа',
        INTEGRATION_ID: 'Идентификатор подключения', INTEGRATION_SECRET: 'Секретный ключ', API_URL: 'Адрес сервера' };
      const wrap = field(labels[key], input);
      if (key === 'INTEGRATION_SECRET') wrap.append(actionButton('Показать ключ', event => {
        const reveal = input.type === 'password'; input.type = reveal ? 'text' : 'password';
        event.currentTarget.textContent = reveal ? 'Скрыть ключ' : 'Показать ключ';
      }));
      return wrap;
    });
    setupArea.replaceChildren(element('section', { class: 'sheet-setup', 'aria-label': 'Настройка закрытого загрузчика' },
      element('div', { class: 'sheet-source-heading' }, element('h2', {}, 'Настройка закрытого загрузчика'), element('span', { class: 'tag' }, 'Только владелец')),
      element('p', {}, 'Закрытое подключение читает настроенную рабочую копию и записывает результаты выполнения только в её столбцы «Статус» (I) и «Примечания» (J). Исходная таблица не изменяется, а копия остаётся закрытой.'),
      element('p', { class: 'field-hint' }, 'Google запрашивает разрешение на редактирование таблиц. Скрипт ограничивает изменения настроенной рабочей копией. Если загрузчик ранее работал только на чтение, обновите его и повторно предоставьте разрешение для записи результатов выполнения.'),
      element('ol', { class: 'sheet-setup-steps' },
        element('li', {}, 'Создайте отдельный проект скрипта Google, доступный для редактирования только вам.'),
        element('li', {}, 'Скопируйте файлы Code.gs, Feedback.gs и манифест из инструкции, затем добавьте функцию настройки ниже.'),
        element('li', {}, 'Один раз запустите функцию setupConnection и завершите авторизацию Google, включая разрешение на редактирование таблиц. Она настроит ежеминутную загрузку запросов и запись результатов выполнения.'),
        element('li', {}, 'После настройки удалите временную функцию setupConnection. Сохраняйте проект загрузчика закрытым.')),
      element('div', { class: 'sheet-setup-links' }, element('a', { href: READER_GUIDE, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть код загрузчика и инструкцию')),
      element('div', { class: 'sheet-setup-properties' }, ...fields),
      element('p', { class: 'field-hint' }, 'Скопируйте настройки сейчас: позже получить ключ будет невозможно. Не размещайте его в общей таблице. Создание нового ключа загрузчика отключает предыдущий.'),
      element('div', { class: 'button-row form-actions' }, actionButton('Скопировать функцию настройки', copySetup, 'button button-primary'),
        actionButton('Скрыть данные подключения', () => { setup = null; setupArea.replaceChildren(); }))));
  }
  async function copySetup() {
    if (!active || !setup) return;
    const text = `function setupConnection() {\n  PropertiesService.getScriptProperties().setProperties(${JSON.stringify(readerProperties(), null, 2)});\n  install();\n}\n`;
    try {
      await navigator.clipboard.writeText(text);
      if (active) tell('Скопировано', 'Вставляйте функцию только в свой закрытый проект загрузчика. Она содержит ключ подключения.');
    } catch { if (active) tell('Копирование недоступно', 'Скопируйте показанные настройки или разрешите доступ к буферу обмена в браузере.', true); }
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
      tell('Настройки закрытого загрузчика готовы', 'Завершите настройку Google ниже. Синхронизация будет подтверждена только после успешного чтения данных.');
    } catch (error) { if (active) tell('Настройка загрузчика не подтверждена', feedbackMessage(error), true); }
    finally { if (active) lock(false); }
  }
  async function refresh({ preserveFeedback = false } = {}) {
    if (!active || pending) return;
    const request = ++loadVersion;
    refreshButton.disabled = true;
    sourceList.setAttribute('aria-busy', 'true');
    if (!sources.length) sourceList.replaceChildren(element('p', { class: 'orders-loading' }, 'Загрузка подключений таблиц…'));
    try {
      const result = await rpc('garage_sheet_pull_sources');
      if (!active || request !== loadVersion) return;
      sources = Array.isArray(result) ? result : [];
      drawSources();
      if (!preserveFeedback) feedback.replaceChildren();
    } catch (error) {
      if (active && request === loadVersion) { sourceList.replaceChildren(); tell('Подключения недоступны', feedbackMessage(error), true); }
    } finally {
      if (active && request === loadVersion) { refreshButton.disabled = false; sourceList.removeAttribute('aria-busy'); }
    }
  }
  async function connectSource(event) {
    event.preventDefault();
    if (!active || pending) return;
    const name = sourceName.value.trim(), spreadsheetId = parseSpreadsheetId(spreadsheet.value), gid = tab.value.trim();
    if (!name || !spreadsheetId || !TAB_ID.test(gid) || Number(gid) > 2147483647) {
      tell('Проверьте подключение', 'Укажите название, корректную ссылку или идентификатор таблицы Google и идентификатор листа заказов.', true); return;
    }
    lock(true);
    try {
      const result = await rpc('garage_connect_sheet_pull', { p_name: name, p_spreadsheet_id: spreadsheetId, p_sheet_gid: Number(gid) });
      if (!active) return;
      sourceName.value = ''; spreadsheet.value = ''; tab.value = '';
      sources = [result, ...sources.filter(source => (source.id || source.source_id) !== (result.id || result.source_id))];
      drawSources();
      tell('Рабочая копия подключена', 'Завершите настройку закрытого загрузчика для начала импорта. Исходная таблица не подключена.');
    } catch (error) { if (active) tell('Подключение не подтверждено', feedbackMessage(error), true); }
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
      tell(result.active ? 'Импорт возобновлён' : 'Импорт приостановлен', result.active ? 'Настроенный загрузчик снова проверяет рабочую копию по расписанию.' : 'Загрузка новых запросов из таблицы приостановлена. Существующие заказы остаются в приложении.');
    } catch (error) { if (active) tell('Изменение подключения не подтверждено', feedbackMessage(error), true); }
    finally { if (active) lock(false); }
  }
  async function showReviews(source) {
    if (!active || pending) return;
    const request = ++reviewVersion;
    reviewArea.replaceChildren(element('p', { class: 'orders-loading' }, 'Загрузка строк для проверки владельцем…'));
    try {
      const result = await rpc('garage_sheet_pull_reviews', { p_source_id: source.id || source.source_id });
      if (!active || request !== reviewVersion) return;
      const rows = Array.isArray(result) ? result : [];
      const cards = rows.map(row => {
        const url = connectionUrl(source, row.row_number), reasons = Array.isArray(row.reason_codes) ? row.reason_codes : [];
        const messages = [...new Set(reasons.map(code => REVIEW_MESSAGES[code] || REVIEW_MESSAGES[String(code).toLowerCase()] || 'Перед импортом эту строку должен проверить владелец.'))];
        return element('article', { class: 'sheet-source-card' },
          element('h3', {}, `Строка ${Number.isSafeInteger(Number(row.row_number)) ? Number(row.row_number) : '—'}${row.vehicle ? ` · ${String(row.vehicle)}` : ''}`),
          row.planned_date ? element('p', { class: 'sheet-source-detail' }, `Планируемая дата: ${String(row.planned_date)}`) : null,
          element('ul', { class: 'sheet-setup-steps' }, ...messages.map(message => element('li', {}, message))),
          url ? element('a', { class: 'button button-small', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть исходную строку') : null);
      });
      reviewArea.replaceChildren(
        element('div', { class: 'sheet-list-heading' }, element('h2', {}, 'Строки для проверки владельцем'), actionButton('Закрыть проверку', () => { reviewVersion += 1; reviewArea.replaceChildren(); })),
        element('p', { class: 'sheet-source-detail' }, rows.length ? 'Уточните неоднозначные данные автомобиля или выбранные работы в рабочей копии. При следующей проверке загрузчик повторит попытку. Изменения уже начатых работ должен сверить владелец.' : 'Сейчас нет строк, ожидающих проверки.'), ...cards);
    } catch (error) {
      if (active && request === reviewVersion) reviewArea.replaceChildren(renderNotice('Проверка недоступна', feedbackMessage(error), 'error'));
    }
  }
  refresh();
  return { element: root, dispose() { active = false; loadVersion += 1; reviewVersion += 1; abort.abort(); sources = []; setup = null; readerAttempt = null; root.replaceChildren(); } };
}
