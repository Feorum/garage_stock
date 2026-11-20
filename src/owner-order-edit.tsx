import type { ComponentProps } from 'preact';
import { useState } from 'preact/hooks';
import { OrderEditor } from './owner-editor';
import { OrderJobPrices } from './owner-job-prices';
import type { OwnerIntake, OwnerOrder } from './owner-model';
import { useOrderFinancials } from './owner-order-financials';
import './owner-order-edit.css';

type Props = Omit<ComponentProps<typeof OrderEditor>, 'seed' | 'quoteRevision'> & {
  order: OwnerOrder;
  intake?: OwnerIntake;
  promptGift: boolean;
  refreshOrder(): Promise<void>;
  notify(message: string): void;
};

export function OwnerOrderEdit({ order, intake, promptGift, refreshOrder, notify, ...editor }: Props) {
  const [scopeVisited, setScopeVisited] = useState(promptGift);
  const { price, priceError, financials } = useOrderFinancials(editor.client, order);
  const priceVersions = (price?.tasks || price?.items || [])
    .map(item => `${item.task_id}:${item.private_version}`).sort().join(',');

  return <section class="owner-order-edit" aria-labelledby="order-edit-title">
    <button class="button owner-edit-back" type="button" onClick={editor.close}>
      <span aria-hidden="true">←</span> К заказу
    </button>
    <header>
      <h2 id="order-edit-title">Изменить заказ</h2>
      <p>{order.vehicle}</p>
    </header>
    {order.status === 'published' && <details class="owner-edit-scope" open={promptGift || undefined}
      onToggle={event => { if (event.currentTarget.open) setScopeVisited(true); }}>
      <summary>Данные и состав работ</summary>
      {scopeVisited && <OrderEditor {...editor} seed={{ mode: 'edit', order, intake, promptGift }}
        quoteRevision={priceVersions} />}
    </details>}
    <section class="owner-order-detail owner-edit-financials" aria-label="Цены и выплаты">
      <h3>Цены и выплаты</h3>
      {priceError ? <p role="alert">
        Не удалось загрузить стоимость работ.{' '}
        <button type="button" class="button" onClick={() => void financials().catch(() => {})}>Повторить расчёт</button>
      </p> : !price && <p role="status">Загружаем стоимость работ…</p>}
      <OrderJobPrices order={order} staff={editor.staff} client={editor.client}
        price={price} refreshPrice={financials} mutate={editor.mutate}
        reload={() => refreshOrder().catch(() => {})} notify={notify} />
    </section>
  </section>;
}
