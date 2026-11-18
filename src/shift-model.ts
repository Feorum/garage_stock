import { workshopDay } from './workspace-types';

export type ParticipantStatus = 'assigned' | 'working' | 'blocked' | 'confirmed';
export interface Participant {
  mechanic_id: string;
  name: string;
  color?: string | null;
  status: ParticipantStatus;
  confirmed_at?: string;
  confirmation_origin?: 'mechanic' | 'historical' | 'owner_recorded';
  blocker_reason?: string;
}
export interface TaskNote {
  id: string;
  mechanic_id: string;
  name: string;
  note: string;
  created_at: string;
  action: string;
}
export interface Task {
  id: string;
  work_name: string;
  work_code?: string;
  options?: { tint_percent?: number };
  status: string;
  version: number;
  instructions?: string;
  blocker_reason?: string;
  completed_at?: string;
  assigned_to?: string;
  assigned_name?: string;
  working_mechanic_id?: string;
  working_name?: string;
  participants?: Participant[];
  my_status?: ParticipantStatus | null;
  can_see_notes?: boolean;
  roster_locked?: boolean;
  notes?: TaskNote[];
}
export type VehicleState = 'available' | 'active' | 'review' | 'closed' | 'cancelled';
export type HandoffTask = Pick<Task, 'id' | 'work_name' | 'work_code' | 'options' | 'status'>;
export interface VehicleWorkflow {
  state: VehicleState;
  origin?: 'explicit' | 'existing_work' | null;
  holder_id?: string | null;
  holder_name?: string | null;
  taken_at?: string | null;
  handed_at?: string | null;
  handoff_note?: string | null;
  returned_at?: string | null;
  return_note?: string | null;
  completed_count: number;
  unfinished_count: number;
  can_take: boolean;
  can_handoff: boolean;
  can_return: boolean;
  can_close: boolean;
  handoff_tasks?: HandoffTask[];
}
export interface Order {
  version: number;
  vehicle_workflow?: VehicleWorkflow;
  id: string;
  order_number: string;
  vehicle: string;
  source: string;
  status: string;
  priority: string;
  planned_date?: string;
  due_date?: string;
  colour?: string;
  vin?: string;
  vehicle_group_name?: string;
  instructions?: string;
  instructions_from_manager?: boolean;
  manager_comment?: string;
  manager_comment_updated_at?: string;
  tasks: Task[];
}
export interface TaskRow { order: Order; task: Task }
export interface Intake {
  id: string;
  status: string;
  order_id?: string;
  row_numbers?: number[];
  source_name?: string;
  latest?: { vehicle?: string; vin?: string };
  original?: { vehicle?: string; vin?: string };
}
export type Section = 'shift' | 'assigned' | 'manager-orders' | 'my-work' | 'history';
export type TeamAction = 'start' | 'join' | 'confirm' | 'block' | 'resume' | 'leave' | 'note';
export interface Profile { id: string; name: string; role: string }
export interface GarageClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<{data: unknown; error?: { code?: string; message?: string } | null}>;
}
export interface ShiftProps {
  client: GarageClient;
  profile: Profile;
  section: Section;
  recordId?: string;
  navigate(section: string, recordId?: string): void;
}

export const participantLabel: Record<ParticipantStatus, string> = {
  assigned: 'Назначено', working: 'В работе', blocked: 'Приостановлено', confirmed: 'Подтверждено'
};
export const taskLabel: Record<string, string> = {
  pending: 'Ожидает начала', in_progress: 'В работе', blocked: 'Приостановлено', completed: 'Выполнено', cancelled: 'Отменено'
};
export function taskName(task: Pick<Task, 'work_name' | 'work_code' | 'options'>) {
  const tint = task.work_code === 'W19' && task.options?.tint_percent;
  return tint ? `${task.work_name} · ${tint}%` : task.work_name;
}
export function isTerminal(task: Task) { return task.status === 'completed' || task.status === 'cancelled'; }

