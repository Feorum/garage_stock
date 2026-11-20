import { isArchived, orderAuthor, orderPhase, type listEntries } from './owner-model';
import { taskName } from './shift-model';
import { formatOrderDay, weekdayClass } from './order-calendar';

type Row = ReturnType<typeof listEntries>[number];

function OrderRows({ rows, selectedId, open }: { rows: Row[]; selectedId?: string; open(id: string): void }) {
  return <div class="order-list">{rows.map(row => {
    const raw = row.intake?.latest || row.intake?.original;
    const vehicle = row.order?.vehicle || String(raw?.vehicle || 'Укажите автомобиль');
    const colour = row.order?.colour || raw?.colour;
    const planned = row.order?.planned_date || row.intake?.suggested_order?.planned_date;
    const status = row.order ? orderPhase(row.order).label : 'На проверке';
    const works = row.order?.tasks.filter(task => task.status !== 'cancelled').map(taskName).join(' · ')
      || [raw?.wrapping, raw?.tint].filter(Boolean).join(' · ');
    const details = [
      row.order ? orderAuthor(row.order) : 'Менеджер',
      row.source && row.label,
      row.row && 'Строка ' + row.row,
      row.order?.order_number,
      row.order?.vehicle_workflow?.holder_name,
      row.order?.manager_label || raw?.manager_label,
    ].filter(Boolean);
    return <div class="order-list-entry" key={row.id}>
      <button type="button"
        class={'compact-order order-index-row ' + weekdayClass(row.day) + (row.id === selectedId ? ' is-selected' : '')}
        data-order-id={row.order?.id}
        data-intake-id={row.intake?.id}
        aria-current={row.id === selectedId ? 'true' : undefined}
        onClick={() => open(row.id)}
      >
        <span class="order-row-top"><strong>{vehicle}</strong><span class="task-status">{status}</span></span>
        <span class="order-row-meta">
          {colour && <>{colour} · </>}
          {row.day && planned !== row.day && 'Срок '}
          {row.day ? <time dateTime={row.day}>{formatOrderDay(row.day)}</time> : String(raw?.date || 'Дата не назначена')}
          {' · '}{details.join(' · ')}
        </span>
        {works && <span class="order-row-works">{works}</span>}
      </button>
    </div>;
  })}</div>;
}

export function OwnerOrderList({ rows, filter, search, selectedId, open }: {
  rows: Row[];
  filter: string;
  search: string;
  selectedId?: string;
  open(id: string): void;
}) {
  if (filter === 'closed') return <OrderRows rows={rows} selectedId={selectedId} open={open} />;
  const archive = rows.filter(row => row.order && isArchived(row.order));
  const current = rows.filter(row => !row.order || !isArchived(row.order));
  return <>
    {current.length > 0 && <OrderRows rows={current} selectedId={selectedId} open={open} />}
    {archive.length > 0 && <details class="owner-archive" open={Boolean(search.trim()) || undefined}>
      <summary>Архив <span>{archive.length}</span></summary>
      <OrderRows rows={archive} selectedId={selectedId} open={open} />
    </details>}
  </>;
}
