import { h } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { confirmations, dayLabel, finishedAt, isTerminal, matchesWork, mayJoin, mine, participantLabel, participants, sortWork, taskLabel, taskName, today } from './shift-model';
import type { Intake, Order, ShiftProps, TaskRow } from './shift-model';
import { TaskDetail } from './shift-task';

interface Group { title: string; rows: TaskRow[] }
interface Snapshot { orders: Order[]; intakes: Intake[]; intakeFailed: boolean }
interface Attention { key: string; kind: string; taskId?: string; recordId: string; title: string; description: string }
const exceptionFilters = [ ['all','Все'], ['blocked','Приостановки'], ['intake','Заявки'], ['due','Сроки'], ['signoff','Подтверждения'], ['close','К закрытию'] ] as const;
function attentionItems(orders: Order[], intakes: Intake[]) {
  const items: Attention[] = [];
  const date = today();
  for (const order of orders) {
    if (order.status !== 'published') continue;
    const open = order.tasks.filter(task => !isTerminal(task));
    for (const task of open) {
      const progress = confirmations(task);
      const blocked = task.status === 'blocked' || participants(task).some(member => member.status === 'blocked');
      if (blocked) items.push({ key: 'block-' + task.id, kind: 'blocked', taskId: task.id, recordId: order.id, title: order.vehicle, description: `${taskName(task)} · Приостановлено` });
      if (progress.count && progress.count < progress.total) items.push({ key: 'confirm-' + task.id, kind: 'signoff', taskId: task.id, recordId: order.id, title: order.vehicle, description: `${taskName(task)} · ${progress.count} из ${progress.total} подтвердили` });
    }
    if (open.length && order.due_date && order.due_date <= date) items.push({ key: 'due-' + order.id, kind: 'due', recordId: order.id, title: order.vehicle,
      description: `${order.due_date === date ? 'Срок сегодня' : 'Просрочено'} · ${dayLabel(order.due_date)} · ${order.order_number}` });
    if (!open.length && order.tasks.some(task => task.status === 'completed')) items.push({ key: 'close-' + order.id, kind: 'close', recordId: order.id, title: order.vehicle, description: `Работы завершены · ${order.order_number}` });
  }
  for (const intake of intakes) {
    if (intake.status !== 'pending' || intake.order_id) continue;
    items.push({ key: 'intake-' + intake.id, kind: 'intake', recordId: intake.id, title: intake.latest?.vehicle || intake.original?.vehicle || 'Автомобиль не указан',
      description: [intake.source_name || 'Заявка менеджера', intake.row_numbers?.length ? `Строка ${intake.row_numbers.join(', ')}` : '', 'Нужна проверка'].filter(Boolean).join(' · ') });
  }
  const rank = ['blocked','due','intake','signoff','close'];
  return items.sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind));
}
function OwnerShift({ snapshot, openTask, openOrder }: { snapshot: Snapshot; openTask(id: string): void; openOrder(id?: string): void }) {
  const [filter, setFilter] = useState('all');
  const issues = useMemo(() => attentionItems(snapshot.orders, snapshot.intakes), [snapshot]);
  const shown = issues.filter(item => filter === 'all' || item.kind === filter);
  return <section class="shift-board" aria-label="Смена владельца">
    <div class="shift-section-heading"><h2>Требуют внимания</h2><span class="shift-count">{issues.length}</span></div>
    <div class="shift-filters" role="group" aria-label="Категории внимания">{exceptionFilters.map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
      {label}{id !== 'all' && <span>{id === 'intake' && snapshot.intakeFailed ? '—' : issues.filter(item => item.kind === id).length}</span>}</button>)}</div>
    {snapshot.intakeFailed && <p class="shift-alert" role="status">Не удалось проверить заявки менеджеров. Обновите смену.</p>}
    {shown.length ? <ul class="shift-list">{shown.map(item => <li key={item.key}><button type="button" class={`shift-row attention-${item.kind}`} data-shift-target={item.taskId || item.recordId} onClick={() => item.taskId ? openTask(item.taskId) : openOrder(item.recordId)}>
      <span class="shift-row-main"><strong>{item.title}</strong><small>{item.description}</small></span><span aria-hidden="true" class="shift-arrow">→</span></button></li>)}</ul>
      : <div class="shift-empty"><h3>{snapshot.intakeFailed && (filter === 'all' || filter === 'intake') ? 'Нет доступных записей' : 'В этой категории всё разобрано'}</h3></div>}
    <div class="shift-board-footer"><button type="button" class="button" onClick={() => openOrder()}>Все заказы</button></div>
  </section>;
}
function groupsFor(section: ShiftProps['section'], rows: TaskRow[], id: string): Group[] {
  const active = rows.filter(({order, task}) => order.status === 'published' && !isTerminal(task));
  if (section === 'manager-orders') return [
    { title: 'Доступны для участия', rows: sortWork(active.filter(row => mayJoin(row, id))) },
    { title: 'Уже в работе', rows: sortWork(active.filter(row => row.order.source === 'manager' && !mayJoin(row, id) && participants(row.task).length > 0)) }
  ];
  const history = { title: 'Ваши подтверждения', rows: rows.filter(({task}) => mine(task, id) === 'confirmed' && task.status !== 'cancelled')
    .sort((a, b) => finishedAt(b.task, id).localeCompare(finishedAt(a.task, id))) };
  if (section === 'history') return [history];
  const own = sortWork(active.filter(({order, task}) => mine(task, id) && (section !== 'assigned' || order.source === 'owner')));
  return [
    { title: 'В работе', rows: own.filter(({task}) => mine(task, id) === 'working') },
    { title: 'Приостановлено', rows: own.filter(({task}) => mine(task, id) === 'blocked') },
    { title: 'Назначено', rows: own.filter(({task}) => mine(task, id) === 'assigned') },
    section === 'my-work' ? history : { title: 'Ожидаем команду', rows: own.filter(({task}) => mine(task, id) === 'confirmed') }
  ];
}
function TaskButton({ row, id, selected, showTeam, onClick }: { row: TaskRow; id: string; selected: boolean; showTeam: boolean; onClick(): void }) {
  const { task, order } = row;
  const status = mine(task, id);
  const signoff = confirmations(task);
  const names = showTeam ? participants(task).map(person => person.name || 'Механик') : [];
  return <button type="button" class={`shift-row${selected ? ' is-selected' : ''}`} data-shift-target={task.id} aria-current={selected ? 'true' : undefined} onClick={onClick}>
    <span class="shift-row-main"><small class="shift-code">{order.order_number}{order.priority === 'urgent' ? ' · Срочно' : order.priority === 'high' ? ' · Высокий приоритет' : ''}</small>
      <strong>{taskName(task)}</strong><span>{order.vehicle}</span>{names.length > 0 && <small>Команда: {names.slice(0,2).join(', ')}{names.length > 2 ? ` и ещё ${names.length - 2}` : ''}</small>}</span>
    <span class="shift-row-end"><span class={`task-status ${status ? 'member-' + status : 'status-' + task.status}`}>{status ? participantLabel[status] : taskLabel[task.status]}</span>
      {signoff.total > 1 ? <small>{signoff.count} из {signoff.total} подтвердили</small> : order.due_date ? <small>Срок {dayLabel(order.due_date)}</small> : null}</span>
    <span class="shift-arrow" aria-hidden="true">→</span>
  </button>;
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
    if (recordId || previous.section !== section || !previous.recordId) return;
    const handle = requestAnimationFrame(() => {
      const selector = `[data-shift-target="${CSS.escape(previous.recordId!)}"]`;
      const trigger = view.current?.querySelector<HTMLButtonElement>(selector);
      trigger?.focus({preventScroll:true});
    });
    return () => cancelAnimationFrame(handle);
  }, [section, recordId]);
  const rows = useMemo(() => (snapshot?.orders || []).flatMap(order => (order.tasks || []).map(task => ({ order, task }))), [snapshot]);
  const groups = useMemo(() => groupsFor(section, rows, profile.id).map(group => ({ ...group, rows: group.rows.filter(row => matchesWork(row, search)) })), [section, rows, profile.id, search]);
  const selected = recordId ? rows.find(({ task }) => task.id === recordId) : undefined;
  const detail = selected && (owner || mine(selected.task, profile.id) || (selected.order.source === 'manager' && selected.order.status === 'published' && !isTerminal(selected.task)));
  const openTask = (id: string) => navigate(section, id);
  const listTitle = section === 'manager-orders' ? 'Доступные работы' : section === 'history' ? 'История работ' : 'Задачи смены';
  if (trackedProfile.current !== profile.id) return <p role="status">Загружаем смену…</p>;
  return <div ref={view} class={`shift-workspace${recordId ? ' has-detail' : ''}`}>
    <div class="shift-toolbar"><span class="shift-hint">{seenAt ? `Обновлено в ${seenAt}` : busy ? 'Загружаем смену…' : 'Данные не загружены'}</span>
      <button type="button" class="button" disabled={busy || !online} onClick={() => void refresh()}>Обновить</button></div>
    {error && <p class="shift-alert" role="alert">{error}</p>}
    {snapshot && <div class={`shift-layout${recordId ? ' with-detail' : ''}`}><div class="shift-master" aria-label={owner ? 'Работа мастерской' : listTitle}>
      {owner ? <OwnerShift snapshot={snapshot} openTask={openTask} openOrder={id => navigate('orders', id)}/> : <>
        <div class="shift-search"><label htmlFor="shift-search">Поиск</label><input id="shift-search" type="search" value={search} placeholder="Работа, автомобиль, VIN или заказ" onInput={e => setSearch(e.currentTarget.value)}/></div>
        {groups.filter(group => group.rows.length).map(group => <section key={group.title} class="shift-board"><div class="shift-section-heading"><h2>{group.title}</h2><span class="shift-count">{group.rows.length}</span></div>
          <ul class="shift-list">{group.rows.map(row => <li key={row.task.id} data-task-id={row.task.id}><TaskButton row={row} id={profile.id} selected={recordId === row.task.id} showTeam={section === 'manager-orders'} onClick={() => openTask(row.task.id)}/></li>)}</ul></section>)}
        {groups.every(group => !group.rows.length) && <div class="shift-empty"><h2>{search ? 'Совпадений нет' : section === 'manager-orders' ? 'Свободных работ пока нет' : section === 'history' ? 'Подтверждений пока нет' : 'У вас нет текущих задач'}</h2>
          {search ? <button type="button" class="button" onClick={() => setSearch('')}>Очистить поиск</button> : section === 'shift' || section === 'assigned' ? <button type="button" class="button" onClick={() => navigate('manager-orders')}>Открыть общую очередь</button> : null}</div>}
      </>}
    </div>{recordId && <div class="shift-detail-slot">{detail && selected ? <TaskDetail key={selected.task.id} row={selected} profile={profile} online={online} current={!error} client={client} refresh={refresh} close={() => navigate(section)} openOrder={id => navigate('orders', id)}/> : <div class="shift-empty"><h2>Работа больше недоступна</h2><button type="button" class="button" onClick={() => navigate(section)}>К списку</button></div>}</div>}</div>}
  </div>;
}
