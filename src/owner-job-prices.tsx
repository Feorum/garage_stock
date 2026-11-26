import { useRef, useState } from 'preact/hooks';
import { customerPrice, money, type PayEditorItem, type Payout } from './pay-model';
import { PayEditor } from './pay-editor';
import { PayHistory } from './pay';
import { TaskPricing } from './owner-pricing';
import { TaskManagement, type TaskManagementProps } from './owner-task-management';
import { statusText, type Money, type TaskPrice } from './owner-model';
import { participants, participantLabel, taskName, instantLabel, type GarageClient } from './shift-model';
import { ExecutorMarker } from './executor-marker';

type JobProps = TaskManagementProps & {
  client: GarageClient;
  price?: TaskPrice;
  loaded: boolean;
  refreshPrice(): Promise<Money>;
};
type Panel = 'price' | 'payout' | 'history' | 'team';

function payItem(taskId: string, payout?: Payout | null): PayEditorItem | null {
  if (!payout || payout.order_payroll || payout.version == null || !payout.candidates) return null;
  return { ...payout, task_id: taskId, version: payout.version, candidates: payout.candidates };
}

function findPrice(data: Money | null, taskId: string) {
  return (data?.tasks || data?.items)?.find(row => row.task_id === taskId);
}

function OrderJob(props: JobProps) {
  const { task, price, loaded, refreshPrice, client, order, notify } = props;
  const [panel, setPanel] = useState<Panel | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const openedPay = useRef<PayEditorItem | null>(null);
  const heading = useRef<HTMLTableCellElement>(null);
  const panelId = 'job-panel-' + task.id;
  const cancelled = task.status === 'cancelled';
  const payout = task.status === 'completed' ? price?.payout : null;
  const editablePay = payItem(task.id, payout);
  const draftPay = editablePay ?? openedPay.current;
  const allocated = payout?.pool_kopeks != null;
  const members = participants(task);
  const priceForCustomer = price ? customerPrice(price) : null;
  const catalogue = price?.catalogue_kopeks !== undefined
    ? price.catalogue_kopeks
    : price?.net_amount == null ? null : Math.round(price.net_amount * 100);
  const payAmount = payout?.pool_kopeks ?? payout?.suggested_pool_kopeks;
  const shares = allocated ? payout?.shares : null;
  const hasTeamDetails = task.notes?.some(n => n.note)
    || (order.status === 'published' && !cancelled && task.status !== 'completed');

  function close() {
    setPanel(null);
    requestAnimationFrame(() => {
      const target = trigger.current?.isConnected ? trigger.current : heading.current;
      target?.focus({ preventScroll: true });
    });
  }
  function control(target: Panel, label: string, compact = label) {
    return <button key={target} type="button" class="job-link" aria-label={label}
      aria-expanded={panel === target} aria-controls={panel === target ? panelId : undefined}
      disabled={(panel === 'price' && Boolean(price) && !cancelled) || (panel === 'payout' && Boolean(draftPay))}
      onClick={e => {
        if (panel === target) return close();
        if (target === 'payout') openedPay.current = editablePay;
        trigger.current = e.currentTarget;
        setPanel(target);
      }}>{compact}</button>;
  }
  const unavailable = loaded ? 'Не указана' : '—';
  return <tbody data-task-id={task.id}>
    <tr class={'order-job' + (cancelled ? ' is-cancelled' : '')}>
      <th scope="row" ref={heading} tabIndex={-1}>
        <strong class="job-name">{taskName(task)}</strong>
        <small class="job-state">{statusText[task.status]}{task.completed_at && ' · ' + instantLabel(task.completed_at)}</small>
        {task.instructions && <p class="job-instruction">{task.instructions}</p>}
        {task.blocker_reason && task.status === 'blocked' && <p>{task.blocker_reason}</p>}
        {members.length > 0 && <div class="job-team">{members.map(m =>
          <small key={m.mechanic_id}>
            {m.status === 'confirmed' ? <ExecutorMarker name={m.name} id={m.mechanic_id} color={m.color} /> : m.name} · {participantLabel[m.status]}
          </small>)}</div>}
        {members.some(m => m.confirmation_origin === 'owner_recorded') && <small>Выполнение записано владельцем</small>}
        {hasTeamDetails && control('team', 'Команда и заметки')}
      </th>
      <td data-column="catalogue">
        <span class="job-column-label" aria-hidden="true">По прайсу</span>
        <span class="job-amount">{catalogue == null ? cancelled ? '—' : unavailable : money(catalogue)}</span>
      </td>
      <td data-column="customer">
        <span class="job-column-label" aria-hidden="true">Для клиента</span>
        <span class="job-amount">{cancelled ? '—' : priceForCustomer == null ? unavailable : money(priceForCustomer)}</span>
        {cancelled ? <small>Исключена из итога</small> : <>
          {price?.private_comment && <p class="job-private-comment">{price.private_comment}</p>}
          {price?.private_version != null && control('price', 'Изменить стоимость', 'Изменить')}
        </>}
      </td>
      <td data-column="payout">
        <span class="job-column-label" aria-hidden="true">Механикам</span>
        <span class="job-amount">{payAmount == null ? payout?.order_payroll ? 'По заказу' : payout ? 'Нет ставки' : '—' : money(payAmount)}</span>
        {payout && !allocated && payAmount != null && <small>По ставке</small>}
        {!payout && !cancelled && <small>{task.status === 'completed' ? (loaded ? 'Нет расчёта' : '') : 'После выполнения'}</small>}
        {shares?.map(s => <small key={s.mechanic_id}>{s.name} · {money(s.kopeks)}</small>)}
        {payout?.order_payroll && <a class="job-link" href={'#orders/' + encodeURIComponent(order.id) + '/payroll'}>К выплатам заказа</a>}
        {editablePay && control('payout', allocated ? 'Изменить распределение' : 'Распределить', allocated ? 'Изменить' : 'Распределить')}
        {allocated && payout?.version != null && control('history', 'История изменений', 'История')}
      </td>
    </tr>
    {panel && <tr class="job-editor-row" id={panelId}><td colSpan={4}>
      {panel === 'price' && (price && !cancelled
        ? <TaskPricing client={client} taskId={task.id} value={price}
            onClose={message => { if (message) notify(message); close(); }}
            reload={async () => { await refreshPrice(); }} />
        : <div><p role="status">Работа больше недоступна для изменения стоимости.</p>
            <button type="button" class="button" onClick={close}>Закрыть</button></div>)}
      {panel === 'payout' && draftPay && <PayEditor client={client} item={draftPay} unavailable={!editablePay} close={close}
        reloadItem={async () => payItem(task.id, findPrice(await refreshPrice(), task.id)?.payout)}
        saved={async () => {
          try {
            await refreshPrice();
            notify('Распределение сохранено.');
          } catch {
            notify('Распределение сохранено. Обновите суммы в заказе.');
          }
          close();
        }} />}
      {panel === 'history' && payout?.version != null && <PayHistory client={client} taskId={task.id} version={payout.version} />}
      {panel === 'team' && <TaskManagement {...props} />}
    </td></tr>}
  </tbody>;
}

export function OrderJobPrices({ price, ...props }: Omit<JobProps, 'task' | 'price' | 'loaded'> & { price: Money | null }) {
  return <table class="order-price-list" aria-label="Работы и цены">
    <thead><tr><th scope="col">Работа</th><th scope="col">По прайсу</th>
      <th scope="col">Для клиента</th><th scope="col">Механикам</th></tr></thead>
    {props.order.tasks.map(task => <OrderJob key={task.id} {...props} task={task} loaded={price != null} price={findPrice(price, task.id)} />)}
  </table>;
}
