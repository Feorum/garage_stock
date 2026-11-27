import type { DashboardOrder, dashboardWorkRows } from './dashboard-model';
import { taskLabel } from './shift-model';

const priorities = new Map([
  ['normal', { label: 'Обычный', rank: 1 }],
  ['high', { label: 'Высокий', rank: 2 }],
  ['urgent', { label: 'Срочный', rank: 3 }],
]);

export const orderColumns = {
  vin: { label: 'VIN', minWidth: 6, weight: .8, value: (o: DashboardOrder) => maskedVin(o.vin) },
  vehicle: { label: 'Автомобиль', minWidth: 7.5, weight: 1.35, value: (o: DashboardOrder) => o.vehicle },
  date: { label: 'Дата', minWidth: 5.5, weight: .8, value: (o: DashboardOrder) => o.date },
  people: { label: 'Исполнители', minWidth: 8, weight: 1.4, value: (o: DashboardOrder) => peopleNames(o.people) },
  phase: { label: 'Состояние', minWidth: 7, weight: 1, value: (o: DashboardOrder) =>
    [o.phaseLabel, o.inReview ? 'На проверке' : ''].filter(Boolean).join(', ') },
  amount: { label: 'По прайсу', minWidth: 5.5, weight: .85, value: (o: DashboardOrder) => o.catalogueKopeks },
  colour: { label: 'Цвет', minWidth: 5, weight: .85, value: (o: DashboardOrder) => o.colour },
  group: { label: 'Группа', minWidth: 6, weight: .9, value: (o: DashboardOrder) => o.group },
  source: { label: 'Источник', minWidth: 5, weight: .85, value: (o: DashboardOrder) => o.sourceLabel },
  manager: { label: 'Менеджер', minWidth: 6, weight: 1, value: (o: DashboardOrder) => o.manager },
  holder: { label: 'Ответственный', minWidth: 7.5, weight: 1, value: (o: DashboardOrder) => o.holder },
  type: { label: 'Тип заказа', minWidth: 6.5, weight: .9, value: (o: DashboardOrder) => o.isCustom ? 'Кастомный' : 'Стандарт' },
  works: { label: 'Работы', minWidth: 8, weight: 1.5, value: (o: DashboardOrder) => o.works.map(work => work.name).join(', ') },
  plannedDate: { label: 'Плановая дата', minWidth: 7, weight: .85, value: (o: DashboardOrder) => o.details?.plannedDate || '' },
  dueDate: { label: 'Срок выполнения', minWidth: 7, weight: .85, value: (o: DashboardOrder) => o.details?.dueDate || '' },
  createdDate: { label: 'Дата создания', minWidth: 7, weight: .85, value: (o: DashboardOrder) => o.details?.createdDate || '' },
  closedDate: { label: 'Дата закрытия', minWidth: 7, weight: .85, value: (o: DashboardOrder) => o.details?.closedDate || '' },
  priority: { label: 'Приоритет', minWidth: 6, weight: .8,
    value: (o: DashboardOrder) => priorities.get(o.details?.priority || '')?.label || '',
    sortValue: (o: DashboardOrder) => priorities.get(o.details?.priority || '')?.rank ?? null },
  instructions: { label: 'Указания по заказу', minWidth: 10, weight: 1.6, value: (o: DashboardOrder) => o.details?.instructions || '' },
  managerComment: { label: 'Комментарий менеджера', minWidth: 10, weight: 1.6, value: (o: DashboardOrder) => o.details?.managerComment || '' },
  sourceSheet: { label: 'Таблица-источник', minWidth: 8, weight: 1, value: (o: DashboardOrder) => o.details?.sourceSheet || '' },
};
export type OrderColumn = keyof typeof orderColumns;
export const orderColumnIds = Object.keys(orderColumns) as OrderColumn[];

export type OrderWorkRow = ReturnType<typeof dashboardWorkRows>[number];
export const workColumns = {
  vehicle: { label: 'Автомобиль', minWidth: 7.5, weight: 1.15, value: ({ order }: OrderWorkRow) => order.vehicle },
  vin: { ...orderColumns.vin, value: ({ order }: OrderWorkRow) => orderColumns.vin.value(order) },
  date: { label: 'Дата заказа', minWidth: 6.5, weight: .8, value: ({ order }: OrderWorkRow) => order.date },
  name: { label: 'Работа', minWidth: 7, weight: 1.4, value: ({ work }: OrderWorkRow) => work.name },
  status: { label: 'Состояние работы', minWidth: 7, weight: 1, value: ({ work }: OrderWorkRow) => taskLabel[work.status] || '' },
  people: { ...orderColumns.people, value: ({ work }: OrderWorkRow) => peopleNames(work.people) },
};
export type WorkColumn = keyof typeof workColumns;
export const workColumnIds = Object.keys(workColumns) as WorkColumn[];

