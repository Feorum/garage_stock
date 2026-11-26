import { useEffect, useRef, useState } from 'preact/hooks';
import { dayLabel, instantLabel, taskName, type GarageClient } from './shift-model';
import { decimal, hundredths, money } from './pay-model';
import { errorText, isConflict, read, type Mutate, type OwnerOrder, type Staff } from './owner-model';
import { MechanicRates } from './mechanic-rates';
import './order-payroll.css';

type Amount = number | null;
interface Person { mechanic_id: string; name: string }
interface Worker extends Person { automatic_kopeks: Amount; override_kopeks: Amount; kopeks: Amount }
interface Line { task_id: string; work_date: string; basis_kopeks: Amount; manual_shares?: {mechanic_id: string}[] | null; people: (Person & { rate_bp: Amount })[] }
interface Payroll {
  applicable: boolean; historical?: boolean; closed: boolean; version: number; token: string;
  prep_ids: string[]; heat_ids: string[]; people: Worker[]; lines: Line[];
  basis_kopeks: Amount; cap_kopeks: Amount; total_kopeks: Amount; excess_kopeks: Amount;
  reserve_kopeks: Amount; automatic_reserve_kopeks: Amount; override_reserve_kopeks: Amount;
  additional_kopeks: Amount; automatic_additional_kopeks: Amount; override_additional_kopeks: Amount;
  missing_rates: (Person & {work_date: string})[]; missing_prices?: string[];
  history: { version: number; actor_name: string; saved_at: string; operation: string; total_kopeks?: Amount;
    people?: Worker[]; reserve_kopeks?: Amount; additional_kopeks?: Amount }[];
}
interface SaveArgs {
  p_prep_ids: string[]; p_heat_ids: string[]; p_amounts: { mechanic_id: string; kopeks: number }[];
  p_reserve_kopeks: Amount; p_additional_kopeks: Amount;
}
const fmt = (value: Amount | undefined) => value == null ? 'Уточняется' : money(value);
function savedInputs(model: Payroll): SaveArgs {
  return { p_prep_ids: model.prep_ids, p_heat_ids: model.heat_ids,
    p_reserve_kopeks: model.override_reserve_kopeks, p_additional_kopeks: model.override_additional_kopeks,
    p_amounts: model.people.flatMap(p => p.override_kopeks == null ? [] : [{ mechanic_id: p.mechanic_id, kopeks: p.override_kopeks }]) };
}
function retainedOverrides(lines: Line[], inputs: SaveArgs) {
  const participants = new Set([...inputs.p_prep_ids, ...inputs.p_heat_ids,
    ...lines.flatMap(line => (line.manual_shares ?? line.people).map(p => p.mechanic_id))]);
  return inputs.p_amounts.filter(p => participants.has(p.mechanic_id));
}
function RoleField({ name, ids, change, roster, disabled }: { disabled: boolean; name: string; ids: string[]; change(ids: string[]): void; roster: Staff[] }) {
  return <fieldset class="payroll-role" disabled={disabled}><legend>{name} · 3%</legend>
    {ids.length ? <button type="button" class="button" onClick={() => change([])}>Снять отметки</button> : <small>Не требовался этап</small>}
    {roster.map(p => <label key={p.id}><input type="checkbox" checked={ids.includes(p.id)} onChange={e =>
      change(e.currentTarget.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))} />{p.name}</label>)}
  </fieldset>;
}
interface Props { client: GarageClient; order: OwnerOrder; mutate: Mutate; staff: Staff[] }
interface Editor { token: string; inputs: SaveArgs; key: string; text: string }

