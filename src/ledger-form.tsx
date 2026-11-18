import { useEffect, useRef, useState } from 'preact/hooks';
import { ledgerFailure, ledgerValue, resultFor } from './ledger-shared.js';
import { readRpc } from './workspace-rpc';
import type { Client } from './workspace-types';
import type { Calc, Cell, Cells, Header, LedgerRow, Save, Sheet, Value } from './ledger-types';

export function LedgerForm({
  sheet,
  row,
  latest,
  headers,
  samples,
  section,
  calc,
  save,
  close,
  busy,
}: {
  sheet: Sheet;
  row: LedgerRow | null;
  latest?: LedgerRow;
  headers: Header[];
  samples: LedgerRow[];
  section: string;
  calc: Calc;
  save: Save;
  close: () => void;
  busy: boolean;
}) {
  const [base, setBase] = useState(row);
  const [draft, setDraft] = useState<Record<string, { text: string; override: boolean }>>({});
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState('');
  const conflict = !!(base && latest && base.version !== latest.version);
  function field(h: Header) {
    const cell = base?.cells[h.column],
      sample = cell || samples.find((r) => r.cells[h.column])?.cells[h.column];
    const inferred =
      h.type ||
      sample?.type ||
      (/date|дата/i.test(h.label)
        ? 'date'
        : /price|amount|area|rate|цена|стоимость|сумма|площадь|курс/i.test(h.label)
          ? 'number'
          : 'string');
    const type = cell?.formula || inferred === 'error' ? 'number' : inferred;
    const calculated =
      cell?.formula && !cell.override && base ? resultFor(sheet, base, h.column, calc) : undefined;
    const value = calculated ? calculated.value : cell?.value;
    const current = draft[h.column] || {
      text: value == null ? '' : String(value),
      override: !!cell?.override,
    };
    return { cell, sample, type, current, calculated };
  }
  function change(column: string, text: string, override: boolean) {
    setDraft((old) => ({ ...old, [column]: { text, override } }));
  }
  function control(h: Header) {
    const { cell, type, current, calculated } = field(h);
    const props = {
      id: 'ledger-field-' + h.column,
      disabled: !!cell?.formula && !current.override,
      value: current.text,
      onInput: (e: Event) => change(h.column, (e.currentTarget as HTMLInputElement).value, current.override),
    };
    return (
      <div class="ledger-control" key={h.column}>
        <label for={props.id}>
          {h.column} · {h.label}
        </label>
        {type === 'boolean' ? (
          <select {...props}>
            <option value="">Не указано</option>
            <option value="true">Да</option>
            <option value="false">Нет</option>
          </select>
        ) : /description|описан|назван|наименован|комментар/i.test(h.label) ? (
          <textarea {...props} rows={2} />
        ) : (
          <input
            {...props}
            type={
              type === 'number' && (cell?.type !== 'error' || cell?.formula)
                ? 'number'
                : type === 'date'
                  ? 'date'
                  : 'text'
            }
            step={type === 'number' ? 'any' : undefined}
          />
        )}
        {cell?.formula && (
          <>
            <label class="ledger-override">
              <input
                type="checkbox"
                id={'ledger-override-' + h.column}
                checked={current.override}
                onChange={(e) => change(h.column, current.text, e.currentTarget.checked)}
              />
              Задать значение вручную
            </label>
            <code>{cell.formula}</code>
            {calculated?.error && <p>{calculated.error}</p>}
          </>
        )}
      </div>
    );
  }
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (conflict || busy) return;
    const cells: Cells = structuredClone(base?.cells || {});
    for (const h of headers) {
      if (!draft[h.column]) continue;
      const { cell, sample, type, current } = field(h);
      if (cell?.formula && !current.override) {
        cells[h.column] = { ...cell, override: false };
        continue;
      }
      let value: Value = current.text.trim() === '' ? null : current.text;
      if (value !== null && type === 'number') {
        value = Number(value);
        if (!Number.isFinite(value)) return setFeedback('Введите корректные числовые значения.');
      } else if (value !== null && type === 'boolean') value = value === 'true';
      if (!cell && value === null) continue;
      cells[h.column] = {
        ...(cell || { formula: null, cached: null, format: sample?.format || '' }),
        type,
        value,
        ...(cell?.formula ? { override: true } : {}),
      };
    }
    if (!base && !Object.values(cells).some((c) => c.value != null && c.value !== ''))
      return setFeedback('Заполните хотя бы одно значение записи.');
    if (
      await save('garage_ledger_save_row', {
        p_row_id: base?.id || null,
        p_expected_version: base?.version || 0,
        p_section: section,
        p_cells: cells,
        p_archived: base?.archived || false,
        p_reason: reason.trim(),
      })
    )
      close();
  }
  return (
    <form class="ledger-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>{base ? 'Изменить запись' : 'Добавить запись'}</legend>
        <div class="ledger-form-grid">
          {headers.filter((h) => !base?.cells[h.column]?.formula).map(control)}
        </div>
        {headers.some((h) => base?.cells[h.column]?.formula) && (
          <details class="ledger-source-detail">
            <summary>Сохранённые расчёты и ручные значения</summary>
            <div class="ledger-form-grid">
              {headers.filter((h) => base?.cells[h.column]?.formula).map(control)}
            </div>
          </details>
        )}
        <label>
          Причина изменения
          <textarea
            required
            maxLength={2000}
            value={reason}
            onInput={(e) => setReason(e.currentTarget.value)}
          />
        </label>
        {conflict && latest && (
          <section role="status">
            <h3>Проверьте последнюю версию</h3>
            {Object.entries(draft).map(([col, d]) => (
              <p key={col}>
                {col} · Ваш ввод: {d.text} · Последнее сохранённое значение:{' '}
                {ledgerValue(latest.cells[col]?.value)}
              </p>
            ))}
            <button class="button" type="button" onClick={() => setBase(latest)}>
              Применить мой ввод к последней версии
            </button>
          </section>
        )}
        <p role="status">{feedback}</p>
        <div class="button-row">
          <button class="button button-primary" disabled={conflict}>
            {base ? 'Сохранить изменения' : 'Добавить запись'}
          </button>
          <button class="button" type="button" onClick={close}>
            Отменить редактирование
          </button>
        </div>
      </fieldset>
    </form>
  );
}