export interface TableSort<T extends string> { column: T; direction: 'asc' | 'desc' }
export interface OrderLayout { columns: OrderColumn[]; sort: TableSort<OrderColumn> }
export interface OrderView extends OrderLayout { id: string; name: string }
export interface OrderTableSettings {
  main: OrderLayout;
  views: OrderView[];
  workSort: TableSort<WorkColumn>;
}

export const orderTableDefaults: OrderTableSettings = {
  main: { columns: ['vin', 'vehicle', 'date', 'people', 'phase', 'amount', 'colour', 'source'],
    sort: { column: 'date', direction: 'asc' } },
  views: [],
  workSort: { column: 'date', direction: 'asc' },
};

export function maskedVin(vin: string) {
  const value = vin.trim();
  return value ? 'VIN....' + value.slice(-4) : '';
}

function peopleNames(people: readonly { name: string }[]) {
  return people.map(person => person.name).filter(Boolean).join(', ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSort<T extends string>(value: unknown, columns: readonly T[], fallback: T): TableSort<T> {
  return isRecord(value) && columns.includes(value.column as T) && (value.direction === 'asc' || value.direction === 'desc')
    ? { column: value.column as T, direction: value.direction }
    : { column: fallback, direction: 'asc' };
}

function readLayout(input: unknown): OrderLayout {
  const columns = isRecord(input) && Array.isArray(input.columns)
    ? [...new Set(input.columns.filter((column): column is OrderColumn => orderColumnIds.includes(column)))] : [];
  const selected = columns.length ? columns : orderTableDefaults.main.columns;
  return { columns: selected, sort: readSort(isRecord(input) && input.sort, selected, selected.includes('date') ? 'date' : selected[0]) };
}

export function readOrderTableSettings(value: unknown): OrderTableSettings {
  if (!isRecord(value)) return orderTableDefaults;
  const views: OrderView[] = [];
  const ids = new Set<string>();
  if (Array.isArray(value.views)) for (const item of value.views) {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(item.id) ||
      typeof item.name !== 'string' || !item.name.trim() || ids.has(item.id)) continue;
    views.push({ id: item.id, name: item.name.trim(), ...readLayout(item) });
    ids.add(item.id);
  }
  return { main: readLayout(value.main), views, workSort: readSort(value.workSort, workColumnIds, 'date') };
}

export function withOrderColumns(layout: OrderLayout, columns: OrderColumn[]): OrderLayout {
  return { columns, sort: readSort(layout.sort, columns, columns.includes('date') ? 'date' : columns[0]) };
}

export function orderViewHref(id = '') {
  return id ? '#orders?' + new URLSearchParams({ view: id }) : '#orders';
}

export function nextTableSort<T extends string>(sort: TableSort<T>, column: T): TableSort<T> {
  return { column, direction: sort.column === column && sort.direction === 'asc' ? 'desc' : 'asc' };
}

type CellValue = string | number | null;
const tableCollator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

export function sortTableRows<Row, Column extends string>(
  rows: readonly Row[], sort: TableSort<Column>,
  columns: Record<Column, { value: (row: Row) => CellValue; sortValue?: (row: Row) => CellValue }>,
) {
  const column = columns[sort.column];
  const value = column.sortValue ?? column.value;
  const direction = sort.direction === 'asc' ? 1 : -1;
  return rows.map(row => ({ row, value: value(row) })).sort((a, b) => {
    const first = a.value;
    const second = b.value;
    if (first === null || first === '') return second === null || second === '' ? 0 : 1;
    if (second === null || second === '') return -1;
    if (typeof first === 'number' && typeof second === 'number') return direction * (first - second);
    return direction * tableCollator.compare(String(first), String(second));
  }).map(({ row }) => row);
}

export function orderTableCsv(rows: DashboardOrder[], columns: OrderColumn[]): string[][] {
  return [
    columns.map(column => column === 'amount' ? 'По прайсу, BYN' : orderColumns[column].label),
    ...rows.map(row => columns.map(column => {
      const value = orderColumns[column].value(row);
      return typeof value === 'number' ? (value / 100).toFixed(2).replace('.', ',') : value ?? '';
    })),
  ];
}

export function workTableCsv(rows: OrderWorkRow[]): string[][] {
  return [
    workColumnIds.map(column => workColumns[column].label),
    ...rows.map(row => workColumnIds.map(column => workColumns[column].value(row))),
  ];
}
