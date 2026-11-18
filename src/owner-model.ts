import type { PrivatePricing, Payout } from './pay-model';
import type { GarageClient, Order, Task } from './shift-model';
import { participants } from './shift-model';
import { WORKS, AVAILABLE_WORKS } from './catalogue.js';

export interface OwnerOrder extends Order {
  vehicle_group_code: string;
  version: number;
  source_id?: string;
  source_name?: string;
  source_row_number?: number;
  manager_label?: string;
  owner_managed?: boolean;
  source_missing?: boolean;
  source_changed?: boolean;
}
export interface Staff {
  id: string;
  name: string;
}
export type Raw = Record<string, string | boolean | null>;
export interface OwnerIntake {
  id: string;
  version: number;
  status: string;
  order_id?: string;
  source_id?: string;
  source_name?: string;
  row_numbers?: number[];
  original?: Raw;
  latest?: Raw;
  source_changed?: boolean;
  owner_managed?: boolean;
  observations?: { raw: Raw; row_number?: number }[];
  original_observations?: { raw: Raw; row_number?: number }[];
  suggested_order?: Partial<OrderFields>;
  suggested_tasks?: Task[];
  issues?: string[];
}
export interface OrderFields {
  vehicle: string;
  vin: string;
  colour: string;
  source: string;
  manager_label: string;
  vehicle_group_code: string;
  planned_date: string;
  due_date: string;
  priority: string;
  instructions: string;
}
export interface Choice {
  id?: string;
  work_code: string;
  options: { tint_percent?: number };
  assigned_to: string | null;
  mechanic_ids: string[];
  instructions: string;
}
export interface Draft {
  fields: OrderFields;
  choices: Choice[];
}
export type Mode = 'new' | 'intake' | 'edit';
export interface EditorSeed {
  promptGift?: boolean;
  mode: Mode;
  order?: OwnerOrder;
  intake?: OwnerIntake;
}
export interface TaskPrice extends PrivatePricing {
  task_id?: string;
  work_code?: string;
  status?: string;
  net_amount?: number | null;
  gross_amount?: number | null;
  payout?: Payout | null;
}
export interface Money {
  effective_total_kopeks?: number | null;
  effective_tax_kopeks?: number | null;
  effective_gross_kopeks?: number | null;
  items?: TaskPrice[];
  tasks?: TaskPrice[];
  status: string;
  net_amount?: number | null;
  vat_amount?: number | null;
  gross_amount?: number | null;
}
export type Mutate = <T>(name: string, args: Record<string, unknown>) => Promise<T>;
export const protectedTask = (t: Task) =>
  ['in_progress', 'blocked', 'completed'].includes(t.status) || Boolean(t.working_mechanic_id);
export const hood = new Set(['W01', 'W03', 'W04']);
export const availableWorks = (group: string): string[] =>
  (AVAILABLE_WORKS as Record<string, string[]>)[group] || [];
export const workName = (code: string) => WORKS.find((w) => w.code === code)?.name || code;
export const statusText: Record<string, string> = {
  published: 'Открыт',
  closed: 'Закрыт',
  cancelled: 'Отменено',
  pending: 'Ожидает',
  in_progress: 'В работе',
  blocked: 'Приостановлено',
  completed: 'Выполнено',
};
export const fieldLabel: Record<keyof OrderFields, string> = {
  vehicle: 'Автомобиль',
  vin: 'VIN',
  colour: 'Цвет',
  source: 'Источник заказа',
  manager_label: 'Менеджер',
  vehicle_group_code: 'Группа автомобилей',
  planned_date: 'Плановая дата',
  due_date: 'Срок выполнения',
  priority: 'Приоритет',
  instructions: 'Указания',
};

export async function read<T>(
  client: GarageClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.rpc(name, args);
  if (result.error) throw result.error;
  return result.data as T;
}
export const isConflict = (error: unknown) => (error as { code?: string })?.code === '40001';
export function errorText(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (isConflict(error)) return 'Данные изменились. Проверьте актуальную версию.';
  if (code === '42501') return 'Недостаточно прав для этого действия.';
  if (code === 'P0001' || code === '23514' || code === '22P02')
    return 'Проверьте состав работ, команду и введённые данные.';
  return 'Не удалось подтвердить изменение. Проверьте подключение и повторите попытку.';
}
export function initialDraft({ mode, order, intake }: EditorSeed): Draft {
  const seed =
    order ||
    (mode === 'intake'
      ? { ...(intake?.latest || intake?.original || {}), ...intake?.suggested_order, source: 'manager' }
      : {});
  const fields: OrderFields = {
    vehicle: '',
    vin: '',
    colour: '',
    source: 'owner',
    manager_label: '',
    vehicle_group_code: '',
    planned_date: '',
    due_date: '',
    priority: 'normal',
    instructions: '',
  };
  for (const key of Object.keys(fields) as (keyof OrderFields)[]) {
    const value = (seed as Record<string, unknown>)[key];
    if (typeof value === 'string') fields[key] = value;
  }
  const tasks = order?.tasks || intake?.suggested_tasks || [];
  return {
    fields,
    choices: tasks
      .filter((t) => t.status !== 'cancelled' && t.work_code)
      .map((t) => ({
        ...(mode === 'edit' ? { id: t.id } : {}),
        work_code: t.work_code!,
        options: t.options || {},
        assigned_to: t.assigned_to || null,
        mechanic_ids: fields.source === 'owner' ? participants(t).map((m) => m.mechanic_id) : [],
        instructions: t.instructions || '',
      })),
  };
}
export function quoteTasks(choices: Choice[]) {
  return choices.map(({ mechanic_ids: _team, ...task }) => task);
}
export function listEntries(orders: OwnerOrder[], intakes: OwnerIntake[], query: string, filter: string) {
  const needle = query.trim().toLocaleLowerCase('ru-RU');
  const matches = (values: unknown[]) =>
    values.some((v) =>
      String(v || '')
        .toLocaleLowerCase('ru-RU')
        .includes(needle),
    );
  const rows: {
    id: string;
    source: string;
    label: string;
    row: number;
    order?: OwnerOrder;
    intake?: OwnerIntake;
  }[] = [];
  for (const order of orders) {
    if (
      filter === 'review' ||
      (filter === 'handoff' && order.vehicle_workflow?.state !== 'review') ||
      (filter === 'open' && order.status !== 'published') ||
      (filter === 'closed' && order.status === 'published')
    )
      continue;
    if (
      !matches([order.vehicle, order.vin, order.order_number, order.manager_label, order.vehicle_group_name])
    )
      continue;
    rows.push({
      id: order.id,
      source: order.source_id || '',
      label: order.source_name || 'Другие заказы',
      row: order.source_row_number || 0,
      order,
    });
  }
  for (const intake of intakes) {
    if (intake.order_id || intake.status !== 'pending' || ['closed', 'handoff'].includes(filter)) continue;
    const raw = intake.latest || intake.original || {};
    if (!matches([raw.vehicle, raw.vin, raw.manager_label, intake.source_name])) continue;
    rows.push({
      id: intake.id,
      source: intake.source_id || '',
      label: intake.source_name || 'Заявки менеджеров',
      row: Math.min(...(intake.row_numbers || [])) || 0,
      intake,
    });
  }
  return rows.sort(
    (a, b) =>
      Number(!a.source) - Number(!b.source) ||
      a.label.localeCompare(b.label, 'ru') ||
      a.source.localeCompare(b.source) ||
      (a.row || Infinity) - (b.row || Infinity),
  );
}
