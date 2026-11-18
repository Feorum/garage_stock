import { useEffect, useRef, useState } from 'preact/hooks';
import type { GarageClient, Profile } from './shift-model';
import { date, decimal, money, payRead, title, type PayItem, type Revision } from './pay-model';
import { PayEditor } from './pay-editor';
import './pay.css';

interface Props { client: GarageClient; profile: Profile }
type Filter = 'pending' | 'allocated' | 'all';

function History({ item, client }: { item: PayItem; client: GarageClient }) {
  const [rows, setRows] = useState<Revision[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState('loading');
    payRead<Revision[]>(client, 'garage_pay_history', { p_task_id: item.task_id }).then(data => {
      if (active) { setRows(data); setState('ready'); }
    }).catch(() => { if (active) setState('failed'); });
    return () => { active = false; };
  }, [client, item.task_id, item.version, attempt]);
  if (state === 'loading') return <p role="status">Загружаем историю…</p>;
  if (state === 'failed') return <p role="status">История недоступна. <button type="button" class="button" onClick={() => setAttempt(attempt + 1)}>Повторить</button></p>;
  return <ol class="pay-revisions">{rows.map(row => <li key={row.version}>
    <strong>{date(row.saved_at)} · {row.actor_name}</strong>
    <p>Версия {row.version} · {money(row.pool_kopeks)}</p>
    <ul>{row.shares.map(share => <li key={share.mechanic_id}>{share.name} · {decimal(share.basis_points)}% · {money(share.kopeks)}</li>)}</ul>
    {row.reason && <p>{row.reason}</p>}
  </li>)}</ol>;
}

function Worklist({ client }: { client: GarageClient }) {
  const [items, setItems] = useState<PayItem[]>([]);
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [notice, setNotice] = useState('');
  const active = useRef(false);
  const generation = useRef(0);
  const filterField = useRef<HTMLSelectElement>(null);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());

  async function refresh() {
    const loading = ++generation.current;
    setStatus('loading');
    try {
      const next = await payRead<PayItem[]>(client, 'garage_pay_worklist');
      if (active.current && loading === generation.current) { setItems(next); setStatus('ready'); }
    } catch { if (active.current && loading === generation.current) setStatus('failed'); }
  }
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; ++generation.current; }; }, [client]);
  const visible = items.filter(item => {
    const names = [item.order_number, item.work_name, item.vehicle, ...item.candidates.map(person => person.name)];
    return (filter === 'all' || (filter === 'pending') === (item.pool_kopeks === null))
      && names.some(name => name.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')));
  });
  const pending = items.filter(item => item.pool_kopeks === null).length;
  return <section class="pay-workspace" aria-label="Распределение оплаты">
    <div class="pay-toolbar">
      <label>Показать
        <select ref={filterField} value={filter} disabled={Boolean(editing)} onChange={event => setFilter(event.currentTarget.value as Filter)}>
          <option value="pending">Ожидают распределения ({pending})</option>
          <option value="allocated">Распределены ({items.length - pending})</option><option value="all">Все работы</option>
        </select>
      </label>
      <label>Поиск<input type="search" value={search} disabled={Boolean(editing)} placeholder="Автомобиль, заказ, механик"
        onInput={event => setSearch(event.currentTarget.value)} /></label>
      <button class="button" type="button" disabled={Boolean(editing) || status === 'loading'} onClick={() => { setNotice(''); void refresh(); }}>Обновить</button>
    </div>
    <div role="status">{status === 'loading' ? 'Загружаем работы…' : status === 'failed'
      ? 'Не удалось обновить список. Проверьте подключение и нажмите «Обновить».' : notice}</div>
    {status === 'ready' && !visible.length && <p class="pay-empty">{search ? 'По вашему запросу ничего не найдено.' :
      filter === 'pending' ? 'Все завершённые работы распределены. Новые появятся здесь после завершения.' : 'Подходящих завершённых работ пока нет.'}</p>}
    <ul class="pay-list">{visible.map(item => <li key={item.task_id} class="pay-card" data-task-id={item.task_id}>
      <div class="pay-summary">
        <div><p class="muted">{item.order_number} · {date(item.completed_at)} (Минск)</p><h2>{title(item)} · <span>{item.vehicle}</span></h2>
          <p>{item.candidates.filter(person => !person.former).map(person => person.name).join(', ')}</p></div>
        <strong>{item.pool_kopeks === null ? 'Ожидает распределения' : money(item.pool_kopeks)}</strong>
      </div>
      {item.shares.length > 0 && <ul class="pay-lines">{item.shares.map(share => <li key={share.mechanic_id}>
        <span>{share.name} {share.former && <small>(прежний участник)</small>}</span>
        <span>{decimal(share.basis_points)}% · {money(share.kopeks)}</span>
      </li>)}</ul>}
      {editing === item.task_id ? <PayEditor item={item} client={client} close={() => {
        setEditing(null);
        requestAnimationFrame(() => actionRefs.current.get(item.task_id)?.focus());
      }} saved={async () => {
        if (!active.current) return;
        setEditing(null); setNotice('Распределение сохранено.'); await refresh();
        requestAnimationFrame(() => (actionRefs.current.get(item.task_id) ?? filterField.current)?.focus());
      }} /> : <div class="pay-buttons">
        <button type="button" class={item.version === 0 ? 'button button-primary' : 'button'} disabled={Boolean(editing) || status !== 'ready'}
          ref={button => { if (button) actionRefs.current.set(item.task_id, button); else actionRefs.current.delete(item.task_id); }}
          onClick={() => { setEditing(item.task_id); setNotice(''); }}>{item.version === 0 ? 'Распределить' : 'Изменить распределение'}</button>
        {item.version > 0 && <button type="button" class="button" aria-expanded={history === item.task_id}
          onClick={() => setHistory(history === item.task_id ? null : item.task_id)}>История изменений</button>}
      </div>}
      {history === item.task_id && <History item={item} client={client} />}
    </li>)}</ul>
  </section>;
}

export function PayView({ client, profile }: Props) {
  return profile.role === 'admin' ? <Worklist key={profile.id} client={client} /> : null;
}
