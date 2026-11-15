import { element } from './ui.js';
import { getSections } from './navigation.js';
import { mountOrders } from './orders.js';
import { mountSheets } from './sheets.js';

export function createSectionView(role, section, profile, client) {
  // A hash is navigation input, never authority to render another role's section.
  if (!getSections(role).some(item => item.id === section)) return { element: element('div'), dispose() {} };
  if (!profile || !client) {
    return { element: element('p', { class: 'muted' }, 'Sign in to load your vehicle orders.'), dispose() {} };
  }
  if (role === 'admin' && section === 'sheets') return mountSheets({ profile, client });
  return mountOrders({ role, profile, section, client });
}

export function renderSection(role, section, profile, client) {
  return createSectionView(role, section, profile, client).element;
}
