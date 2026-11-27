import type { DashboardMetric } from './dashboard-model';

export const valueMetrics = {
  amount: 'По прайсу',
  orders: 'Заказы',
  active: 'В работе',
  unarchived: 'Активные заказы',
  works: 'Работы',
  review: 'На проверке',
  closed: 'Закрытые заказы',
  completedWorks: 'Выполнено работ',
} satisfies Record<DashboardMetric | 'review' | 'unarchived', string>;

export const chartMetrics = { orders: valueMetrics.orders, works: valueMetrics.works };
export const progressMetrics = { completedWorks: 'Выполнение работ', closed: 'Доля закрытых заказов' };
const monthlyMetrics = {
  both: 'Количество и сумма по прайсу',
  count: 'Только количество закрытых заказов',
  amount: 'Только сумма по прайсу',
};

const metricsByKind = { chart: chartMetrics, progress: progressMetrics, value: valueMetrics, monthly: monthlyMetrics };
export type WidgetKind = keyof typeof metricsByKind;
export type WidgetMetric<T extends WidgetKind> = keyof (typeof metricsByKind)[T];
export type OwnerWidget = {
  [K in WidgetKind]: { id: string; title: string; kind: K; metric: WidgetMetric<K> };
}[WidgetKind];

export const widgetKinds: Record<WidgetKind, string> = {
  chart: 'График', progress: 'Прогресс', value: 'Показатель', monthly: 'Итог за месяц',
};
export const widgetTitleLimit = 80;
export const noWidgets: readonly OwnerWidget[] = [];
export const homeWidgets: readonly OwnerWidget[] = [
  { id: 'activity', kind: 'chart', metric: 'orders', title: '' },
  { id: 'completion', kind: 'progress', metric: 'completedWorks', title: '' },
  { id: 'amount', kind: 'value', metric: 'amount', title: '' },
  { id: 'orders', kind: 'value', metric: 'orders', title: '' },
  { id: 'active', kind: 'value', metric: 'active', title: '' },
  { id: 'works', kind: 'value', metric: 'works', title: '' },
  { id: 'review', kind: 'value', metric: 'review', title: '' },
  { id: 'closed', kind: 'value', metric: 'closed', title: '' },
];
export const orderWidgets: readonly OwnerWidget[] = [
  { id: 'orders', kind: 'value', metric: 'orders', title: 'Всего заказов' },
  { id: 'unarchived', kind: 'value', metric: 'unarchived', title: '' },
  { id: 'review', kind: 'value', metric: 'review', title: '' },
  { id: 'closed', kind: 'value', metric: 'closed', title: '' },
];
export const monthlyWidgets: readonly OwnerWidget[] = [
  { id: 'monthly-summary', kind: 'monthly', metric: 'both', title: '' },
];

export function widgetTitle(widget: OwnerWidget): string {
  if (widget.title) return widget.title;
  switch (widget.kind) {
    case 'chart': return 'Активность';
    case 'progress': return progressMetrics[widget.metric];
    case 'value': return valueMetrics[widget.metric];
    case 'monthly': return widgetKinds.monthly;
  }
}

export function widgetMetricOptions(kind: WidgetKind) {
  return Object.entries(metricsByKind[kind]);
}

export function withWidgetMetric(widget: OwnerWidget, metric: string): OwnerWidget {
  if (!Object.hasOwn(metricsByKind[widget.kind], metric)) return widget;
  return { ...widget, metric } as OwnerWidget;
}

export function createOwnerWidget(kind: WidgetKind, id: string): OwnerWidget {
  const base = { id, title: '' };
  switch (kind) {
    case 'chart': return { ...base, kind, metric: 'orders' };
    case 'progress': return { ...base, kind, metric: 'completedWorks' };
    case 'value': return { ...base, kind, metric: 'orders' };
    case 'monthly': return { ...base, kind, metric: 'both' };
  }
}

export function readOwnerWidgets(saved: unknown, fallback: readonly OwnerWidget[] = noWidgets): readonly OwnerWidget[] {
  if (!Array.isArray(saved)) return fallback;
  const seen = new Set<string>();
  const widgets: OwnerWidget[] = [];
  for (const entry of saved) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id) ||
      typeof entry.kind !== 'string' || !Object.hasOwn(widgetKinds, entry.kind) || typeof entry.metric !== 'string') continue;
    const widget = createOwnerWidget(entry.kind as WidgetKind, entry.id);
    const configured = withWidgetMetric(widget, entry.metric);
    if (configured === widget) continue;
    seen.add(widget.id);
    widgets.push({ ...configured, title: typeof entry.title === 'string' ? entry.title.trim().slice(0, widgetTitleLimit) : '' });
  }
  return widgets;
}
