import { element, renderNotice } from './ui.js';

export const STATUS_LABELS = {
  pending: 'Pending', in_progress: 'In progress', blocked: 'Blocked',
  completed: 'Completed', cancelled: 'Cancelled', published: 'Open', closed: 'Closed'
};
export const TERMINAL_TASKS = new Set(['completed', 'cancelled']);
export const PROTECTED_TASKS = new Set(['in_progress', 'blocked', 'completed']);
export const HOOD_WORKS = new Set(['W01', 'W03', 'W04']);

export function field(label, control, hint = '') {
  return element('div', { class: 'order-field' }, element('label', { for: control.id }, label), control,
    hint ? element('p', { class: 'field-hint' }, hint) : null);
}

export function statusBadge(status) {
  return element('span', { class: `task-status status-${status}` }, STATUS_LABELS[status] || status);
}

export function displayDate(value) {
  if (!value) return '';
  const parts = String(value).slice(0, 10).split('-');
  return parts.length === 3 ? parts.reverse().join('.') : String(value);
}

export function actionError(error, creating = false) {
  if (['PGRST202', '42883', '42P01'].includes(error?.code)) return 'The order workspace is not available yet. Ask the Owner to finish setup, then retry.';
  if (error?.code === '42501') return 'Your account cannot perform this action. Refresh to check your current access.';
  if (error?.code === '40001' || /version|changed|conflict|already|no longer/i.test(error?.message || '')) return 'This work has changed. Refresh and check its latest state before trying again.';
  if (!error?.code || /fetch|network|timeout/i.test(error?.message || '')) return 'We couldn’t confirm the change. Check your connection and refresh before retrying.';
  return creating
    ? 'The order could not be sent. Check its vehicle, selected works and mechanic assignment, then retry.'
    : 'The change could not be saved. Refresh to check the latest task state, then retry.';
}

export function button(text, handler, className = 'button button-small') {
  return element('button', { type: 'button', class: className, 'data-order-action': '', onclick: handler }, text);
}

export function managerReference(intake) {
  if (!intake) return null;
  function snapshot(title, value) {
    if (!value) return null;
    return element('section', {}, element('h4', {}, title), element('dl', { class: 'manager-reference-fields' },
      ...[['Date', 'date'], ['Manager', 'manager_label'], ['Vehicle', 'vehicle'], ['VIN', 'vin'], ['Colour', 'colour'],
        ['Wrapping request', 'wrapping'], ['Tint request', 'tint'], ['Table completion', 'completion'], ['Manager notes', 'notes']].map(([label, key]) => {
        const raw = value[key] == null ? '' : String(value[key]);
        const display = key === 'completion' && /^(true|false)$/i.test(raw)
          ? `${raw.toLowerCase() === 'true' ? 'Marked completed' : 'Not marked completed'} (${raw.toUpperCase()})` : raw || '—';
        return element('div', {}, element('dt', {}, label), element('dd', {}, display));
      })));
  }
  const originals = Array.isArray(intake.original_observations) && intake.original_observations.length
    ? intake.original_observations : [{ raw: intake.original }];
  const latest = Array.isArray(intake.observations) && intake.observations.length ? intake.observations : [{ raw: intake.latest }];
  return element('details', { class: 'manager-reference' }, element('summary', {}, 'Original Manager request · Owner only'),
    ...originals.map(item => snapshot(`Original table text${item.row_number ? ` · Row ${item.row_number}` : ''}`, item.raw)),
    ...(intake.source_changed ? latest.map(item => snapshot(`Latest table text${item.row_number ? ` · Row ${item.row_number}` : ''}`, item.raw)) : []));
}

export function financialSummary(values, preview = false) {
  if (!values || values.status !== 'priced' || [values.net_amount, values.vat_amount, values.gross_amount].some(value => value == null || !Number.isFinite(Number(value)))) {
    return renderNotice('Owner review needed', 'One or more work amounts have not been confirmed. Unknown amounts are not counted as zero.');
  }
  const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'BYN' }).format(Number(value));
  return element('div', { class: 'financial-summary', 'aria-label': 'Owner-only amounts' },
    element('p', { class: 'eyebrow' }, preview ? 'Selected works · Owner only · BYN' : 'Recorded rates · Owner only · BYN'),
    element('p', { class: 'field-hint financial-scope' }, preview ? 'Calculated from your selected works. Recorded work keeps its saved rate.' : 'Amounts cover all uncancelled ordered work.'),
    element('dl', {}, element('div', {}, element('dt', {}, 'Excluding VAT'), element('dd', {}, money(values.net_amount))),
      element('div', {}, element('dt', {}, 'VAT'), element('dd', {}, money(values.vat_amount))),
      element('div', {}, element('dt', {}, 'Including VAT'), element('dd', {}, money(values.gross_amount)))));
}
