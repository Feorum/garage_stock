import { element, renderNotice } from './ui.js';
import { button, actionError, financialSummary } from './order-shared.js';
import { createOrderEditor } from './order-editor.js';
import { createCompletionEditor } from './order-completion.js';
import { renderOrderList } from './order-list.js';

// Every mount owns its pending requests and private responses. Navigation/logout
// must call dispose so a late response cannot restore a previous workspace.
export function mountOrders({ role, profile, section, client }) {
  const owner = role === 'admin';
  const root = element('section', { class: 'orders-workspace', 'aria-label': owner ? 'Рабочее место заказов' : 'Ваши заказы' });
  const abort = new AbortController();
  const requestIds = new Map();
  const financialViews = new Map();
  let active = true;
  let loadingVersion = 0;
  let pending = false;
  let orders = [];
  let intakes = [];
  let intakeError = false;
  let staff = [];
  let staffReady = false;
  let hasLoaded = false;
  let formOpen = false;
  let editor = null;
  const expanded = new Set();

  const feedback = element('div', { class: 'orders-feedback', 'aria-live': 'polite' });
  const intakeFeedback = element('div', { class: 'orders-feedback', 'aria-live': 'polite' });
  const list = element('div', { class: 'order-list' });
  const formArea = element('div', { hidden: true });
  const filter = element('select', { id: 'order-filter', 'aria-label': 'Статус заказа', onchange: drawOrders },
    element('option', { value: 'open' }, 'Открытые заказы'),
    element('option', { value: 'all' }, 'Все заказы'),
    element('option', { value: 'review' }, 'На проверке владельца'),
    element('option', { value: 'closed' }, 'Закрытые заказы'));
  const search = element('input', { id: 'order-search', type: 'search', placeholder: 'Автомобиль, VIN или номер заказа', 'aria-label': 'Поиск заказов', oninput: drawOrders });
  const refreshButton = button('Обновить', () => initialize(), 'button');
  const newButton = owner && section === 'orders' ? button('Новый заказ', () => {
    if (formOpen && editor?.mode === 'new') closeEditor();
    else openEditor('new');
  }, 'button button-primary') : null;
  if (newButton) {
    newButton.setAttribute('aria-expanded', 'false');
    newButton.disabled = true;
  }

  root.append(element('div', { class: 'order-toolbar' },
    element('div', { class: 'order-search-controls' }, search, owner && section === 'orders' ? filter : null),
    element('div', { class: 'button-row toolbar-buttons' }, refreshButton, newButton)), feedback, intakeFeedback, formArea, list);

  function tell(title, description, error = false) {
    if (!active) return;
    feedback.replaceChildren(renderNotice(title, description, error ? 'error' : 'info'));
  }

  function lock(value) {
    pending = value;
    root.setAttribute('aria-busy', String(value));
    for (const control of root.querySelectorAll('[data-order-action], [data-mutation-fields]')) control.disabled = value;
    if (newButton) newButton.disabled = value || !staffReady;
  }

  async function rpc(name, parameters = {}) {
    const request = client.rpc(name, parameters);
    const response = await (typeof request.abortSignal === 'function' ? request.abortSignal(abort.signal) : request);
    if (response.error) throw response.error;
    return response.data;
  }

  async function mutate(name, parameters, success, creating = false) {
    if (pending || !active) return false;
    const fingerprint = JSON.stringify([name, parameters]);
    if (!requestIds.has(fingerprint)) requestIds.set(fingerprint, crypto.randomUUID());
    lock(true);
    try {
      await rpc(name, { ...parameters, p_request_id: requestIds.get(fingerprint) });
      if (!active) return false;
      requestIds.delete(fingerprint);
      financialViews.clear();
      await refresh(false);
      tell('Сохранено', success);
      return true;
    } catch (error) {
      if (active) {
        // Keep the same request ID for an ambiguous retry of this exact action.
        await refresh(false);
        const editorConflict = ['garage_edit_order', 'garage_publish_manager_intake', 'garage_record_omitted_completion'].includes(name)
          && (error?.code === '40001' || /version|changed|conflict/i.test(error?.message || ''));
        tell(creating ? 'Заказ не подтверждён' : 'Изменение не подтверждено', editorConflict
          ? 'Заказ или заявка менеджера изменились. Ваши правки сохранены в форме. Закройте форму и снова нажмите «Изменить заказ», чтобы проверить актуальную версию.'
          : actionError(error, creating), true);
      }
      return false;
    } finally {
      if (active) lock(false);
    }
  }

  function drawOrders() {
    if (!active || !hasLoaded) return;
    renderOrderList({ owner, profile, section, orders, intakes, needle: search.value.trim().toLocaleLowerCase('ru-RU'), statusFilter: filter.value,
      list, expanded, openEditor, mutate, loadFinancials, financialViews, staff });
  }

  function closeEditor() {
    editor?.dispose(); editor = null; formOpen = false;
    formArea.replaceChildren(); formArea.hidden = true;
    newButton?.setAttribute('aria-expanded', 'false');
  }

  function openEditor(mode, record = {}) {
    if (!owner || pending || !staffReady) return;
    closeEditor();
    editor = mode === 'completion'
      ? createCompletionEditor({ record, staff, rpc, mutate, isActive: () => active, closeEditor })
      : createOrderEditor({ mode, record, intakes, staff, rpc, mutate, isActive: () => active, closeEditor });
    formOpen = true; formArea.hidden = false;
    formArea.replaceChildren(editor.element);
    newButton?.setAttribute('aria-expanded', String(mode === 'new'));
    editor.quote();
    formArea.scrollIntoView({ block: 'start', behavior: 'auto' });
    formArea.querySelector('input')?.focus({ preventScroll: true });
  }

  async function loadFinancials(order, target) {
    if (!owner || pending || !active) return;
    target.replaceChildren(element('p', { class: 'muted' }, 'Загружаем стоимость работ…'));
    try {
      const values = await rpc('garage_order_financials', { p_order_id: order.id });
      if (!active || !target.isConnected) return;
      financialViews.set(order.id, values);
      target.replaceChildren(financialSummary(values));
    } catch {
      if (active && target.isConnected) target.replaceChildren(renderNotice('Стоимость недоступна', 'Не удалось загрузить стоимость работ. Повторите попытку.', 'error'));
    }
  }

  async function refresh(showLoading = true) {
    if (!active) return;
    const version = ++loadingVersion;
    if (showLoading && !hasLoaded) list.replaceChildren(element('p', { class: 'orders-loading', role: 'status' }, 'Загружаем заказы…'));
    if (showLoading) refreshButton.disabled = true;
    try {
      const [data, draftResult] = await Promise.all([rpc('garage_list_orders'), owner && section === 'orders'
        ? rpc('garage_manager_intakes').then(data => ({ data })).catch(() => ({ error: true })) : Promise.resolve(null)]);
      if (!active || version !== loadingVersion) return;
      if (!Array.isArray(data)) throw new Error('Unexpected order response');
      const previousVersions = new Map(orders.map(order => [order.id, order.version]));
      for (const id of financialViews.keys()) {
        const updated = data.find(order => order.id === id);
        if (!updated || previousVersions.get(id) !== updated.version) financialViews.delete(id);
      }
      orders = data;
      if (draftResult) {
        intakeError = Boolean(draftResult.error) || !Array.isArray(draftResult.data);
        if (!intakeError) intakes = draftResult.data;
        intakeFeedback.replaceChildren(...(intakeError ? [renderNotice('Заявки менеджеров недоступны', 'Заказы доступны. Обновите список, чтобы загрузить заявки на проверку.', 'error')] : []));
      }
      hasLoaded = true;
      drawOrders();
      if (showLoading) feedback.replaceChildren();
    } catch (error) {
      if (!active || version !== loadingVersion) return;
      if (!hasLoaded) list.replaceChildren();
      tell('Не удалось загрузить заказы', ['PGRST202', '42883', '42P01'].includes(error?.code)
        ? 'Раздел заказов ещё не настроен. Попросите владельца завершить настройку и повторите попытку.'
        : hasLoaded ? 'Показаны последние загруженные данные. Проверьте подключение и обновите список перед изменениями.' : 'Проверьте подключение и повторите попытку. Заказы не изменены.', true);
      if (!hasLoaded) list.append(button('Повторить', () => refresh()));
    } finally {
      if (active && version === loadingVersion) refreshButton.disabled = pending;
    }
  }

  async function initialize() {
    let staffError = false;
    if (owner && section === 'orders' && !staffReady) {
      try {
        const members = await rpc('garage_staff');
        if (!active) return;
        staff = Array.isArray(members) ? members : [];
        staffReady = true;
        newButton.disabled = false;
      } catch {
        if (active) {
          newButton.disabled = true;
          staffError = true;
        }
      }
    } else if (owner && !staffReady) {
      try {
        const members = await rpc('garage_staff');
        if (!active) return;
        staff = Array.isArray(members) ? members : [];
        staffReady = true;
      } catch { /* Reports remain usable without reassignment controls. */ }
    }
    await refresh();
    if (staffError) tell('Не удалось загрузить механиков', 'Обновите список механиков перед созданием заказа.', true);
  }

  function refreshOnReturn() {
    if (!pending && !formOpen && document.visibilityState === 'visible') refresh(false);
  }
  const interval = setInterval(refreshOnReturn, 30000);
  window.addEventListener('focus', refreshOnReturn);
  document.addEventListener('visibilitychange', refreshOnReturn);
  initialize();

  return {
    element: root,
    dispose() {
      active = false;
      loadingVersion += 1;
      abort.abort();
      editor?.dispose(); editor = null;
      clearInterval(interval);
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
      orders = [];
      intakes = [];
      expanded.clear();
      staff = [];
      requestIds.clear();
      financialViews.clear();
      root.replaceChildren();
    }
  };
}
