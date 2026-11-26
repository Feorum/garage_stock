import { useEffect, useRef, useState } from 'preact/hooks';
import { errorText, isConflict, type Mutate } from './owner-model';
import { decimal, hundredths, money } from './pay-model';
import { readRpc } from './workspace-rpc';
import type { Client } from './workspace-types';

type Mode = 'order' | 'works';
interface FilmLine {
  task_id: string;
  name: string;
  options?: { tint_percent?: number };
  price_kopeks: number | null;
  amount_kopeks: number | null;
}
interface Film {
  version: number;
  price_token: string;
  mode: Mode;
  order_price_kopeks: number | null;
  amount_kopeks: number | null;
  lines: FilmLine[];
  editable?: boolean;
  price_changed?: boolean;
}
interface FilmDraft {
  mode: Mode;
  amount: string;
  works: Record<string, string>;
  version: number;
  priceToken: string;
}

const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 2 });
const toInput = (kopeks: number | null) => kopeks == null ? '' : decimal(kopeks);

function filmDraft(data: Film): FilmDraft {
  return {
    mode: data.mode,
    amount: toInput(data.amount_kopeks),
    works: Object.fromEntries(data.lines.map(line => [line.task_id, toInput(line.amount_kopeks)])),
    version: data.version,
    priceToken: data.price_token,
  };
}

function FilmAmount({ label, value, price, onInput }: {
  label: string; value: string; price: number | null; onInput: (value: string) => void;
}) {
  const amount = hundredths(value);
  return <div class="owner-film-amount">
    <label>
      {label}
      <input type="text" inputMode="decimal" maxLength={13} value={value} onInput={e => onInput(e.currentTarget.value)} />
    </label>
    <span>Цена {price == null ? '—' : money(price)}</span>
    <output>{price && amount != null ? percent.format(amount / price) : '—'}</output>
  </div>;
}

async function downloadFilm(client: Client, signal: AbortSignal) {
  let size: number | undefined;
  let offset = 0;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  do {
    const response = await readRpc<{ size: number; data: string }>(client, 'garage_film_file', {
      p_offset: offset,
      p_length: size == null ? 262144 : Math.min(262144, size - offset),
    }, signal);
    size ??= response.size;
    const bytes = Uint8Array.from(atob(response.data), character => character.charCodeAt(0));
    if (offset + bytes.length > size || (!bytes.length && offset < size)) throw new Error('Invalid film file range');
    chunks.push(bytes);
    offset += bytes.length;
  } while (offset < size);
  if (signal.aborted) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(chunks, { type: 'application/x-ndjson' }));
  link.download = 'film-patterns.jsonl';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
}

