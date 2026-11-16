import { element, renderNotice } from './ui.js';
import { ledgerButton, ledgerFailure, ledgerValue } from './ledger-shared.js';

export function createLedgerHistory({ row, rpc, save, close }) {
  let active = true;
  const list = element('div', {}, element('p', { role: 'status', class: 'muted' }, 'Loading record history…'));
  const reason = element('textarea', { id: 'ledger-history-reason', rows: '2', maxlength: '2000', required: true });
  const feedback = element('div', { 'aria-live': 'polite' });
  const form = element('form', { class: 'ledger-form ledger-history', onsubmit: event => event.preventDefault() },
    element('h3', {}, 'Record history and recovery'),
    element('p', { class: 'ledger-notice' }, 'The imported source stays intact. Restoring a version creates another recorded change.'), list,
    element('div', { class: 'ledger-reason' }, element('label', { for: reason.id }, 'Reason for archive or restore'), reason), feedback,
    element('div', { class: 'button-row' }, row.archived ? null : ledgerButton('Archive entry', async () => {
      if (!form.reportValidity()) return;
      const saved = await save('garage_ledger_save_row', { p_row_id: row.id, p_expected_version: row.version,
        p_cells: row.cells, p_section: row.section, p_archived: true, p_reason: reason.value.trim() });
      if (saved && active) close();
    }), ledgerButton('Close history', close)));
  async function load() {
    list.replaceChildren(element('p', { role: 'status', class: 'muted' }, 'Loading record history…'));
    try {
      const events = await rpc('garage_ledger_history', { p_row_id: row.id });
      if (!active) return;
      if (!Array.isArray(events)) throw new Error('Invalid history');
      list.replaceChildren(element('ol', {}, events.map(event => element('li', {},
        element('strong', {}, event.action === 'import' ? 'Original workbook record' : `Revision ${event.version} · ${String(event.action).replaceAll('_', ' ')}`),
        element('p', {}, event.reason || 'Imported source snapshot'),
        element('small', {}, [event.actor_name || 'Source', event.created_at ? new Date(event.created_at).toLocaleString() : ''].filter(Boolean).join(' · ')),
        element('details', { class: 'ledger-source-detail' }, element('summary', {}, 'Values in this version'),
          element('dl', { class: 'ledger-values' }, Object.entries(event.after_state?.cells || {}).map(([column, cell]) =>
            element('div', {}, element('dt', {}, column), element('dd', {}, ledgerValue(cell.value)),
              cell.formula ? element('p', { class: 'ledger-cell-note' }, cell.override ? 'Manual override · ' : 'Source formula · ', element('code', {}, cell.formula)) : null)))),
        ledgerButton('Restore this version', async () => {
          if (!form.reportValidity()) return;
          const saved = await save('garage_ledger_restore', { p_row_id: row.id, p_revision_id: String(event.id),
            p_expected_version: row.version, p_reason: reason.value.trim() });
          if (saved && active) close();
        })))));
    } catch (error) {
      if (active) list.replaceChildren(renderNotice('History unavailable', ledgerFailure(error), 'error'), ledgerButton('Retry history', load));
    }
  }
  load();
  return { element: form, dispose() { active = false; } };
}
