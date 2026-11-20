import { useState, useRef } from 'preact/hooks';
import type { GarageClient } from './shift-model';
import { WORKS } from './catalogue.js';
import {
  availableWorks,
  errorText,
  hood,
  isConflict,
  type OwnerOrder,
  type Staff,
  type Mutate,
} from './owner-model';
import { Quote } from './owner-summary';

function minskDate(date: Date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const take = (type: string) => parts.find((p) => p.type === type)?.value;
  return take('year') + '-' + take('month') + '-' + take('day') + 'T' + take('hour') + ':' + take('minute');
}
function parseMinsk(value: string) {
  const desired = Date.parse(value + 'Z');
  let time = desired;
  for (let i = 0; i < 3 && Number.isFinite(time); i++) {
    const shown = minskDate(new Date(time));
    if (shown === value) return new Date(time);
    time += desired - Date.parse(shown + 'Z');
  }
  return null;
}
interface Props {
  order: OwnerOrder;
  staff: Staff[];
  client: GarageClient;
  mutate: Mutate;
  close: () => void;
  saved: () => Promise<void>;
  reload: () => Promise<OwnerOrder | null>;
}
export function Omission({ order, staff, client, mutate, close, saved, reload }: Props) {
  const [current, setCurrent] = useState(order),
    [code, setCode] = useState(''),
    [tint, setTint] = useState('');
  const [first, setFirst] = useState(''),
    [extra, setExtra] = useState<string[]>([]),
    [time, setTime] = useState(''),
    [note, setNote] = useState('');
  const [err, setErr] = useState(''),
    [stale, setStale] = useState(false),
    [pending, setPending] = useState(false);
  const busy = useRef(false);
  const existing = current.tasks.filter((t) => t.status !== 'cancelled');
  const taken = (code: string) =>
    existing.some((t) => t.work_code === code || (hood.has(code) && hood.has(t.work_code || '')));
  const options = code === 'W19' ? { tint_percent: Number(tint) } : {};
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy.current || stale) return;
    const date = parseMinsk(time);
    if (!date || date.getTime() > Date.now() || !note.trim() || taken(code)) {
      setErr('Проверьте выбранную работу, время в прошлом и причину.');
      return;
    }
    busy.current = true;
    setPending(true);
    setErr('');
    try {
      await mutate('garage_record_team_omission', {
        p_order_id: current.id,
        p_expected_version: current.version,
        p_work_code: code,
        p_options: options,
        p_mechanic_ids: [first, ...extra.filter((id) => id !== first)],
        p_completed_at: date.toISOString(),
        p_note: note.trim(),
      });
      await saved();
    } catch (error) {
      setErr(errorText(error));
      setStale(isConflict(error));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <form class="new-order-form completion-form" onSubmit={submit}>
      <fieldset class="order-form-fields" disabled={pending}>
        <legend>Добавление пропущенной выполненной работы</legend>
        <p>Автомобиль: {current.vehicle}</p>
        <p>В истории будет указано, что работу записал владелец.</p>
        <div class="form-grid">
          <label>
            Пропущенная работа из каталога
            <select
              id="completion-work"
              required
              value={code}
              onChange={(e) => {
                setCode(e.currentTarget.value);
                setTint('');
              }}
            >
              <option value="">Выберите работу</option>
              {WORKS.filter((w) => availableWorks(current.vehicle_group_code).includes(w.code)).map((w) => (
                <option key={w.code} value={w.code} disabled={taken(w.code)}>
                  {w.name}
                  {taken(w.code) ? ' · уже учтено' : ''}
                </option>
              ))}
            </select>
          </label>
          {code === 'W19' && (
            <label>
              Светопропускание
              <select required value={tint} onChange={(e) => setTint(e.currentTarget.value)}>
                <option value="">Выберите светопропускание</option>
                <option value="5">5%</option>
                <option value="15">15%</option>
              </select>
            </label>
          )}
          <label>
            Исполнитель
            <select required value={first} onChange={(e) => setFirst(e.currentTarget.value)}>
              <option value="">Выберите механика</option>
              {staff.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Дата и время выполнения
            <input
              type="datetime-local"
              required
              value={time}
              max={minskDate(new Date())}
              onInput={(e) => setTime(e.currentTarget.value)}
            />
          </label>
        </div>
        <p class="field-hint">Время мастерской · Минск</p>
        {staff.length > 1 && (
          <fieldset>
            <legend>Другие исполнители</legend>
            {staff
              .filter((s) => s.id !== first)
              .map((s) => (
                <label class="work-choice" key={s.id}>
                  <input
                    type="checkbox"
                    checked={extra.includes(s.id)}
                    onChange={(e) =>
                      setExtra(e.currentTarget.checked ? [...extra, s.id] : extra.filter((id) => id !== s.id))
                    }
                  />
                  {s.name}
                </label>
              ))}
          </fieldset>
        )}
        <label>
          Причина исправления
          <textarea required maxLength={2000} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        </label>
        <Quote
          client={client}
          group={current.vehicle_group_code}
          choices={
            code ? [{ work_code: code, options, assigned_to: null, mechanic_ids: [], instructions: '' }] : []
          }
        />
        {err && <p role="alert">{err}</p>}
        {stale && (
          <button
            type="button"
            class="button"
            onClick={async () => {
              try {
                const latest = await reload();
                if (latest) {
                  setCurrent(latest);
                  setStale(false);
                  setErr('Проверьте актуальный состав работ перед сохранением.');
                }
              } catch {
                setErr('Не удалось загрузить заказ.');
              }
            }}
          >
            Проверить актуальный заказ
          </button>
        )}
        <div class="button-row">
          <button class="button button-primary" disabled={pending || stale || taken(code)} type="submit">
            Записать выполненную работу
          </button>
          <button type="button" class="button" onClick={close}>
            Отмена
          </button>
        </div>
      </fieldset>
    </form>
  );
}
