import './owner-detail.css';
import { qualifies, type GiftOffer } from './owner-gift';
import { useState, useRef, useEffect } from 'preact/hooks';
import { instantLabel, dayLabel, type GarageClient } from './shift-model';
import { statusText, errorText, read, type Staff, type Money, type OwnerOrder, type OwnerIntake, type Mutate } from './owner-model';
import { Price, SourceReference } from './owner-summary';
import { OwnerHandoff } from './owner-handoff';
import { OrderJobPrices } from './owner-job-prices';

interface DetailProps {
  order: OwnerOrder;
  intake?: OwnerIntake;
  staff: Staff[];
  client: GarageClient;
  mutate: Mutate;
  reload: () => Promise<void>;
  edit: (promptGift?: boolean) => void;
  offer: GiftOffer | null;
  omit: () => void;
  back: () => void;
  notify: (s: string) => void;
}
export function OwnerDetail({
  order,
  offer,
  intake,
  staff,
  client,
  mutate,
  reload,
  edit,
  omit,
  back,
  notify,
}: DetailProps) {
  const [price, setPrice] = useState<Money | null>(null),
    [priceError, setPriceError] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [cancelVersion, setCancel] = useState<number | null>(null),
    [reason, setReason] = useState('');
  const sending = useRef(false),
    epoch = useRef(0);
  useEffect(() => {
    void financials().catch(() => {});
    return () => {
      epoch.current++;
    };
  }, [client, order]);
  async function financials() {
    const at = ++epoch.current;
    setPriceError(false);
    try {
      const data = await read<Money>(client, 'garage_order_financials', { p_order_id: order.id });
      if (at === epoch.current) setPrice(data);
      return data;
    } catch {
      if (at === epoch.current) setPriceError(true);
      throw new Error('Financials unavailable');
    }
  }
  async function finish(action: string, version: number, note: string) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate('garage_order_action', {
        p_order_id: order.id,
        p_action: action,
        p_expected_version: version,
        p_note: note,
      });
      setCancel(null);
      notify(action === 'close' ? 'Заказ закрыт.' : 'Оставшиеся работы отменены.');
      await reload();
    } catch (err) {
      setError(errorText(err));
      await reload();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const canClose =
    order.tasks.some((t) => t.status === 'completed') &&
    order.tasks.every((t) => ['completed', 'cancelled'].includes(t.status));
  return (
    <article class="owner-order-detail" aria-label={'Заказ ' + order.order_number}>
      <header class="order-detail-head">
        <button class="order-back" type="button" aria-label="К списку заказов" onClick={back}>
          <span aria-hidden="true">← </span>К списку
        </button>
        <h2>{order.vehicle}</h2>
        <p class="order-detail-meta">
          {order.order_number} · {statusText[order.status]} ·{' '}
          {order.source === 'owner' ? 'Назначение владельца' : 'Очередь менеджеров'}
        </p>
        <p>
          {[order.vehicle_group_name, order.colour, order.vin && 'VIN: ' + order.vin, order.manager_label]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p>
          {[
            order.planned_date && 'План: ' + dayLabel(order.planned_date),
            order.due_date && 'Срок: ' + dayLabel(order.due_date),
            order.priority === 'urgent' ? 'Срочный' : order.priority === 'high' ? 'Высокий приоритет' : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>
      {(order.source_changed || intake?.source_changed) && (
        <p class="notice">
          {order.source_missing
            ? 'Строки больше нет в подключённой таблице. Сохранённый заказ остаётся в приложении.'
            : intake?.owner_managed || order.owner_managed
              ? 'Текст таблицы изменился после проверки владельцем. Выбранные работы сохранены.'
              : 'Текст таблицы менеджеров изменился. Проверьте актуальную заявку перед редактированием заказа.'}
        </p>
      )}
      {order.instructions &&
        order.instructions !== order.manager_comment &&
        !(order.instructions_from_manager && order.manager_comment_updated_at) && <p>{order.instructions}</p>}
      {order.manager_comment && (
        <section class="order-manager-comment" aria-label="Комментарий менеджера">
          <h3>Комментарий менеджера</h3>
          <p>{order.manager_comment}</p>
          {order.manager_comment_updated_at && (
            <small>{instantLabel(order.manager_comment_updated_at)}</small>
          )}
        </section>
      )}
      {order.status === 'published' &&
        offer &&
        qualifies(
          offer,
          order.vehicle_group_code,
          order.tasks.filter((t) => t.status !== 'cancelled').map((t) => t.work_code || ''),
        ) &&
        price &&
        !price.tasks?.some((item) => item.work_code === offer.work_code && item.override_kopeks === 0) && (
          <button class="button" type="button" onClick={() => edit(true)}>
            Выбрать подарок для клиента
          </button>
        )}
      <OrderJobPrices order={order} staff={staff} client={client} price={price} refreshPrice={financials}
        mutate={mutate} reload={reload} notify={notify} />
      {price && <Price value={price} />}
      <OwnerHandoff order={order} mutate={mutate} reload={reload} notify={notify} />
      <SourceReference intake={intake} />
      {order.status !== 'cancelled' && <details class="order-management">
        <summary>Действия с заказом</summary>
        <div class="order-actions">
          {order.status === 'published' && (
            <button type="button" class="button button-primary" onClick={() => edit()}>
              Изменить заказ
            </button>
          )}
          {order.status !== 'cancelled' && (
            <button type="button" class="button" onClick={omit}>
              Добавить пропущенную выполненную работу
            </button>
          )}
          {order.status === 'published' && !order.vehicle_workflow && canClose && (
            <button
              type="button"
              class="button"
              disabled={busy}
              onClick={() => finish('close', order.version, '')}
            >
              Закрыть заказ
            </button>
          )}
          {order.status === 'published' && (
            <button
              type="button"
              class="button"
              onClick={() => {
                setCancel(order.version);
                setReason('');
              }}
            >
              Отменить заказ
            </button>
          )}
        </div>
      </details>}
      {priceError ? (
        <p role="alert">
          Не удалось загрузить стоимость работ.{' '}
          <button type="button" class="button" onClick={() => void financials().catch(() => {})}>
            Повторить расчёт
          </button>
        </p>
      ) : (
        !price && <p role="status">Загружаем стоимость работ…</p>
      )}
      {cancelVersion !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) finish('cancel', cancelVersion, reason.trim());
          }}
        >
          <fieldset disabled={busy}>
            <legend>Отмена заказа</legend>
            <label>
              Причина
              <textarea
                required
                maxLength={2000}
                value={reason}
                onInput={(e) => setReason(e.currentTarget.value)}
              />
            </label>
            <p>Оставшиеся работы будут отменены. Выполненные сохранятся в истории.</p>
            {cancelVersion !== order.version && (
              <button type="button" class="button" onClick={() => setCancel(order.version)}>
                Проверить актуальную версию
              </button>
            )}
            <button class="button" disabled={cancelVersion !== order.version} type="submit">
              Подтвердить отмену
            </button>{' '}
            <button type="button" class="button" onClick={() => setCancel(null)}>
              Оставить без изменений
            </button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
