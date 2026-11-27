import './owner-detail.css';
import { qualifies, type GiftOffer } from './owner-gift';
import { useEffect, useLayoutEffect, useState, useRef } from 'preact/hooks';
import { dayLabel, taskName } from './shift-model';
import type { Client } from './workspace-types';
import { TaskPricing } from './owner-pricing';
import { OrderPhotos } from './order-photos';
import { OrderFilm } from './order-film';
import { customerPrice, money } from './pay-model';
import { orderAuthor, orderPhase, statusText, errorText, type Money, type OwnerOrder, type OwnerIntake, type Staff, type Mutate } from './owner-model';
import { useOrderFinancials } from './owner-order-financials';
import { OwnerCommercial } from './owner-commercial';
import { Price } from './owner-summary';
import { OrderPayroll } from './order-payroll';
import { OwnerHandoff } from './owner-handoff';
import { OwnerAct } from './owner-act';
import { OrderSectionBar, PhotoShortcut, type OrderSection } from './order-section-bar';
import { OwnerOrderNote } from './owner-order-note';
import { confirmOrderDeletion, deleteOrder } from './order-delete';

interface DetailProps {
  order: OwnerOrder;
  intake?: OwnerIntake;
  staff: Staff[];
  client: Client;
  mutate: Mutate;
  reload: () => Promise<void>;
  edit: (promptGift?: boolean) => void;
  offer: GiftOffer | null;
  omit: () => void;
  back: () => void;
  deleted: () => void;
  notify: (s: string) => void;
}

function JobPriceList({ order, prices, client, reload }: {
  order: OwnerOrder; prices: Money | null; client: Client; reload(): Promise<Money>;
}) {
  const byJob = new Map((prices?.tasks ?? prices?.items ?? []).map(item => [item.task_id, item]));
  if (!order.tasks.length) return <p class="muted">Работы пока не добавлены.</p>;
  return <ul class="owner-price-rows" aria-label="Работы и цены" role="list">
    {order.tasks.map(task => {
      const price = byJob.get(task.id);
      const amount = price ? customerPrice(price) : null;
      const cancelled = task.status === 'cancelled';
      return <li class={cancelled ? 'is-cancelled' : undefined} key={task.id} data-task-id={task.id}>
        <strong>{taskName(task)}</strong>
        {!cancelled && price?.private_version != null
          ? <TaskPricing inline client={client} taskId={task.id} value={price}
              onSaved={() => window.dispatchEvent(new CustomEvent('garage-order-finance-updated', { detail: order.id }))}
              reload={async () => { await reload(); }} />
          : <span>{cancelled ? 'Отменено' : amount != null ? money(amount) : prices ? 'Цена не указана' : '—'}</span>}
      </li>;
    })}
  </ul>;
}

