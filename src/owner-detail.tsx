import './owner-detail.css';
import { qualifies, type GiftOffer } from './owner-gift';
import { useLayoutEffect, useState, useRef } from 'preact/hooks';
import { dayLabel, taskName, type GarageClient } from './shift-model';
import { customerPrice, money } from './pay-model';
import { orderAuthor, orderPhase, errorText, type Money, type OwnerOrder, type OwnerIntake, type Mutate } from './owner-model';
import { useOrderFinancials } from './owner-order-financials';
import { Price } from './owner-summary';
import { OwnerHandoff } from './owner-handoff';
import { OwnerAct } from './owner-act';

interface DetailProps {
  order: OwnerOrder;
  intake?: OwnerIntake;
  client: GarageClient;
  mutate: Mutate;
  reload: () => Promise<void>;
  edit: (promptGift?: boolean) => void;
  offer: GiftOffer | null;
  omit: () => void;
  back: () => void;
  notify: (s: string) => void;
}

function JobPriceList({ order, prices }: { order: OwnerOrder; prices: Money | null }) {
  const byJob = new Map((prices?.tasks ?? prices?.items ?? []).map(item => [item.task_id, customerPrice(item)]));
  if (!order.tasks.length) return <p class="muted">Работы пока не добавлены.</p>;
  return <ul class="owner-price-rows" aria-label="Работы и цены" role="list">
    {order.tasks.map(task => {
      const amount = byJob.get(task.id);
      const cancelled = task.status === 'cancelled';
      return <li class={cancelled ? 'is-cancelled' : undefined} key={task.id} data-task-id={task.id}>
        <strong>{taskName(task)}</strong>
        <span>{cancelled ? 'Отменено' : amount != null ? money(amount) : prices ? 'Цена не указана' : '—'}</span>
      </li>;
    })}
  </ul>;
}

export function OwnerDetail({
  order,
  offer,
  intake,
  client,
  mutate,
  reload: refreshOrder,
  edit,
  omit,
  back,
  notify,
}: DetailProps) {
  const { price, priceError, financials } = useOrderFinancials(client, order);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [cancelVersion, setCancel] = useState<number | null>(null),
    [reason, setReason] = useState('');
  const sending = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const published = order.status === 'published';
  const cancelling = published && cancelVersion !== null;
  const reload = () => refreshOrder().catch(() => {});
  useLayoutEffect(() => {
    if (cancelling) reasonField.current?.focus();
  }, [cancelling]);
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
  const canEdit = published || order.status === 'closed' || order.tasks.some(task => task.status === 'completed');
  const state = orderPhase(order);
  const workflow = order.vehicle_workflow;
  const handoff = <OwnerHandoff order={order} mutate={mutate} reload={reload} notify={notify} />;
  const canOfferGift = published && offer && qualifies(
    offer,
    order.vehicle_group_code,
    order.tasks.filter((task) => task.status !== 'cancelled').map((task) => task.work_code || ''),
  ) && price && !price.tasks?.some((item) => item.work_code === offer.work_code && item.override_kopeks === 0);
  return <>
    <button class="order-back" type="button" aria-label="К списку заказов" onClick={back}>
      <span aria-hidden="true">← </span>К списку
    </button>
    <article class="owner-order-detail" aria-label={'Заказ ' + order.vehicle}>
      <header class="order-detail-head">
        <h2>{order.vehicle}</h2>
        <span class={'owner-board-phase phase-' + state.tone}>{state.label}</span>
        <p>
          {[order.colour, order.vin && 'VIN ' + order.vin, order.manager_label || orderAuthor(order)].filter(Boolean).join(' · ')}
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
        {order.manager_comment && (
          <section class="order-manager-comment" aria-label="Комментарий менеджера">
            <h3>Комментарий менеджера</h3>
            <p>{order.manager_comment}</p>
          </section>
        )}
        {order.instructions &&
          order.instructions !== order.manager_comment &&
          !(order.instructions_from_manager && order.manager_comment_updated_at) &&
          <p class="order-detail-instructions">{order.instructions}</p>}
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
      <section class="owner-price-section" aria-labelledby="owner-price-heading">
        <h3 id="owner-price-heading">Прайс</h3>
        <JobPriceList order={order} prices={price} />
        {price && <Price value={price} />}
        {priceError ? (
          <p role="alert">
            Не удалось загрузить стоимость работ.{' '}
            <button type="button" class="button" onClick={() => void financials().catch(() => {})}>
              Повторить расчёт
            </button>
          </p>
        ) : !price && <p role="status">Загружаем стоимость работ…</p>}
        {order.status !== 'cancelled' && <div class="button-row owner-price-actions">
          <button type="button" class="button" onClick={omit}>Добавить пропущенную выполненную работу</button>
          {canOfferGift && <button type="button" class="button" onClick={() => edit(true)}>Выбрать подарок для клиента</button>}
        </div>}
      </section>
      {workflow && ((workflow.can_return || workflow.can_close) ? handoff :
        (workflow.taken_at || workflow.handed_at || workflow.handoff_note || workflow.returned_at || workflow.return_note) &&
          <details class="order-handoff-history">
            <summary>История передачи автомобиля</summary>
            {handoff}
          </details>)}
      {order.status === 'closed' && <OwnerAct order={order} client={client} price={price}
        refreshOrder={refreshOrder} refreshPrice={financials} />}
      {cancelling && (
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
                ref={reasonField}
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
            <div class="button-row">
              <button class="button" disabled={cancelVersion !== order.version} type="submit">Подтвердить отмену</button>
              <button type="button" class="button" onClick={() => {
                setCancel(null);
                requestAnimationFrame(() => cancelButton.current?.focus());
              }}>Оставить без изменений</button>
            </div>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {canEdit && <footer class="order-actions">
        <button type="button" class="button button-primary" onClick={() => edit()}>Изменить заказ</button>
        {published && !workflow && canClose && (
          <button type="button" class="button" disabled={busy} onClick={() => finish('close', order.version, '')}>
            Закрыть заказ
          </button>
        )}
        {published && <button ref={cancelButton} type="button" class="button" disabled={busy || cancelling} onClick={() => {
          setCancel(order.version);
          setReason('');
        }}>Отменить заказ</button>}
      </footer>}
    </article>
  </>;
}
