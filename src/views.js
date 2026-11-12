import { element, icon } from './ui.js';
import { getSections } from './navigation.js';
import { WORKS, VEHICLE_GROUPS, AVAILABLE_WORKS } from './catalogue.js';

function plannedSection(title, description, name) {
  return element('section', { class: 'empty-state', 'aria-label': title },
    element('span', { class: 'empty-icon' }, icon(name)),
    element('span', { class: 'tag tag-neutral' }, 'Coming next'),
    element('h2', {}, title), element('p', {}, description));
}

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

export function renderSection(role, section) {
  // A hash is navigation input, never authority to render another role's section.
  if (!getSections(role).some(item => item.id === section)) return element('div');
  if (role === 'admin') {
    if (section === 'catalogue') return catalogueView();
    if (section === 'reports') return plannedSection('Work reports are coming next', 'Completed work and order progress will appear here as your team starts using orders.', 'reports');
    return element('div', {},
      element('div', { class: 'flow-cards' },
        element('article', { class: 'flow-card' }, icon('assigned'), element('span', { class: 'eyebrow' }, 'Owner orders'), element('h2', {}, 'Assign client work'), element('p', {}, 'Send vehicle tasks directly to a specific mechanic.')),
        element('article', { class: 'flow-card' }, icon('orders'), element('span', { class: 'eyebrow' }, 'Manager orders'), element('h2', {}, 'A shared work queue'), element('p', {}, 'Mechanics choose available tasks submitted by managers.'))),
      plannedSection('Your order board is coming next', 'Creating, assigning and following vehicle orders will be the next step. This workspace does not show live orders yet.', 'orders'));
  }
  if (section === 'manager-orders') return plannedSection('Manager orders will appear here', 'Once the shared queue is ready, choose a vehicle and start one of its available ordered tasks.', 'orders');
  if (section === 'my-work') return plannedSection('Your work will appear here', 'Started tasks, blockers and completed work from both order sources will stay together here.', 'work');
  return plannedSection('Owner assignments will appear here', 'Tasks sent directly to you will stay in this list until completed or reassigned by the Owner.', 'assigned');
}