export function OwnerDetail({
  order,
  offer,
  intake,
  staff,
  client,
  mutate,
  reload: refreshOrder,
  edit,
  omit,
  back,
  deleted,
  notify,
}: DetailProps) {
  const { price, priceError, financials } = useOrderFinancials(client, order);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [cancelVersion, setCancel] = useState<number | null>(null),
    [reason, setReason] = useState('');
  const sending = useRef(false);
  const mounted = useRef(true);
  const deleteRequest = useRef<{ version: number; id: string } | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const published = order.status === 'published';
  const cancelling = published && cancelVersion !== null;
  const reload = () => refreshOrder().catch(() => {});
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
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
  async function remove() {
    if (sending.current || !confirmOrderDeletion(order.vehicle)) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      if (deleteRequest.current?.version !== order.version) {
        deleteRequest.current = { version: order.version, id: crypto.randomUUID() };
      }
      await deleteOrder(client, order.id, false, order.version, deleteRequest.current.id);
      window.dispatchEvent(new Event('garage-orders-changed'));
      if (mounted.current) deleted();
    } catch (failure) {
      if (mounted.current) {
        setError(errorText(failure));
        await reload();
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
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
  const payrollLink = location.hash === '#orders/' + encodeURIComponent(order.id) + '/payroll';
  const [section, setSection] = useState<OrderSection>(payrollLink ? 'payroll' : 'overview');
  const [visited, setVisited] = useState<Set<OrderSection>>(() => new Set([payrollLink ? 'payroll' : 'overview']));
  const [closeNote, setCloseNote] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const documents = useRef<HTMLDivElement>(null);
  const sections: OrderSection[] = ['overview', 'prices', 'payroll'];
  if (canEdit) sections.push('edit');
  sections.push('photos');
  if (order.status === 'closed') sections.push('documents');

  function choose(next: OrderSection) {
    if (next === 'edit') return edit();
    setSection(next);
    setVisited(prev => new Set([...prev, next]));
  }
  function showPhotos() {
    choose('photos');
    requestAnimationFrame(() => panel.current?.focus());
  }
  function closeAct(message?: string) {
    const wasVisible = documents.current?.hidden === false;
    setVisited(previous => {
      const next = new Set(previous);
      next.delete('documents');
      return next;
    });
    setSection(current => current === 'documents' ? 'overview' : current);
    if (message) notify(message);
    if (wasVisible) requestAnimationFrame(() => {
      sheet.current?.querySelector<HTMLButtonElement>('.order-section-bar button[aria-pressed="true"]')?.focus();
    });
  }
  const sourceChanged = order.source_changed || intake?.source_changed;
  return <>
    <button class="order-back" type="button" aria-label="К списку заказов" onClick={back}>
      <span aria-hidden="true">‹ </span>К списку
    </button>
    <article class="owner-order-detail order-sheet" aria-label={'Заказ ' + order.vehicle} ref={sheet}>
      <div class="order-sheet-title"><span>Заказ {order.order_number}</span></div>
      <OrderSectionBar sections={sections} selected={section} change={choose} />
      <header class="order-detail-head">
        <h2>{order.vehicle}</h2>
        <span class={'owner-board-phase phase-' + state.tone}>{state.label}</span>
      </header>
      <div class="order-section-body" hidden={section !== 'overview'}>
        <dl class="order-facts">
          {[
            ['Источник', order.manager_label || orderAuthor(order)],
            ['Группа', order.vehicle_group_name],
            ['Цвет', order.colour], ['VIN', order.vin],
            ['План', order.planned_date && dayLabel(order.planned_date)],
            ['Срок', order.due_date && dayLabel(order.due_date)],
            ['Приоритет', order.priority === 'urgent' ? 'Срочный' : order.priority === 'high' ? 'Высокий' : null],
          ].map(([label, value]) => value && <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {order.manager_comment && <section class="order-manager-comment" aria-label="Комментарий менеджера">
          <h3>Комментарий менеджера</h3><p>{order.manager_comment}</p>
        </section>}
        {order.instructions && order.instructions !== order.manager_comment &&
          !(order.instructions_from_manager && order.manager_comment_updated_at) &&
          <p class="order-detail-instructions">{order.instructions}</p>}
        {sourceChanged && <p class="notice">{order.source_missing
          ? 'Строки больше нет в подключённой таблице. Сохранённый заказ остаётся в приложении.'
          : intake?.owner_managed || order.owner_managed
            ? 'Текст таблицы изменился после проверки владельцем. Выбранные работы сохранены.'
            : 'Текст таблицы менеджеров изменился. Проверьте актуальную заявку перед редактированием заказа.'}</p>}
        <section class="order-scope" aria-label="Состав заказа">
          <h3>Состав работ</h3>
          {order.tasks.length ? <ul>{order.tasks.map(task => <li key={task.id}>
            <span>{taskName(task)}</span><small>{statusText[task.status] || task.status}</small>
          </li>)}</ul> : <p class="muted">Работы пока не добавлены.</p>}
          {order.status !== 'cancelled' && <button type="button" class="button button-small" onClick={omit}>
            Добавить пропущенную выполненную работу
          </button>}
        </section>
        <footer class="order-sheet-footer">
          {workflow && ((workflow.can_return || workflow.can_close) ? handoff :
            (workflow.taken_at || workflow.handed_at || workflow.handoff_note || workflow.returned_at || workflow.return_note) &&
              <details class="order-handoff-history"><summary>История передачи автомобиля</summary>{handoff}</details>)}
          {published && !workflow && canClose && <fieldset class="order-legacy-decision" disabled={busy}>
            <label>Комментарий к закрытию (необязательно)
              <textarea value={closeNote} maxLength={1000} onInput={event => setCloseNote(event.currentTarget.value)} />
            </label>
            <button type="button" class="button button-primary" onClick={() => finish('close', order.version, closeNote.trim())}>Закрыть заказ</button>
          </fieldset>}
          <OwnerOrderNote client={client} orderId={order.id} />
          {cancelling && <form onSubmit={e => { e.preventDefault(); if (reason.trim()) finish('cancel', cancelVersion, reason.trim()); }}>
            <fieldset disabled={busy}>
              <legend>Отмена заказа</legend>
              <label>Причина<textarea ref={reasonField} required maxLength={2000} value={reason} onInput={e => setReason(e.currentTarget.value)} /></label>
              <p>Оставшиеся работы будут отменены. Выполненные сохранятся в истории.</p>
              {cancelVersion !== order.version && <button type="button" class="button" onClick={() => setCancel(order.version)}>Проверить актуальную версию</button>}
              <div class="button-row">
                <button class="button" disabled={cancelVersion !== order.version} type="submit">Подтвердить отмену</button>
                <button type="button" class="button" onClick={() => {
                  setCancel(null); requestAnimationFrame(() => cancelButton.current?.focus());
                }}>Оставить без изменений</button>
              </div>
            </fieldset>
          </form>}
          {error && <p role="alert">{error}</p>}
          <div class="order-footer-actions">
            <PhotoShortcut open={showPhotos} />
            {published && <button ref={cancelButton} type="button" class="order-cancel-link" disabled={busy || cancelling}
              onClick={() => { setCancel(order.version); setReason(''); }}>Отменить заказ</button>}
            <button type="button" class="order-cancel-link" disabled={busy || cancelling}
              onClick={() => void remove()}>Удалить заказ</button>
          </div>
        </footer>
      </div>
      <div class="order-section-body" hidden={section !== 'prices'}>
        <section class="owner-price-section" aria-labelledby="owner-price-heading">
          <h3 id="owner-price-heading">Прайс</h3>
          <JobPriceList order={order} prices={price} client={client} reload={financials} />
          {price && (price.commercial && order.status !== 'cancelled'
            ? <OwnerCommercial client={client} orderId={order.id} terms={price.commercial} summary={price}
                refresh={async () => { await refreshOrder(); await financials(); }} />
            : <Price value={price} />)}
          {priceError ? <p role="alert">Не удалось загрузить стоимость работ.{' '}
            <button type="button" class="button" onClick={() => void financials().catch(() => {})}>Повторить расчёт</button>
          </p> : !price && <p role="status">Загружаем стоимость работ…</p>}
          {canOfferGift && <div class="button-row owner-price-actions">
            <button type="button" class="button" onClick={() => edit(true)}>Выбрать подарок для клиента</button>
          </div>}
        </section>
        <OrderFilm key={'film-' + order.id} client={client} orderId={order.id} orderVersion={order.version} mutate={mutate} notify={notify} />
      </div>
      {visited.has('payroll') && <div hidden={section !== 'payroll'} class="order-section-body">
        <OrderPayroll order={order} staff={staff} client={client} mutate={mutate} />
      </div>}
      {visited.has('photos') && <div hidden={section !== 'photos'} class="order-section-body" ref={panel} tabIndex={-1}>
        <OrderPhotos key={order.id} client={client} orderId={order.id} upload={published} initialLoad />
      </div>}
      {order.status === 'closed' && visited.has('documents') && <div hidden={section !== 'documents'} class="order-section-body" ref={documents}>
        <OwnerAct order={order} client={client} price={price} refreshOrder={refreshOrder} refreshPrice={financials} close={closeAct} />
      </div>}
    </article>
  </>;
}
