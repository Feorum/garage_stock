const OWNER = [
  { id: 'shift', label: 'На проверке', icon: 'review' },
  { id: 'orders', label: 'Все заказы', icon: 'orders' },
  { id: 'reports', label: 'Отчёты и история', icon: 'book' },
];
const MECHANIC = [
  { id: 'shift', label: 'Заказы владельца', icon: 'B' },
  { id: 'manager-orders', label: 'Заказы менеджеров', icon: 'G' },
  { id: 'history', label: 'История', icon: 'history' },
];
const OWNER_TOOLS = {
  pay: { tab: 'reports', label: 'Распределение оплаты' },
  ledger: { tab: 'reports', label: 'Учёт бизнеса' },
  sheets: { tab: 'orders', label: 'Подключения таблиц' },
};
export function getSections(role) {
  if (role === 'admin') return OWNER;
  if (role === 'mechanic') return MECHANIC;
  return [];
}
export function resolveRoute(role, hash = '') {
  const [id, rawRecord] = hash.replace(/^#/, '').split('/');
  const sections = getSections(role);
  const tool = role === 'admin' && Object.hasOwn(OWNER_TOOLS, id) ? OWNER_TOOLS[id] : undefined;
  const legacy = role === 'mechanic' && ['assigned', 'my-work'].includes(id);
  const match = sections.find(item => item.id === (tool?.tab || id));
  const section = match || sections[0];
  const record = (match || legacy) && /^[A-Za-z0-9_-]{1,100}$/.test(rawRecord || '') ? rawRecord : undefined;
  const routeId = (tool || legacy) ? id : section?.id;
  return { section, id: routeId, record, label: tool?.label || section?.label };
}
export function resolveSection(role, hash = '') { return resolveRoute(role, hash).section; }
