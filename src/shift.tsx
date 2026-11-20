import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { confirmations, dayLabel, isTerminal, matchesVisit, participants, taskName, today, vehicleGroups, visibleProgress } from './shift-model';
import { compareOrderDays, formatOrderDay, orderDay, weekdayClass } from './order-calendar';
import type { Intake, Order, ShiftProps } from './shift-model';
import { TaskDetail } from './shift-task';
import { VehicleDetail, VehicleRow } from './shift-vehicle';
import { useVehicleActions } from './shift-vehicle-actions';

interface Snapshot { orders: Order[]; intakes: Intake[]; intakeFailed: boolean }
interface Attention { key: string; kind: string; closable?: boolean; taskId?: string; recordId: string; title: string; description: string; day: string }
const exceptionFilters = [ ['all','Все'], ['handoff','Переданы владельцу'], ['blocked','Приостановки'], ['intake','Заявки'], ['due','Сроки'], ['signoff','Подтверждения'], ['close','К закрытию'] ] as const;
function attentionItems(orders: Order[], intakes: Intake[]) {
  const items: Attention[] = [];
  const date = today();
  for (const order of orders) {
    if (order.status !== 'published') continue;
    const visit = { recordId: order.id, title: order.vehicle, day: orderDay(order) };
    if (order.vehicle_workflow?.state === 'review') {
      const { completed, unfinished } = visibleProgress(order);
      items.push({ ...visit, key:'handoff-' + order.id, kind:'handoff', closable:order.vehicle_workflow.can_close,
        description:`Передан владельцу · ${order.order_number} · Выполнено: ${completed} · Осталось: ${unfinished}` });
      continue;
    }
    const open = order.tasks.filter(task => !isTerminal(task));
    for (const task of open) {
      const progress = confirmations(task);
      const blocked = task.status === 'blocked' || participants(task).some(member => member.status === 'blocked');
      if (blocked) items.push({ ...visit, key: 'block-' + task.id, kind: 'blocked', taskId: task.id, description: `${taskName(task)} · Приостановлено` });
      if (progress.count && progress.count < progress.total) items.push({ ...visit, key: 'confirm-' + task.id, kind: 'signoff', taskId: task.id, description: `${taskName(task)} · ${progress.count} из ${progress.total} подтвердили` });
    }
    if (open.length && order.due_date && order.due_date <= date) {
      const caption = order.due_date === date ? 'Срок сегодня' : 'Просрочено';
      const deadline = order.due_date !== visit.day && 'Срок ' + dayLabel(order.due_date);
      items.push({ ...visit, key: 'due-' + order.id, kind: 'due',
        description: [caption, deadline, order.order_number].filter(Boolean).join(' · ') });
    }
    if (order.vehicle_workflow?.can_close) items.push({ ...visit, key: 'close-' + order.id, kind: 'close', description: `Работы завершены · ${order.order_number}` });
  }
  for (const intake of intakes) {
    if (intake.status !== 'pending' || intake.order_id) continue;
    items.push({ key: 'intake-' + intake.id, kind: 'intake', recordId: intake.id, day: orderDay(intake.suggested_order || {}),
      title: intake.latest?.vehicle || intake.original?.vehicle || 'Автомобиль не указан',
      description: [intake.source_name || 'Заявка менеджера', intake.row_numbers?.length ? `Строка ${intake.row_numbers.join(', ')}` : '', 'Нужна проверка'].filter(Boolean).join(' · ') });
  }
  const rank = ['handoff','blocked','due','intake','signoff','close'];
  return items.sort((a, b) => compareOrderDays(a.day, b.day) || rank.indexOf(a.kind) - rank.indexOf(b.kind));
}
function OwnerShift({ snapshot, openTask, openOrder }: { snapshot: Snapshot; openTask(id: string): void; openOrder(id?: string): void }) {
  const [filter, setFilter] = useState('all');
  const issues = useMemo(() => attentionItems(snapshot.orders, snapshot.intakes), [snapshot]);
  const inCategory = (item: Attention, category: string) =>
    category === 'all' || item.kind === category || (category === 'close' && item.closable);
  const shown = issues.filter(item => inCategory(item, filter));
  return <section class="shift-board" aria-label="Смена владельца">
    <div class="shift-section-heading"><h2>Требуют внимания</h2><span class="shift-count">{issues.length}</span></div>
    <div class="shift-filters" role="group" aria-label="Категории внимания">{exceptionFilters.map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
      {label}{id !== 'all' && <span>{id === 'intake' && snapshot.intakeFailed ? '—' : issues.filter(item => inCategory(item, id)).length}</span>}</button>)}</div>
    {snapshot.intakeFailed && <p class="shift-alert" role="status">Не удалось проверить заявки менеджеров. Обновите смену.</p>}
    {shown.length ? <ul class="shift-list">{shown.map(item => <li key={item.key} class={weekdayClass(item.day)}>
      <button type="button" class={`shift-row attention-${item.kind}`} data-shift-target={item.taskId || item.recordId} onClick={() => item.taskId ? openTask(item.taskId) : openOrder(item.recordId)}>
        <span class="shift-row-main"><strong>{item.title}</strong><small>{item.day && <><time dateTime={item.day}>{formatOrderDay(item.day)}</time> · </>}{item.description}</small></span>
        <span aria-hidden="true" class="shift-arrow">→</span>
      </button>
    </li>)}</ul>
      : <div class="shift-empty"><h3>{snapshot.intakeFailed && (filter === 'all' || filter === 'intake') ? 'Нет доступных записей' : 'В этой категории всё разобрано'}</h3></div>}
    <div class="shift-board-footer"><button type="button" class="button" onClick={() => openOrder()}>Все заказы</button></div>
  </section>;
}
export function ShiftView({ client, profile, section, recordId, navigate }: ShiftProps) {
  const owner = profile.role === 'admin';
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [seenAt, setSeenAt] = useState('');
  const generation = useRef(0);
  const previousRoute = useRef({section, recordId});
  const currentRoute = useRef({section, recordId});
  currentRoute.current = {section, recordId};
  const view = useRef<HTMLDivElement>(null);
  const trackedProfile = useRef(profile.id);
  const displayTime = useMemo(() => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Minsk', hour: '2-digit', minute: '2-digit' }), []);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    setBusy(true);
    try {
      const [orders, intakes] = await Promise.all([client.rpc('garage_list_orders'), owner
        ? Promise.resolve(client.rpc('garage_manager_intakes')).catch(() => ({ data: null, error: {} })) : Promise.resolve({ data: [], error: null })]);
      if (generation.current !== token) return;
      if (orders.error || !Array.isArray(orders.data)) throw orders.error || new Error('orders');
      const intakeFailed = Boolean(intakes.error) || !Array.isArray(intakes.data);
      setSnapshot({ orders: orders.data, intakes: intakeFailed ? [] : intakes.data as Intake[], intakeFailed });
      setSeenAt(displayTime.format(new Date()));
      setError('');
    } catch (reason) {
      if (generation.current !== token) return;
      const code = (reason as {code?: string})?.code;
      if (code === '42501' || code === 'PGRST301') setSnapshot(null);
      setError('Не удалось обновить данные смены. Проверьте подключение и повторите попытку.');
    } finally { if (generation.current === token) setBusy(false); }
  }, [client, owner, profile.id, displayTime]);
  const vehicle = useVehicleActions(client, online, refresh, id => {
    if (section === currentRoute.current.section && recordId === currentRoute.current.recordId) navigate(section, id);
  });
  useEffect(() => {
    trackedProfile.current = profile.id;
    setSnapshot(null); setSeenAt(''); setError(''); setSearch('');
    void refresh();
    const visibleRefresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) void refresh(); };
    const connection = () => { setOnline(navigator.onLine); if (navigator.onLine) void refresh(); };
    document.addEventListener('visibilitychange', visibleRefresh);
    window.addEventListener('online', connection); window.addEventListener('offline', connection);
    const interval = window.setInterval(visibleRefresh, 60000);
    return () => { ++generation.current; window.clearInterval(interval); document.removeEventListener('visibilitychange', visibleRefresh);
      window.removeEventListener('online', connection); window.removeEventListener('offline', connection); };
  }, [refresh, profile.id]);
  useEffect(() => { setSearch(''); }, [section]);
  useEffect(() => {
    const previous = previousRoute.current;
    previousRoute.current = {section, recordId};
    if (previous.section !== section || !previous.recordId) return;
    if (recordId && !snapshot?.orders.some(order => order.id === recordId && order.tasks.some(task => task.id === previous.recordId))) return;
    const handle = requestAnimationFrame(() => {
      const selector = `[data-shift-target="${CSS.escape(previous.recordId!)}"]`;
      const trigger = view.current?.querySelector<HTMLButtonElement>(selector);
      trigger?.focus({preventScroll:true});
    });
    return () => cancelAnimationFrame(handle);
  }, [section, recordId]);
  const orders = snapshot?.orders;
  const groups = useMemo(() => owner ? [] : vehicleGroups(section, orders || [], profile.id).map(group => ({
    ...group, orders:group.orders.filter(order => matchesVisit(order, search))
  })), [owner, section, orders, profile.id, search]);
  const taskOrder = recordId ? orders?.find(order => order.tasks.some(task => task.id === recordId)) : undefined;
  const task = taskOrder && taskOrder.tasks.find(task => task.id === recordId);
  const selectedVisit = !owner && recordId && orders?.find(order => order.id === recordId);
  const openTask = (id: string) => navigate(section, id);
  const listTitle = section === 'manager-orders' ? 'Общая очередь автомобилей' : section === 'history' ? 'История по автомобилям' : 'Автомобили смены';
  const locked = !online || !!error || vehicle.saving || !!vehicle.uncertain;
  if (trackedProfile.current !== profile.id) return <p role="status">Загружаем смену…</p>;
  return <div ref={view} class={`shift-workspace${recordId ? ' has-detail' : ''}`}>
    <div class="shift-toolbar"><span class="shift-hint">{seenAt ? `Обновлено в ${seenAt}` : busy ? 'Загружаем смену…' : 'Данные не загружены'}</span>
      <button type="button" class="button" disabled={busy || !online} onClick={() => void refresh()}>Обновить</button></div>
    {error && <p class="shift-alert" role="alert">{error}</p>}
    {vehicle.feedback && <div class={vehicle.feedback.error ? 'shift-alert' : 'shift-saved'} role="status">{vehicle.feedback.message}
      {vehicle.uncertain && <button class="button" type="button" disabled={!online || vehicle.saving} onClick={() => void vehicle.retry()}>Проверить отправку</button>}</div>}
    {snapshot && <div class={`shift-layout${recordId ? ' with-detail' : ''}`}><div class="shift-master" aria-label={owner ? 'Работа мастерской' : listTitle}>
      {owner ? <OwnerShift snapshot={snapshot} openTask={openTask} openOrder={id => navigate('orders', id)}/> : <>
        <div class="shift-search"><label htmlFor="shift-search">Поиск</label><input id="shift-search" type="search" value={search} placeholder="Автомобиль, VIN, заказ или работа" onInput={e => setSearch(e.currentTarget.value)}/></div>
        {groups.filter(group => group.orders.length).map(group => <section key={group.title} class="shift-board"><div class="shift-section-heading"><h2>{group.title}</h2><span class="shift-count">{group.orders.length}</span></div>
          <ul class="shift-list">{group.orders.map(order => <VehicleRow key={order.id} order={order} historyMechanic={section === 'history' ? profile.id : undefined} locked={locked} selected={recordId === order.id || taskOrder?.id === order.id}
            open={() => navigate(section, order.id)} take={() => void vehicle.run(order, 'take', order.version)}/>)}</ul></section>)}
        {groups.every(group => !group.orders.length) && <div class="shift-empty"><h2>{search ? 'Совпадений нет' : section === 'history' ? 'История пока пуста' : 'Автомобилей пока нет'}</h2>
          {search ? <button type="button" class="button" onClick={() => setSearch('')}>Очистить поиск</button> : section === 'shift' || section === 'assigned' ? <button type="button" class="button" onClick={() => navigate('manager-orders')}>Открыть общую очередь</button> : null}</div>}
      </>}
    </div>{recordId && <div class="shift-detail-slot">{selectedVisit ? <VehicleDetail key={selectedVisit.id} order={selectedVisit} profileId={profile.id} section={section} locked={locked} saving={vehicle.saving}
      openTask={openTask} close={() => navigate(section)} take={() => void vehicle.run(selectedVisit,'take',selectedVisit.version)} handoff={(version, note) => vehicle.run(selectedVisit,'handoff',version,note)}/>
      : taskOrder && task ? <TaskDetail key={task.id} row={{order:taskOrder,task}} profile={profile} online={online} current={!error && !vehicle.saving && !vehicle.uncertain} client={client} refresh={refresh}
        close={() => navigate(section, owner ? undefined : taskOrder.id)} openOrder={id => navigate('orders', id)}/>
      : <div class="shift-empty"><h2>Запись больше недоступна</h2><button type="button" class="button" onClick={() => navigate(section)}>К списку</button></div>}</div>}</div>}
  </div>;
}
