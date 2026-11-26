import { useEffect, useRef, useState } from 'preact/hooks';
import { dayLabel, today, type GarageClient } from './shift-model';
import { decimal, hundredths } from './pay-model';
import { errorText, isConflict, read, type Staff } from './owner-model';

interface Rate { mechanic_id: string; name: string; effective_date: string; rate_bp: number }
interface Props { client: GarageClient; onSaved?: () => void }

function RateForm({ client, onSaved }: Props) {
  const [directory, setDirectory] = useState<{ staff: Staff[]; rates: Rate[] } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [mechanic, setMechanic] = useState('');
  const [day, setDay] = useState(today);
  const [value, setValue] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef({ payload: '', id: '' });
  const active = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    setLoadError(false);
    setDirectory(null);
    Promise.all([read<Staff[]>(client, 'garage_staff'), read<Rate[]>(client, 'garage_mechanic_rates')])
      .then(([staff, rates]) => {
        if (!Array.isArray(staff) || !Array.isArray(rates)) throw new Error();
        if (current) {
          setDirectory({ staff, rates });
          setMechanic(selected => staff.some(p => p.id === selected) ? selected : staff[0]?.id ?? '');
        }
      }).catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [client, reload]);
  const history = (directory?.rates ?? []).filter(r => r.mechanic_id === mechanic).sort((a, b) => b.effective_date.localeCompare(a.effective_date));
  const existing = history.find(row => row.effective_date === day);
  const currentRate = history.find(row => row.effective_date <= day);
  const bp = hundredths(value ?? (currentRate ? decimal(currentRate.rate_bp) : ''));

  async function save() {
    if (saving.current || !directory || !mechanic || !day || bp === null || bp > 10000) return;
    saving.current = true;
    setBusy(true);
    setFeedback('');
    const params = { p_mechanic_id: mechanic, p_effective_date: day, p_rate_bp: bp, p_expected_rate_bp: existing?.rate_bp ?? null };
    const payload = JSON.stringify(params);
    if (request.current.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    try {
      await read(client, 'garage_save_mechanic_rate', { ...params, p_request_id: request.current.id });
      request.current = { payload: '', id: '' };
      onSaved?.();
      if (active.current) {
        setFeedback('Ставка сохранена.');
        setValue(null);
        setReload(n => n + 1);
      }
    } catch (err) {
      if (active.current) {
        setFeedback(errorText(err));
        if (isConflict(err)) setReload(n => n + 1);
      }
    } finally {
      saving.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <>
    {loadError ? <p role="alert">Не удалось загрузить ставки. <button class="button" type="button" onClick={() => setReload(n => n + 1)}>Повторить</button></p>
      : !directory ? <p role="status">Загружаем ставки…</p> : !directory.staff.length ? <p>Нет активных механиков.</p> :
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy} class="payroll-rates">
          <label>Механик<select aria-label="Механик" value={mechanic} onChange={e => { setMechanic(e.currentTarget.value); setValue(null); setFeedback(''); }}>
            {directory.staff.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select></label>
          <label>Действует с<input type="date" required value={day} onInput={e => { setDay(e.currentTarget.value); setValue(null); setFeedback(''); }} /></label>
          <label>Ставка, %<input type="text" inputMode="decimal" required value={value ?? (currentRate ? decimal(currentRate.rate_bp) : '')}
            onInput={e => { setValue(e.currentTarget.value); setFeedback(''); }} /></label>
          <button type="submit" class="button" disabled={!day || bp === null || bp > 10000 || bp === existing?.rate_bp}>Сохранить ставку</button>
        </fieldset>
        {history.length > 0 && <ul class="payroll-rate-history" aria-label="История ставок">{history.map(r => <li key={r.effective_date}>
          С {dayLabel(r.effective_date)} · {Number(r.rate_bp / 100).toLocaleString('ru-RU')}%
        </li>)}</ul>}
      </form>}
    {feedback && <p role="status">{feedback}</p>}
  </>;
}

export function MechanicRates(props: Props) {
  const [open, setOpen] = useState(false);
  return <details class="mechanic-rates" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Ставки механиков</summary>
    {open && <RateForm {...props} />}
  </details>;
}