function FilmForm({ client, orderId, orderVersion, mutate, notify }: {
  client: Client; orderId: string; orderVersion: number; mutate: Mutate; notify: (message: string) => void;
}) {
  const [data, setData] = useState<Film | null>(null);
  const [draft, setDraft] = useState<FilmDraft | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const requests = useRef<AbortController>();
  const file = useRef<AbortController>();
  const writing = useRef(false);

  async function load() {
    requests.current?.abort();
    const request = new AbortController();
    requests.current = request;
    setLoadError(false);
    try {
      const state = await readRpc<Film>(client, 'garage_order_film', { p_order_id: orderId }, request.signal);
      if (!request.signal.aborted) setData(state);
    } catch {
      if (!request.signal.aborted) setLoadError(true);
    }
  }

  useEffect(() => {
    void load();
    const financeChanged = (event: Event) => {
      if ((event as CustomEvent<string>).detail === orderId) void load();
    };
    window.addEventListener('garage-order-finance-updated', financeChanged);
    return () => {
      requests.current?.abort();
      window.removeEventListener('garage-order-finance-updated', financeChanged);
    };
  }, [client, orderId, orderVersion]);

  useEffect(() => () => file.current?.abort(), []);

  const values = draft || (data && filmDraft(data));
  const stale = !!draft && !!data && (draft.version !== data.version || draft.priceToken !== data.price_token);

  async function save(values: FilmDraft, lines: FilmLine[]) {
    if (writing.current || stale) return;
    setError('');
    const entries = values.mode === 'order'
      ? [['order', values.amount]]
      : lines.map(line => [line.task_id, values.works[line.task_id] ?? '']);
    const amounts: Record<string, number> = {};
    for (const [key, value] of entries) {
      if (!value.trim()) continue;
      const parsed = hundredths(value);
      if (parsed == null) {
        setError('Введите сумму в BYN с точностью до двух знаков после запятой.');
        return;
      }
      amounts[key] = parsed;
    }
    writing.current = true;
    setSaving(true);
    try {
      const updated = await mutate<Film>('garage_save_order_film', {
        p_order_id: orderId,
        p_expected_version: values.version,
        p_price_token: values.priceToken,
        p_mode: values.mode,
        p_amount_kopeks: amounts.order ?? null,
        p_works: values.mode === 'works' ? amounts : {},
      });
      requests.current?.abort();
      setData(updated);
      setDraft(null);
      notify('Расход на плёнку сохранён.');
    } catch (err) {
      setError(errorText(err));
      if (isConflict(err)) await load();
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }

  async function download() {
    if (file.current) return;
    const request = new AbortController();
    file.current = request;
    setDownloading(true);
    setError('');
    try {
      await downloadFilm(client, request.signal);
    } catch (err) {
      if (!request.signal.aborted) setError('Не удалось скачать историю расходов. Повторите попытку.');
    } finally {
      file.current = undefined;
      if (!request.signal.aborted) setDownloading(false);
    }
  }

  return <>
    {loadError && <p role="alert">Не удалось загрузить расход на плёнку.{' '}
      <button type="button" class="button" onClick={() => void load()}>Повторить</button>
    </p>}
    {!loadError && !data && <p role="status">Загружаем расход на плёнку…</p>}
    {data && values && <form onSubmit={e => { e.preventDefault(); void save(values, data.lines); }}>
      <fieldset disabled={saving || data.editable === false}>
        <label>
          Учитывать расход
          <select value={values.mode} onChange={e => setDraft({ ...values, mode: e.currentTarget.value as Mode })}>
            <option value="order">За весь заказ</option>
            <option value="works">По работам</option>
          </select>
        </label>
        {values.mode === 'order'
          ? <FilmAmount label="Плёнка на заказ, BYN" price={data.order_price_kopeks} value={values.amount}
              onInput={amount => setDraft({ ...values, amount })} />
          : data.lines.map(line => <FilmAmount key={line.task_id}
              label={'Плёнка · ' + line.name + (line.options?.tint_percent ? ' · ' + line.options.tint_percent + '%' : '') + ', BYN'}
              price={line.price_kopeks} value={values.works[line.task_id] ?? ''}
              onInput={value => setDraft({ ...values, works: { ...values.works, [line.task_id]: value } })} />)}
        {data.price_changed && <p class="notice">«Цена» изменилась после последней записи. Сохраните расход с актуальной ценой.</p>}
        {stale && <p class="notice">
          Расход или состав заказа изменился. Проверьте введённые суммы по актуальному заказу.{' '}
          <button type="button" class="button" onClick={() => {
            setDraft({ ...values, version: data.version, priceToken: data.price_token });
            setError('');
          }}>Подтвердить актуальные данные</button>
        </p>}
        {data.editable !== false && <button type="submit" class="button button-primary" disabled={stale || loadError}>
          {saving ? 'Сохраняем…' : 'Сохранить расход'}
        </button>}
      </fieldset>
    </form>}
    <button type="button" class="button" disabled={downloading} onClick={() => void download()}>
      {downloading ? 'Скачиваем историю…' : 'Скачать историю расходов'}
    </button>
    {error && <p role="alert">{error}</p>}
  </>;
}

export function OrderFilm(props: Parameters<typeof FilmForm>[0]) {
  const [opened, setOpened] = useState(false);
  return <details class="owner-film" onToggle={e => {
    if (e.currentTarget.open) setOpened(true);
  }}>
    <summary>Расход на плёнку</summary>
    {opened && <FilmForm {...props} />}
  </details>;
}
