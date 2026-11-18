const OWNER = [
  { id: 'shift', label: 'Смена', icon: 'work' },
  { id: 'orders', label: 'Заказы', icon: 'orders' },
  { id: 'reports', label: 'Отчёты', icon: 'reports' },
  { id: 'pay', label: 'Распределение оплаты', icon: 'reports' },
  { id: 'ledger', label: 'Учёт бизнеса', icon: 'catalogue' },
  { id: 'sheets', label: 'Подключения таблиц', icon: 'catalogue' }
];
const MECHANIC = [
  { id: 'shift', label: 'Моя смена', icon: 'work' },
  { id: 'manager-orders', label: 'Общая очередь', icon: 'orders' },
  { id: 'history', label: 'История', icon: 'reports' }
];
export function getSections(role) {
  if (role === 'admin') return OWNER;
  if (role === 'mechanic') return MECHANIC;
  return [];
}
export function resolveRoute(role, hash = '') {
  const [id, record] = hash.replace(/^#/, '').split('/');
  const legacy = role === 'mechanic' && ['assigned', 'my-work'].includes(id);
  const sections = getSections(role);
  const section = sections.find(item => item.id === id) || sections[0];
  return { section, id: legacy ? id : section?.id, record: (legacy || section?.id === id) && record && /^[A-Za-z0-9_-]{1,100}$/.test(record) ? record : undefined };
}
export function resolveSection(role, hash = '') { return resolveRoute(role, hash).section; }