function Calculation({ order, client, mutate, staff }: Props) {
  const [model, setModel] = useState<Payroll | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const mounted = useRef(false);
  const sending = useRef(false);
  const refresh = () => setReload(n => n + 1);
  useEffect(() => {
    mounted.current = true;
    const update = (event: Event) => { if ((event as CustomEvent).detail === order.id) refresh(); };
    window.addEventListener('garage-order-finance-updated', update);
    return () => { mounted.current = false; window.removeEventListener('garage-order-finance-updated', update); };
  }, [order.id]);
  useEffect(() => {
    const call = ++generation.current;
    setLoading(true);
    setFailed(false);
    read<Payroll>(client, 'garage_order_payroll', { p_order_id: order.id }).then(next => {
      if (typeof next?.applicable !== 'boolean') throw new Error();
      if (mounted.current && generation.current === call) setModel(next);
    }).catch(() => { if (mounted.current && generation.current === call) setFailed(true); })
      .finally(() => { if (mounted.current && generation.current === call) setLoading(false); });
  }, [client, order, reload]);
  function begin(key: string, value?: Amount) {
    if (!model) return;
    setMessage('');
    setEditor({ key, token: model.token, inputs: savedInputs(model), text: value == null ? '' : decimal(value) });
  }
  async function save(automatic = false) {
    if (!editor || !model || model.token !== editor.token || failed || loading || sending.current) return;
    const args = { ...editor.inputs };
    if (editor.key === 'roles') {
      args.p_amounts = retainedOverrides(model.lines, args);
    } else {
      const parsed = hundredths(editor.text);
      if (!automatic && parsed == null) return;
      const next = automatic ? null : parsed;
      if (editor.key === 'reserve') args.p_reserve_kopeks = next;
      else if (editor.key === 'additional') args.p_additional_kopeks = next;
      else {
        args.p_amounts = args.p_amounts.filter(row => row.mechanic_id !== editor.key);
        if (next !== null) args.p_amounts.push({ mechanic_id: editor.key, kopeks: next });
      }
    }
    sending.current = true;
    setBusy(true);
    setMessage('');
    try {
      const next = await mutate<Payroll>('garage_save_order_payroll', { p_order_id: order.id, p_expected_token: editor.token, ...args });
      if (mounted.current) {
        generation.current++;
        setModel(next); setLoading(false); setFailed(false); setEditor(null); setMessage('Расчёт сохранён.');
      }
    } catch (err) {
      if (mounted.current) {
        setMessage(errorText(err));
        if (isConflict(err)) refresh();
      }
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  if (failed && !model) return <p role="alert">Не удалось загрузить расчёт. <button type="button" class="button" onClick={refresh}>Повторить</button></p>;
  if (!model) return <p role="status">Загружаем расчёт…</p>;
  if (model.historical) return <p>Для этого заказа сохранён прежний порядок оплаты. <a href="#pay">Распределение по работам</a></p>;
  if (!model.applicable) return <p>Для этого заказа расчёт по ставкам не применяется.</p>;
  const stale = !!editor && editor.token !== model.token;
  const editable = !busy && !loading && !failed && !stale;
  const roster = new Map(staff.map(p => [p.id, p]));
  for (const p of model.people) if (!roster.has(p.mechanic_id)) roster.set(p.mechanic_id, { id: p.mechanic_id, name: p.name });
  const names = (ids: string[]) => ids.map(id => roster.get(id)?.name || 'Прежний исполнитель').join(', ') || 'Не требовался этап';
  const service = (id: string) => { const task = order.tasks.find(t => t.id === id); return task ? taskName(task) : 'Работа'; };
  const selected = model.people.find(p => p.mechanic_id === editor?.key);
  const amount = editor ? hundredths(editor.text) : null;
  const pendingExcess = selected && amount != null && selected.kopeks != null && model.cap_kopeks != null && model.total_kopeks != null
    ? Math.max(0, model.total_kopeks - selected.kopeks + amount - model.cap_kopeks) : 0;
  function row(label: string, key: string, current: Amount, auto: Amount, override: Amount) {
    return <div key={key} class="payroll-amount-row"><dt>{label}</dt><dd>
      <button class="payroll-amount" type="button" disabled={!!editor || !editable} aria-label={'Изменить сумму · ' + label}
        onClick={() => begin(key, current)}>{fmt(current)}</button>
      {override != null && <small>Вручную · расчёт {fmt(auto)}</small>}
    </dd></div>;
  }
  return <div class="payroll-calculation">
    {failed && <p role="alert">Не удалось обновить расчёт. <button type="button" class="button" onClick={refresh}>Повторить</button></p>}
    {(!model.closed || model.missing_prices?.length || model.missing_rates.length) ? <p class="muted">Предварительный расчёт по выполненным работам.</p> : null}
    {model.missing_prices?.length ? <p class="notice">Для расчёта нужны цены работ: {model.missing_prices.map(service).join(', ')}.</p> : null}
    {model.missing_rates.length > 0 && <p class="notice">Укажите ставки на дату работы: {model.missing_rates.map(r => r.name + ' · ' + dayLabel(r.work_date)).join(', ')}.</p>}
    <dl class="payroll-amounts">
      <div><dt>Внутренняя «Цена» выполненных работ</dt><dd>{fmt(model.basis_kopeks)}</dd></div>
      <div><dt>Потолок выплат · 25%</dt><dd>{fmt(model.cap_kopeks)}</dd></div>
      {model.people.map(p => row(p.name, p.mechanic_id, p.kopeks, p.automatic_kopeks, p.override_kopeks))}
      <div><dt>Всего исполнителям</dt><dd>{fmt(model.total_kopeks)}</dd></div>
      {row('Премиальный фонд · 5%', 'reserve', model.reserve_kopeks, model.automatic_reserve_kopeks, model.override_reserve_kopeks)}
      {row('доп прем', 'additional', model.additional_kopeks, model.automatic_additional_kopeks, model.override_additional_kopeks)}
      <div><dt>Всего в премиальный фонд</dt><dd>{fmt(model.reserve_kopeks == null || model.additional_kopeks == null ? null : model.reserve_kopeks + model.additional_kopeks)}</dd></div>
    </dl>
    {(model.excess_kopeks ?? 0) > 0 && <p class="notice">Выплаты выше потолка на {fmt(model.excess_kopeks)}.</p>}
    <dl class="payroll-roles"><div><dt>Подготовка</dt><dd>{names(model.prep_ids)}</dd></div><div><dt>Загрев</dt><dd>{names(model.heat_ids)}</dd></div></dl>
    {!editor && <button type="button" class="button" disabled={!editable} onClick={() => begin('roles')}>Выбрать исполнителей подготовки и загрева</button>}
    {editor && <form class="payroll-editor" onSubmit={e => { e.preventDefault(); void save(); }}>
      {editor.key === 'roles' ? <div class="payroll-role-grid">{(['p_prep_ids', 'p_heat_ids'] as const).map(field =>
        <RoleField key={field} name={field === 'p_prep_ids' ? 'Подготовка' : 'Загрев'} ids={editor.inputs[field]} roster={[...roster.values()]} disabled={busy}
          change={ids => setEditor({ ...editor, inputs: { ...editor.inputs, [field]: ids } })} />)}</div>
        : <label>{selected?.name ?? (editor.key === 'additional' ? 'доп прем' : 'Премиальный фонд')}, BYN
          <input type="text" inputMode="decimal" required disabled={busy} value={editor.text} onInput={e => setEditor({ ...editor, text: e.currentTarget.value })} />
        </label>}
      {editor.key === 'roles' && retainedOverrides(model.lines, editor.inputs).length < editor.inputs.p_amounts.length && <p class="notice">Ручная выплата снятому исполнителю будет удалена из нового расчёта.</p>}
      {pendingExcess > 0 && <p class="notice">После сохранения выплаты превысят потолок на {money(pendingExcess)}.</p>}
      {stale && <p role="alert">Расчёт изменился. Проверьте актуальные суммы и откройте правку заново.</p>}
      <div class="button-row"><button class="button button-primary" type="submit" disabled={!editable || (editor.key !== 'roles' && amount == null)}>Сохранить расчёт</button>
        {editor.key !== 'roles' && <button class="button" type="button" disabled={!editable} onClick={() => void save(true)}>По расчёту</button>}
        <button class="button" type="button" disabled={busy} onClick={() => { setEditor(null); setMessage(''); }}>Отмена</button></div>
    </form>}
    {model.lines.length > 0 && <details><summary>Работы и ставки на дату выполнения</summary>
      <ul>{model.lines.map(line => <li key={line.task_id}><strong>{service(line.task_id)}</strong> · {dayLabel(line.work_date)} · {fmt(line.basis_kopeks)}
        <p>{line.people.map(p => p.name + (p.rate_bp == null ? ' · ставка не задана' : ' · ' + (p.rate_bp / 100).toLocaleString('ru-RU') + '%')).join(', ')}</p></li>)}</ul>
    </details>}
    <MechanicRates client={client} onSaved={refresh} />
    {model.history.length > 0 && <details><summary>История расчёта</summary><ol>{model.history.map(h => <li key={h.version}>
      {instantLabel(h.saved_at)} · {h.actor_name} · {h.operation === 'close' ? 'Закрытие' : 'Изменение'} · версия {h.version}
      {h.total_kopeks != null && <p>Исполнителям · {money(h.total_kopeks)}</p>}
      {h.people?.length ? <ul>{h.people.map(p => <li key={p.mechanic_id}>{p.name} · {fmt(p.kopeks)}</li>)}</ul> : null}
      {h.reserve_kopeks != null && <p>Премиальный фонд · {fmt(h.reserve_kopeks)}. Доп прем · {fmt(h.additional_kopeks)}</p>}
    </li>)}</ol></details>}
    {message && <p role="status">{message}</p>}
  </div>;
}
export function OrderPayroll(props: Props) {
  const [open, setOpen] = useState(() => location.hash === '#orders/' + encodeURIComponent(props.order.id) + '/payroll');
  return <details open={open} class="order-payroll" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Выплаты и премиальный фонд</summary>
    {open && <Calculation {...props} />}
  </details>;
}