interface Revision {
  id: string;
  action: string;
  version: number;
  reason?: string;
  actor_name?: string;
  created_at?: string;
  after_state?: { cells: Record<string, Cell> };
}
export function LedgerHistory({
  client,
  row,
  busy,
  save,
  close,
}: {
  client: Client;
  row: LedgerRow;
  busy: boolean;
  save: Save;
  close: () => void;
}) {
  const [events, setEvents] = useState<Revision[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError('');
    readRpc<Revision[]>(client, 'garage_ledger_history', { p_row_id: row.id }, ac.signal)
      .then((data) => {
        if (!ac.signal.aborted) setEvents(data);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(ledgerFailure(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [row.id, client, attempt]);
  async function change(revision?: Revision) {
    if (!form.current?.reportValidity() || busy) return;
    const params = { p_row_id: row.id, p_expected_version: row.version, p_reason: reason.trim() };
    const ok = revision
      ? await save('garage_ledger_restore', { ...params, p_revision_id: String(revision.id) })
      : await save('garage_ledger_save_row', {
          ...params,
          p_cells: row.cells,
          p_section: row.section,
          p_archived: true,
        });
    if (ok) close();
  }
  return (
    <form class="ledger-form ledger-history" ref={form} onSubmit={(e) => e.preventDefault()}>
      <fieldset disabled={busy}>
        <legend>История и восстановление записи</legend>
        <label>
          Причина архивации или восстановления
          <textarea
            required
            maxLength={2000}
            value={reason}
            onInput={(e) => setReason(e.currentTarget.value)}
          />
        </label>
        {loading && <p role="status">Загрузка истории записи…</p>}
        {error && (
          <p role="alert">
            {error}{' '}
            <button class="button" type="button" onClick={() => setAttempt((v) => v + 1)}>
              Повторить загрузку истории
            </button>
          </p>
        )}
        <ol>
          {events.map((entry) => (
            <li key={entry.id}>
              <strong>
                {entry.action === 'import' ? 'Исходная запись книги' : 'Версия ' + entry.version}
              </strong>
              <p>{entry.action === 'import' ? 'Исходный снимок книги' : entry.reason}</p>
              <small>
                {entry.actor_name}{' '}
                {entry.created_at &&
                  new Date(entry.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}
              </small>
              <details class="ledger-source-detail">
                <summary>Значения в этой версии</summary>
                <dl>
                  {Object.entries(entry.after_state?.cells || {}).map(([key, c]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>
                        {ledgerValue(c.value, c.type)} {c.formula && <code>{c.formula}</code>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
              <button class="button" type="button" onClick={() => change(entry)}>
                Восстановить эту версию
              </button>
            </li>
          ))}
        </ol>
        {!row.archived && (
          <button class="button" type="button" onClick={() => change()}>
            В архив
          </button>
        )}{' '}
        <button type="button" class="button" onClick={close}>
          Закрыть историю
        </button>
      </fieldset>
    </form>
  );
}
