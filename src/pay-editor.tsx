import { useEffect, useRef, useState } from 'preact/hooks';
import type { GarageClient } from './shift-model';
import { decimal, hundredths, money, payRead, title, type PayItem } from './pay-model';

interface Props {
  item: PayItem;
  client: GarageClient;
  close(): void;
  saved(): Promise<void>;
}

export function PayEditor({ item, client, close, saved }: Props) {
  const [version, setVersion] = useState(item.version);
  const [pool, setPool] = useState(item.pool_kopeks === null ? '' : decimal(item.pool_kopeks));
  const [reason, setReason] = useState('');
  const [zero, setZero] = useState(false);
  const [parts, setParts] = useState<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    const final = item.candidates.filter(person => !person.former);
    for (const person of item.candidates) {
      const prior = item.shares.find(share => share.mechanic_id === person.mechanic_id);
      if (prior) result[person.mechanic_id] = decimal(prior.basis_points);
      else if (!person.former) result[person.mechanic_id] = final.length === 1 ? '100' : '';
    }
    return result;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [latest, setLatest] = useState<PayItem | null>(null);
  const request = useRef({ fingerprint: '', id: '' });
  const poolField = useRef<HTMLInputElement>(null);
  useEffect(() => { poolField.current?.focus(); }, []);
  const inFlight = useRef(false);
  const cents = hundredths(pool);
  const chosen = item.candidates.filter(person => person.mechanic_id in parts);
  const values = chosen.map(person => hundredths(parts[person.mechanic_id]));
  const total = values.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  const reasonNeeded = version > 0 || chosen.some(person => person.former);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (inFlight.current || latest) return;
    setError('');
    if (cents === null) return setError('Введите сумму в BYN, с точностью до копейки.');
    if (cents === 0 && !zero) return setError('Подтвердите нулевую сумму.');
    if (values.some(value => value === null || value > 10000) || total !== 10000)
      return setError('Укажите долю каждого выбранного механика. Сумма долей должна составлять 100%.');
    if (reasonNeeded && !reason.trim()) return setError('Укажите причину изменения или включения прежнего участника.');
    const args = {
      p_task_id: item.task_id, p_expected_version: version, p_pool_kopeks: cents,
      p_shares: chosen.map((person, index) => ({ mechanic_id: person.mechanic_id, basis_points: values[index] })),
      p_reason: reason.trim(), p_zero_confirmed: cents === 0 && zero
    };
    const fingerprint = JSON.stringify(args);
    if (request.current.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    inFlight.current = true;
    setSaving(true);
    try {
      await payRead(client, 'garage_pay_save', { ...args, p_request_id: request.current.id });
      await saved();
    } catch (failure) {
      if ((failure as { code?: string }).code === '40001') {
        try {
          const list = await payRead<PayItem[]>(client, 'garage_pay_worklist');
          const current = list.find(row => row.task_id === item.task_id);
          if (current) setLatest(current);
          setError('Распределение изменено в другой сессии. Ваш ввод сохранён.');
        } catch {
          setError('Распределение изменилось. Проверьте связь и повторите, чтобы получить последнюю версию.');
        }
      } else {
        setError('Сохранение не подтверждено. Проверьте связь и повторите с теми же данными.');
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function formerParticipation(id: string, included: boolean) {
    const next = { ...parts };
    if (included) next[id] = '';
    else delete next[id];
    setParts(next);
    setError('');
  }

  return <form class="pay-editor" onSubmit={submit} onInput={event => {
    const control = event.target;
    if (control instanceof HTMLInputElement && control.type === 'checkbox') return;
    if (!latest && error) setError('');
  }}>
    <fieldset disabled={saving}>
      <legend class="sr-only">{title(item)} · {item.vehicle}</legend>
      <label class="pay-pool">Сумма для распределения, BYN
        <input required ref={poolField} inputMode="decimal" autoComplete="off" value={pool}
          onInput={event => { setPool(event.currentTarget.value); setZero(false); }} />
      </label>
      {cents === 0 && <label class="pay-check"><input type="checkbox" checked={zero} required
        onChange={event => { setZero(event.currentTarget.checked); setError(''); }} /> Подтверждаю сумму 0,00 BYN</label>}
      <fieldset class="pay-shares"><legend>Доли механиков</legend>
        {item.candidates.map(person => <div key={person.mechanic_id} class="pay-person">
          {person.former && <label class="pay-check"><input type="checkbox" checked={person.mechanic_id in parts}
            onChange={event => formerParticipation(person.mechanic_id, event.currentTarget.checked)} />
            Включить прежнего участника · {person.name}</label>}
          {person.mechanic_id in parts && <label>Доля · {person.name}, %
            <input required inputMode="decimal" autoComplete="off" value={parts[person.mechanic_id]}
              onInput={event => setParts({ ...parts, [person.mechanic_id]: event.currentTarget.value })} />
          </label>}
        </div>)}
        <p class="muted">Сумма долей · {decimal(total)}%</p>
      </fieldset>
      <label>{reasonNeeded ? 'Причина распределения' : 'Примечание (необязательно)'}
        <textarea rows={2} maxLength={2000} required={reasonNeeded} value={reason}
          onInput={event => setReason(event.currentTarget.value)} />
      </label>
      {latest && <section class="pay-conflict" aria-label="Последняя сохранённая версия">
        <strong>Сохранённая версия {latest.version} · {latest.pool_kopeks === null ? 'Ожидает распределения' : money(latest.pool_kopeks)}</strong>
        <ul>{latest.shares.map(share => <li key={share.mechanic_id}>{share.name} · {decimal(share.basis_points)}% · {money(share.kopeks)}</li>)}</ul>
        <button class="button" type="button" onClick={() => { setVersion(latest.version); setLatest(null); setError(''); }}>Продолжить с моими значениями</button>
      </section>}
      <p role="status" class="pay-error">{error}</p>
      <div class="pay-buttons">
        <button class="button button-primary" type="submit" disabled={Boolean(latest)}>{saving ? 'Сохраняем…' : 'Сохранить распределение'}</button>
        <button class="button" type="button" onClick={close}>Закрыть</button>
      </div>
    </fieldset>
  </form>;
}
