import { workshopDay } from './workspace-types';

export type ParticipantStatus = 'assigned' | 'working' | 'blocked' | 'confirmed';
export interface Participant {
  mechanic_id: string;
  name: string;
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
export interface Order {
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
export function taskName(task: Task) {
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
  return order.source === 'manager' && order.status === 'published' && !isTerminal(task) && !task.roster_locked && !mine(task, id);
}
export function primaryAction(row: TaskRow, id: string): TeamAction | null {
  if (row.order.status !== 'published' || isTerminal(row.task)) return null;
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
function priorityRank(priority: string) { return priority === 'urgent' ? 0 : priority === 'high' ? 1 : 2; }
export function sortWork(rows: TaskRow[]) {
  return [...rows].sort((a, b) => priorityRank(a.order.priority) - priorityRank(b.order.priority) ||
    (a.order.due_date || '9999').localeCompare(b.order.due_date || '9999') ||
    (a.order.planned_date || '9999').localeCompare(b.order.planned_date || '9999') ||
    (a.order.order_number || '').localeCompare(b.order.order_number || '', 'ru', { numeric: true }));
}
export function matchesWork(row: TaskRow, query: string) {
  return [row.order.order_number, row.order.vin, row.order.vehicle, taskName(row.task)].some(value =>
    value?.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU')));
}
export function finishedAt(task: Task, id: string) {
  return participants(task).find(person => person.mechanic_id === id)?.confirmed_at || task.completed_at || '';
}
