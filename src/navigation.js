const OWNER = [
  { id: 'orders', label: 'Orders', icon: 'orders', description: 'Client assignments and manager orders in one place.' },
  { id: 'catalogue', label: 'Approved works', icon: 'catalogue', description: 'The closed work list, organized by vehicle group.' },
  { id: 'reports', label: 'Reports', icon: 'reports', description: 'A clear record of the work performed by your team.' }
];

const MECHANIC = [
  { id: 'assigned', label: 'Assigned by Owner', icon: 'assigned', description: 'Client work assigned directly to you.' },
  { id: 'manager-orders', label: 'Manager orders', icon: 'orders', description: 'Available work to choose from the shared queue.' },
  { id: 'my-work', label: 'My work', icon: 'work', description: 'Your work in progress and completed tasks.' }
];

export function getSections(role) {
  if (role === 'admin') return OWNER;
  if (role === 'mechanic') return MECHANIC;
  return [];
}

export function resolveSection(role, hash = '') {
  const sections = getSections(role);
  return sections.find(section => hash === `#${section.id}`) || sections[0];
}
