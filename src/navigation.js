const OWNER = [
  { id: 'orders', label: 'Заказы', icon: 'orders', description: 'Поручения владельца и заказы менеджеров в одном месте.' },
  { id: 'reports', label: 'Отчёты', icon: 'reports', description: 'Выполненные работы и результаты команды.' },
  { id: 'ledger', label: 'Учёт бизнеса', icon: 'catalogue', description: 'Данные вашей рабочей книги с редактированием, ссылками на источник и историей изменений.' },
  { id: 'sheets', label: 'Подключения таблиц', icon: 'catalogue', description: 'Настройка таблиц, из которых поступают заказы менеджеров.' }
];

const MECHANIC = [
  { id: 'assigned', label: 'Назначено владельцем', icon: 'assigned', description: 'Работы, которые владелец назначил вам.' },
  { id: 'manager-orders', label: 'Заказы менеджеров', icon: 'orders', description: 'Доступные работы из общей очереди.' },
  { id: 'my-work', label: 'Мои работы', icon: 'work', description: 'Ваши текущие и завершённые задачи.' }
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
