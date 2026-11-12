import { element } from './ui.js';
import { getSections } from './navigation.js';
import { WORKS, VEHICLE_GROUPS, AVAILABLE_WORKS } from './catalogue.js';
import { mountOrders } from './orders.js';
import { mountSheets } from './sheets.js';

function catalogueView() {
  const rows = element('tbody');
  const count = element('p', { class: 'catalogue-count', role: 'status' });
  const select = element('select', { id: 'vehicle-group', name: 'vehicle-group', onchange: update },
    element('option', { value: '' }, 'All vehicle groups'),
    VEHICLE_GROUPS.map(group => element('option', { value: group.code }, group.name)));

  function update() {
    const available = select.value ? new Set(AVAILABLE_WORKS[select.value]) : null;
    const total = available ? available.size : WORKS.length;
    count.textContent = available ? `${total} of ${WORKS.length} works available for this group` : `${WORKS.length} approved works · ${VEHICLE_GROUPS.length} vehicle groups`;
    rows.replaceChildren(...WORKS.map(work => {
      const allowed = !available || available.has(work.code);
      return element('tr', { class: allowed ? '' : 'unavailable', 'data-work-code': work.code },
        element('td', { class: 'work-code' }, work.code),
        element('td', { lang: 'ru' }, work.name),
        element('td', {}, element('span', { class: `availability ${allowed ? '' : 'availability-muted'}` }, available ? allowed ? 'Available' : 'Unavailable' : 'Varies by vehicle')));
    }));
  }
  update();

  return element('section', { class: 'catalogue', 'aria-label': 'Closed work catalogue' },
    element('div', { class: 'catalogue-toolbar' },
      element('div', {}, element('label', { for: 'vehicle-group' }, 'Vehicle group'), select),
      element('span', { class: 'tag tag-neutral' }, 'Read only')),
    count,
    element('div', { class: 'table-scroll' }, element('table', {},
      element('caption', { class: 'sr-only' }, 'Approved work list and vehicle availability'),
      element('thead', {}, element('tr', {}, element('th', { scope: 'col' }, 'Code'), element('th', { scope: 'col' }, 'Work'), element('th', { scope: 'col' }, 'Availability'))), rows)),
    element('p', { class: 'catalogue-footnote' }, 'Only these works can be included in an order. Unavailable combinations remain excluded until clarified.'));
}

export function createSectionView(role, section, profile, client) {
  // A hash is navigation input, never authority to render another role's section.
  if (!getSections(role).some(item => item.id === section)) return { element: element('div'), dispose() {} };
  if (role === 'admin' && section === 'catalogue') return { element: catalogueView(), dispose() {} };
  if (!profile || !client) {
    return { element: element('p', { class: 'muted' }, 'Sign in to load your vehicle orders.'), dispose() {} };
  }
  if (role === 'admin' && section === 'sheets') return mountSheets({ profile, client });
  return mountOrders({ role, profile, section, client });
}

export function renderSection(role, section, profile, client) {
  return createSectionView(role, section, profile, client).element;
}
