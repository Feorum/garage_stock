import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GarageClient } from './shift-model';
import { equalAmounts, hundredths, initialAmounts, money, payRead, type PayEditorItem } from './pay-model';

interface Props {
  item: PayEditorItem;
  client: GarageClient;
  unavailable?: boolean;
  close(): void;
  saved(): Promise<void>;
  reloadItem(): Promise<PayEditorItem | null>;
}

const rosterKey = (item: PayEditorItem) => JSON.stringify(item.candidates.map(p => [p.mechanic_id, p.former]).sort());

export function PayEditor({ item, client, close, saved, reloadItem, unavailable }: Props) {
  const [base, setBase] = useState(item);
  const sourceAtMerge = useRef(item);
  const [amounts, setAmounts] = useState(() => initialAmounts(item));
  const [reason, setReason] = useState('');
  const [zero, setZero] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<PayEditorItem | 'reload' | 'unavailable' | null>(null);
  const request = useRef({ fingerprint: '', id: '' });
  const sending = useRef(false);
  const mounted = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    form.current?.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.focus();
    return () => { mounted.current = false; };
  }, []);

  const incoming = item.version > base.version || (item.version === base.version &&
    rosterKey(item) !== rosterKey(base) && rosterKey(item) !== rosterKey(sourceAtMerge.current));
  const latest = unavailable ? 'unavailable' : conflict ?? (incoming ? item : null);
  const chosen = base.candidates.filter(person => person.mechanic_id in amounts);
  const missing = base.shares.filter(person => !base.candidates.some(candidate => candidate.mechanic_id === person.mechanic_id));
  const filled = chosen.map(p => amounts[p.mechanic_id].trim()).filter(Boolean).map(hundredths);
  const subtotal = filled.reduce<number>((sum, n) => sum + (n ?? 0), 0);
  const valid = filled.every(n => n !== null) && subtotal <= 999999999999;
  const total = chosen.length && valid && filled.length === chosen.length ? subtotal : null;
  const needsReason = base.version > 0 || chosen.some(person => person.former);

  function change(next: Record<string, string>) {
    setAmounts(next);
    setZero(false);
    setError('');
  }
  async function loadCurrent() {
    try {
      const current = await reloadItem();
      if (mounted.current) setConflict(current || 'unavailable');
    } catch {
      if (mounted.current) setConflict('reload');
    }
  }
  function useCurrent(current: PayEditorItem) {
    const next = initialAmounts(current);
    // A new contributor needs an explicit amount; preserve all still-eligible draft rows.
    for (const p of current.candidates) {
      if (p.mechanic_id in amounts) next[p.mechanic_id] = amounts[p.mechanic_id];
      else if (!base.candidates.some(person => person.mechanic_id === p.mechanic_id) && !p.former) next[p.mechanic_id] = '';
      else if (p.former && base.candidates.some(person => person.mechanic_id === p.mechanic_id)) delete next[p.mechanic_id];
    }
    setBase(current);
    sourceAtMerge.current = item;
    request.current = { fingerprint: '', id: '' };
    setAmounts(next);
    setConflict(null);
    setAcknowledged(false);
    setZero(false);
    setError('');
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (sending.current || latest) return;
    if (total === null) return setError('Введите корректную сумму в BYN для каждого выбранного механика.');
    if (total === 0 && !zero) return setError('Подтвердите нулевую сумму.');
    if (missing.length && !acknowledged) return setError('Проверьте изменения состава механиков.');
    if (needsReason && !reason.trim()) return setError('Укажите причину изменения распределения.');
    const args = {
      p_task_id: base.task_id, p_expected_version: base.version,
      p_amounts: chosen.map(p => ({ mechanic_id: p.mechanic_id, kopeks: hundredths(amounts[p.mechanic_id])! })),
      p_reason: reason.trim(), p_zero_confirmed: total === 0 && zero,
    };
    const fingerprint = JSON.stringify(args);
    if (request.current.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    sending.current = true;
    setSaving(true);
    setError('');
    try {
      await payRead(client, 'garage_pay_save_amounts', { ...args, p_request_id: request.current.id });
      if (mounted.current) await saved();
    } catch (failure) {
      if (!mounted.current) return;
      const issue = failure as {code?: string};
      if (issue.code === '40001') {
        setConflict('reload');
        await loadCurrent();
      } else if (issue.code === '42501') setError('Для сохранения нужен доступ владельца.');
      else if (issue.code === '22023') setError('Проверьте введённые суммы, состав механиков и причину изменения.');
      else setError('Сохранение не подтверждено. Проверьте связь и повторите с теми же данными.');
    } finally {
      sending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return <form ref={form} class="pay-editor" onSubmit={submit}>
    <fieldset disabled={saving}>
      <legend>Оплата механикам</legend>
      {base.candidates.map(person => <div key={person.mechanic_id} class="pay-person">
        {person.former && <label class="pay-check"><input type="checkbox" checked={person.mechanic_id in amounts}
          onChange={event => {
            const next = { ...amounts };
            if (event.currentTarget.checked) next[person.mechanic_id] = '';
            else delete next[person.mechanic_id];
            change(next);
          }} /> Включить прежнего участника · {person.name}</label>}
        {person.mechanic_id in amounts && <label class="pay-amount">
          <span>{person.name}</span>
          <span><input type="text" required inputMode="decimal" autoComplete="off" aria-label={person.name + ', BYN'}
            value={amounts[person.mechanic_id]} placeholder="—" onInput={e => change({...amounts, [person.mechanic_id]: e.currentTarget.value})} />
            <small aria-hidden="true">BYN</small></span>
        </label>}
      </div>)}
      <div class="pay-total">
        <strong>Итого механикам <output aria-label="Итого механикам">{total == null ? '—' : money(total)}</output></strong>
        {chosen.length > 1 && <button type="button" class="button button-small"
          disabled={!valid || !filled.length}
          onClick={() => change(equalAmounts(chosen.map(p => p.mechanic_id), subtotal))}>Разделить поровну</button>}
      </div>
      {total === 0 && <label class="pay-check"><input type="checkbox" checked={zero} required
        onChange={e => { setZero(e.currentTarget.checked); setError(''); }} /> Подтверждаю сумму 0,00 BYN</label>}
      {missing.length > 0 && <div class="pay-conflict">
        <p>В сохранённом распределении есть механики, которые больше не входят в состав этой работы.</p>
        <ul>{missing.map(p => <li key={p.mechanic_id}>{p.name} · {money(p.kopeks)}</li>)}</ul>
        <label class="pay-check"><input type="checkbox" checked={acknowledged} required onChange={e => setAcknowledged(e.currentTarget.checked)} />
          Сохранить новое распределение без этих механиков</label>
      </div>}
      {needsReason ? <label>Причина распределения<textarea rows={2} required maxLength={2000} value={reason}
        onInput={e => setReason(e.currentTarget.value)} /></label> : <details>
        <summary>Добавить примечание</summary>
        <textarea rows={2} aria-label="Примечание к распределению" maxLength={2000} value={reason} onInput={e => setReason(e.currentTarget.value)} />
      </details>}
      {latest && <section class="pay-conflict" aria-label="Последняя сохранённая версия">
        {typeof latest === 'object' ? <>
          <strong>Сохранённая версия {latest.version} · {latest.pool_kopeks === null ? 'Ожидает распределения' : money(latest.pool_kopeks)}</strong>
          <ul>{latest.shares.map(p => <li key={p.mechanic_id}>{p.name} · {money(p.kopeks)}</li>)}</ul>
          <p>Актуальный состав · {latest.candidates.filter(p => !p.former).map(p => p.name).join(', ')}</p>
          <button class="button" type="button" onClick={() => useCurrent(latest)}>Продолжить с моими значениями</button>
        </> : <>
          <p>{latest === 'unavailable' ? 'Работа больше недоступна для распределения.' : 'Распределение изменилось. Обновите данные работы.'}</p>
          <button class="button" type="button" onClick={() => void loadCurrent()}>Обновить данные</button>
        </>}
      </section>}
      <p role="alert" class="pay-error">{error}</p>
      <div class="work-decisions">
        <button class="button" type="button" onClick={close}>Закрыть</button>
        <button class="button button-primary" type="submit" disabled={Boolean(latest)}>{saving ? 'Сохраняем…' : 'Сохранить распределение'}</button>
      </div>
    </fieldset>
  </form>;
}
