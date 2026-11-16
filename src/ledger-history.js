import { element, renderNotice } from './ui.js';
import { ledgerButton, ledgerFailure, ledgerValue } from './ledger-shared.js';

export function createLedgerHistory({ row, rpc, save, close }) {
  let active = true;
  const list = element('div', {}, element('p', { role: 'status', class: 'muted' }, 'Загрузка истории записи…'));
  const reason = element('textarea', { id: 'ledger-history-reason', rows: '2', maxlength: '2000', required: true });
  const feedback = element('div', { 'aria-live': 'polite' });
  const form = element('form', { class: 'ledger-form ledger-history', onsubmit: event => event.preventDefault() },
    element('h3', {}, 'История и восстановление записи'),
    element('p', { class: 'ledger-notice' }, 'Импортированный источник остаётся неизменным. Восстановление версии сохраняется как новое изменение.'), list,
    element('div', { class: 'ledger-reason' }, element('label', { for: reason.id }, 'Причина архивации или восстановления'), reason), feedback,
    element('div', { class: 'button-row' }, row.archived ? null : ledgerButton('В архив', async () => {
      if (!form.reportValidity()) return;
      const saved = await save('garage_ledger_save_row', { p_row_id: row.id, p_expected_version: row.version,
        p_cells: row.cells, p_section: row.section, p_archived: true, p_reason: reason.value.trim() });
      if (saved && active) close();
    }), ledgerButton('Закрыть историю', close)));
  async function load() {
    list.replaceChildren(element('p', { role: 'status', class: 'muted' }, 'Загрузка истории записи…'));
    try {
      const events = await rpc('garage_ledger_history', { p_row_id: row.id });
      if (!active) return;
      if (!Array.isArray(events)) throw new Error('Invalid history');
      list.replaceChildren(element('ol', {}, events.map(event => element('li', {},
        element('strong', {}, event.action === 'import' ? 'Исходная запись книги'
          : `Версия ${event.version} · ${({ add: 'создание', edit: 'изменение', save: 'сохранение', create: 'создание', update: 'изменение', archive: 'архивация', restore: 'восстановление' })[event.action] || 'изменение'}`),
        element('p', {}, event.action === 'import' ? 'Исходный снимок книги'
          : ({ 'Added a ledger row': 'Добавлена запись журнала', 'Archived a ledger row': 'Запись перенесена в архив', 'Edited ledger inputs': 'Изменены значения записи' })[event.reason] || event.reason || 'Причина не указана'),
        element('small', {}, [event.action === 'import' ? 'Источник' : event.actor_name || 'Источник', event.created_at ? new Date(event.created_at).toLocaleString('ru-RU') : ''].filter(Boolean).join(' · ')),
        element('details', { class: 'ledger-source-detail' }, element('summary', {}, 'Значения в этой версии'),
          element('dl', { class: 'ledger-values' }, Object.entries(event.after_state?.cells || {}).map(([column, cell]) =>
            element('div', {}, element('dt', {}, column), element('dd', {}, ledgerValue(cell.value, cell.type)),
              cell.formula ? element('p', { class: 'ledger-cell-note' }, cell.override ? 'Значение задано вручную · ' : 'Исходная формула · ', element('code', {}, cell.formula)) : null)))),
        ledgerButton('Восстановить эту версию', async () => {
          if (!form.reportValidity()) return;
          const saved = await save('garage_ledger_restore', { p_row_id: row.id, p_revision_id: String(event.id),
            p_expected_version: row.version, p_reason: reason.value.trim() });
          if (saved && active) close();
        })))));
    } catch (error) {
      if (active) list.replaceChildren(renderNotice('История недоступна', ledgerFailure(error), 'error'), ledgerButton('Повторить загрузку истории', load));
    }
  }
  load();
  return { element: form, dispose() { active = false; } };
}