// During an additive rollout an older reader can still return the single-mechanic fields.
export function participants(task: Task): Participant[] {
  if (Array.isArray(task.participants)) return task.participants;
  const mechanic_id = task.working_mechanic_id || task.assigned_to;
  if (!mechanic_id) return [];
  const statuses: Record<string, ParticipantStatus> = { pending: 'assigned', in_progress: 'working', blocked: 'blocked', completed: 'confirmed' };
  const status = statuses[task.status];
  return status ? [{ mechanic_id, name: task.working_name || task.assigned_name || 'Механик', status, confirmed_at: task.completed_at }] : [];
}
export function mine(task: Task, id: string) {
  if (task.my_status !== undefined) return task.my_status;
  return participants(task).find(member => member.mechanic_id === id)?.status ?? null;
}
export function confirmations(task: Task) {
  const team = participants(task);
  return { count: team.filter(person => person.status === 'confirmed').length, total: team.length };
}
export function mayJoin({ order, task }: TaskRow, id: string) {
  return order.vehicle_workflow?.state === 'active' && order.source === 'manager' && order.status === 'published' && !isTerminal(task) && !task.roster_locked && !mine(task, id);
}
export function primaryAction(row: TaskRow, id: string): TeamAction | null {
  if (row.order.status !== 'published' || row.order.vehicle_workflow?.state !== 'active' || isTerminal(row.task)) return null;
  const status = mine(row.task, id);
  if (status === 'assigned') return 'start';
  if (status === 'blocked') return 'resume';
  if (status === 'working') return 'confirm';
  return mayJoin(row, id) ? 'join' : null;
}
export const actionLabel: Record<TeamAction, string> = {
  start: 'Начать работу', join: 'Присоединиться', confirm: 'Подтвердить свою работу', block: 'Приостановить',
  resume: 'Продолжить работу', leave: 'Вернуть в очередь', note: 'Оставить заметку'
};
const localTimestamp = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Minsk', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export function today() { return workshopDay(); }
export function dayLabel(date?: string) {
  if (!date) return '';
  const parts = date.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : date;
}
export function instantLabel(value?: string) {
  if (!value) return '';
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? '' : localTimestamp.format(instant);
}
const vehicleLabels: Record<VehicleState, string> = {
  available: 'Можно взять', active: 'В работе', review: 'Передан владельцу', closed: 'Закрыт', cancelled: 'Отменён'
};
export function vehicleLabel(order: Order) {
  const state = order.vehicle_workflow?.state;
  if (state === 'available' && !order.vehicle_workflow?.can_take) return 'Ожидает механика';
  if (state) return vehicleLabels[state];
  return order.status === 'closed' ? 'Закрыт' : order.status === 'cancelled' ? 'Отменён' : 'Статус недоступен';
}
export function visibleProgress(order: Order) {
  return { completed: order.vehicle_workflow?.completed_count ?? order.tasks.filter(task => task.status === 'completed').length,
    unfinished: order.vehicle_workflow?.unfinished_count ?? order.tasks.filter(task => !isTerminal(task)).length };
}
function priorityRank(priority: string) { return priority === 'urgent' ? 0 : priority === 'high' ? 1 : 2; }
export function sortVisits(orders: Order[]) {
  return [...orders].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) ||
    (a.due_date || '9999').localeCompare(b.due_date || '9999') ||
    (a.planned_date || '9999').localeCompare(b.planned_date || '9999') ||
    (a.order_number || '').localeCompare(b.order_number || '', 'ru', { numeric: true }));
}
export function matchesVisit(order: Order, query: string) {
  const needle = query.trim().toLocaleLowerCase('ru-RU');
  return !needle || [order.order_number, order.vehicle, order.vin, ...order.tasks.map(taskName)].some(value => value?.toLocaleLowerCase('ru-RU').includes(needle));
}
export function finishedAt(task: Task, id: string) {
  return participants(task).find(person => person.mechanic_id === id)?.confirmed_at || task.completed_at || '';
}

interface Group {
  title: string;
  orders: Order[];
}
function historyTime(order: Order, id: string) {
  const times = order.tasks.filter((task) => mine(task, id) === 'confirmed').map((task) => finishedAt(task, id));
  if (order.vehicle_workflow?.holder_id === id && order.vehicle_workflow.handed_at)
    times.push(order.vehicle_workflow.handed_at);
  return times.sort().pop() || '';
}
export function vehicleGroups(section: Section, orders: Order[], id: string): Group[] {
  const groups = new Map<string, Order[]>();
  function add(title: string, order: Order) {
    const group = groups.get(title) || [];
    group.push(order);
    groups.set(title, group);
  }
  const queueTitles = ['Можно взять', 'Уже в работе', 'Переданы владельцу'];
  const shiftTitles = [
    'Мои автомобили в работе',
    'Работаю в команде',
    'Назначенные автомобили',
    'Можно взять',
    'Переданы владельцу',
    'Завершённые автомобили',
  ];
  for (const order of sortVisits(orders)) {
    const workflow = order.vehicle_workflow;
    const member = order.tasks.some((task) => mine(task, id));
    const holder = workflow?.holder_id === id;
    const historical =
      order.tasks.some((task) => mine(task, id) === 'confirmed') || (holder && !!workflow?.handed_at);
    if (section === 'history') {
      if (historical) add('История по автомобилям', order);
      continue;
    }
    if (section === 'manager-orders') {
      if (order.source !== 'manager' || order.status !== 'published') continue;
      if (workflow?.state === 'available' && workflow.can_take) add('Можно взять', order);
      else if (workflow?.state === 'active') add('Уже в работе', order);
      else if (workflow?.state === 'review' && (member || holder)) add('Переданы владельцу', order);
      continue;
    }
    if (section === 'assigned' && order.source !== 'owner') continue;
    if (order.status !== 'published') {
      if (section === 'my-work' && historical) add('Завершённые автомобили', order);
    } else if (workflow?.state === 'active' && holder) add('Мои автомобили в работе', order);
    else if (workflow?.state === 'active' && member) add('Работаю в команде', order);
    else if (workflow?.state === 'review' && (member || holder)) add('Переданы владельцу', order);
    else if (workflow?.can_take) add(order.source === 'owner' ? 'Назначенные автомобили' : 'Можно взять', order);
    else if (!workflow && member) add('Назначенные автомобили', order);
  }
  if (section === 'history')
    return [
      {
        title: 'История по автомобилям',
        orders: (groups.get('История по автомобилям') || []).sort((a, b) =>
          historyTime(b, id).localeCompare(historyTime(a, id)),
        ),
      },
    ];
  return (section === 'manager-orders' ? queueTitles : shiftTitles)
    .filter((title) => groups.has(title))
    .map((title) => ({ title, orders: groups.get(title)! }));
}
