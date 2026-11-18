import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createLedgerCalculator } from './ledger-calculations.js';
import {
  ledgerHeaders,
  ledgerFailure,
  ledgerSectionLabel,
  ledgerWarning,
  ledgerReadOnly,
  rowDescription,
} from './ledger-shared.js';
import type { Calc, LedgerData, LedgerRow, Save, Section, Workbook } from './ledger-types';
import { LedgerForm, LedgerHistory } from './ledger-form';
import { LedgerRecord, needsReview, Totals } from './ledger-record';
import { readRpc } from './workspace-rpc';
import type { Client } from './workspace-types';

function newest(book: Workbook) {
  const key = (s: Workbook['sheets'][number]) => {
    const p = s.metadata?.source_period;
    return p?.year && p?.month ? p.year * 12 + p.month : 0;
  };
  return [...book.sheets].sort((a, b) => key(b) - key(a))[0]?.id;
}
function sectionsFor(data: LedgerData): Section[] {
  return data.sheet.metadata?.sections || [...new Set(data.rows.map((r) => r.section))].map((id) => ({ id }));
}
export function LedgerView({ client }: { client: Client }) {
  const [books, setBooks] = useState<Workbook[]>([]);
  const [data, setData] = useState<LedgerData | null>(null);
  const [calc, setCalc] = useState<Calc>(null);
  const [section, setSection] = useState('');
  const [archive, setArchive] = useState('active');
  const [query, setQuery] = useState('');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [stale, setStale] = useState(false);
  const [feedback, setFeedback] = useState({ title: '', text: '' });
  const [editor, setEditor] = useState<{ row: LedgerRow | null; history: boolean } | null>(null);
  const [conflict, setConflict] = useState<LedgerRow>();
  const scope = useRef(new AbortController());
  const seq = useRef(0),
    locked = useRef(false);
  const receipts = useRef(new Map<string, string>());
  const panel = useRef<HTMLDivElement>(null);
  const cache = useRef<{ id: string; revision: number; calculator: NonNullable<Calc> } | null>(null);
  const rpc = <T,>(name: string, args: Record<string, unknown> = {}) =>
    readRpc<T>(client, name, args, scope.current.signal);
  function notify(title: string, text = '') {
    setFeedback({ title, text });
  }
  async function load(sheetId: string, clear = true) {
    const token = ++seq.current;
    const current = () => !scope.current.signal.aborted && token === seq.current;
    setLoading(true);
    try {
      for (let tries = 0; tries < 3; tries++) {
        const next = await rpc<LedgerData>('garage_ledger_sheet', { p_sheet_id: sheetId });
        if (!current()) return null;
        if (!next.sheet || !next.import || !Array.isArray(next.rows)) throw new Error();
        let calculation = cache.current;
        if (calculation?.id !== next.import.id || calculation.revision !== next.import.revision) {
          const context = await rpc<{ revision: number }>('garage_ledger_context', {
            p_import_id: next.import.id,
          });
          if (!current()) return null;
          if (context?.revision !== next.import.revision) continue;
          calculation = {
            id: next.import.id,
            revision: context.revision,
            calculator: createLedgerCalculator(context),
          };
        }
        cache.current = calculation;
        setCalc(calculation.calculator);
        setData(next);
        setStale(false);
        const sections = sectionsFor(next);
        const fallback =
          sections.find((s) => ['ledger', 'entries'].includes(s.id) || s.kind === 'entries')?.id ||
          sections[0]?.id ||
          '';
        setSection((s) =>
          data?.sheet.id === next.sheet.id && sections.some((v) => v.id === s) ? s : fallback,
        );
        if (data?.sheet.id !== next.sheet.id) {
          setIssuesOnly(false);
          setPage(0);
        }
        if (clear) notify('');
        return next;
      }
      throw { code: '40001' };
    } catch (e) {
      if (current()) notify('Журнал недоступен', ledgerFailure(e));
      return null;
    } finally {
      if (current()) setLoading(false);
    }
  }
  async function initialize() {
    setLoading(true);
    try {
      const imports = await rpc<Workbook[]>('garage_ledger_imports');
      if (scope.current.signal.aborted) return;
      setBooks(imports);
      const id = imports[0] && newest(imports[0]);
      if (id) await load(id);
      else {
        notify('Книга ещё не импортирована');
        setLoading(false);
      }
    } catch (e) {
      if (!scope.current.signal.aborted) {
        notify('Журнал недоступен', ledgerFailure(e));
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    void initialize();
    return () => {
      scope.current.abort();
      cache.current = null;
      receipts.current.clear();
    };
  }, [client]);
  function close() {
    setEditor(null);
    setConflict(undefined);
  }
  function open(row: LedgerRow | null, history = false) {
    setEditor({ row, history });
    setConflict(undefined);
  }
  useEffect(() => {
    if (editor) {
      panel.current?.scrollIntoView({ block: 'start' });
      panel.current?.querySelector<HTMLElement>('input,textarea,button')?.focus({ preventScroll: true });
    }
  }, [editor]);
  const save: Save = async (name, args) => {
    if (!data || locked.current || scope.current.signal.aborted) return false;
    locked.current = true;
    setPending(true);
    const payload = name === 'garage_ledger_save_row' ? { ...args, p_sheet_id: data.sheet.id } : args;
    const signature = JSON.stringify([name, payload]);
    const id = receipts.current.get(signature) || crypto.randomUUID();
    receipts.current.set(signature, id);
    try {
      const result = await rpc<{ row: LedgerRow; revision: number }>(name, { ...payload, p_request_id: id });
      if (scope.current.signal.aborted) return false;
      if (!result.row || !Number.isInteger(result.revision)) throw new Error();
      receipts.current.delete(signature);
      cache.current = null;
      setCalc(null);
      setStale(true);
      setData({
        ...data,
        import: { ...data.import, revision: result.revision },
        rows: data.rows.some((r) => r.id === result.row.id)
          ? data.rows.map((r) => (r.id === result.row.id ? result.row : r))
          : [...data.rows, result.row],
      });
      const refreshed = await load(data.sheet.id, false);
      if (!scope.current.signal.aborted)
        notify(
          'Сохранено',
          refreshed
            ? 'Рабочий журнал обновлён.'
            : 'Изменение сохранено. Обновите журнал, чтобы загрузить текущие расчёты.',
        );
      return true;
    } catch (e) {
      if (scope.current.signal.aborted) return false;
      cache.current = null;
      setCalc(null);
      setStale(true);
      const current = await load(data.sheet.id, false);
      if (!scope.current.signal.aborted) {
        if ((e as { code?: string })?.code === '40001')
          setConflict(current?.rows.find((r) => r.id === args.p_row_id));
        notify('Изменение не подтверждено', ledgerFailure(e));
      }
      return false;
    } finally {
      locked.current = false;
      if (!scope.current.signal.aborted) setPending(false);
    }
  };
  const rows = useMemo(() => data?.rows.filter((r) => r.section === section) || [], [data, section]);
  const headers = useMemo(
    () => (data ? ledgerHeaders(data.sheet, section, rows) : []),
    [data, section, rows],
  );
  const flagged = useMemo(
    () =>
      new Set(
        data
          ? rows.filter((r) => !r.archived && needsReview(data.sheet, r, headers, calc)).map((r) => r.id)
          : [],
      ),
    [data, rows, headers, calc],
  );
  const needle = query.trim().toLocaleLowerCase('ru');
  const shown = rows.filter(
    (r) =>
      (archive === 'all' || r.archived === (archive === 'archived')) &&
      (!issuesOnly || flagged.has(r.id)) &&
      (!needle ||
        JSON.stringify([rowDescription(r, headers), r.source_row, r.cells])
          .toLocaleLowerCase('ru')
          .includes(needle)),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(shown.length / 40) - 1));
  const book = books.find((b) => b.id === data?.import.id);
  const sections = data ? sectionsFor(data) : [];
  const selected = sections.find((s) => s.id === section);
  const busy = loading || pending;
  const frozen = busy || !!editor;
  const canAdd =
    data &&
    selected?.addable !== false &&
    !ledgerReadOnly(data.sheet, section, null) &&
    !/summary|totals|header|template/i.test(section);
  return (
    <section class="ledger-workspace" aria-busy={busy} aria-label="Учёт бизнеса для владельца">
      <div class="ledger-toolbar">
        <label>
          Версия книги
          <select
            value={book?.id || ''}
            disabled={frozen}
            onChange={(e) => {
              const b = books.find((item) => item.id === e.currentTarget.value);
              if (b) {
                const id = newest(b);
                if (id) void load(id);
              }
            }}
          >
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name || b.filename}
              </option>
            ))}
          </select>
        </label>
        <label>
          Лист / период
          <select
            value={data?.sheet.id || ''}
            disabled={frozen}
            onChange={(e) => {
              const id = e.currentTarget.value;
              e.currentTarget.value = data?.sheet.id || '';
              void load(id);
            }}
          >
            {book?.sheets.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Раздел
          <select
            value={section}
            disabled={frozen}
            onChange={(e) => {
              setSection(e.currentTarget.value);
              setPage(0);
              setIssuesOnly(false);
            }}
          >
            {sections.map((s) => (
              <option value={s.id} key={s.id}>
                {ledgerSectionLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <button class="button" disabled={busy} onClick={() => (data ? load(data.sheet.id) : initialize())}>
          Обновить журнал
        </button>
        <button
          class="button button-primary"
          disabled={!canAdd || frozen || stale}
          onClick={() => open(null)}
        >
          Добавить запись
        </button>
      </div>
      <div role="status">
        <strong>{feedback.title}</strong>
        {feedback.text && <p>{feedback.text}</p>}
        {loading && <p>Загрузка закрытых записей журнала…</p>}
      </div>
      {data && (
        <>
          <div class="ledger-source">
            <strong>{data.import.name || data.import.filename}</strong>
            <span>
              {data.sheet.name} · версия {data.import.revision}
            </span>
          </div>
          {!!data.sheet.metadata?.warnings?.length && (
            <details class="ledger-source-detail">
              <summary>Замечания к исходным данным: {data.sheet.metadata.warnings.length}</summary>
              {data.sheet.metadata.warnings.map((w, i) => (
                <p key={i}>{ledgerWarning(w)}</p>
              ))}
            </details>
          )}
          <div class="ledger-toolbar">
            <label>
              Поиск по журналу
              <input
                type="search"
                disabled={frozen}
                value={query}
                onInput={(e) => {
                  setQuery(e.currentTarget.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              Записи
              <select
                value={archive}
                disabled={frozen}
                onChange={(e) => {
                  setArchive(e.currentTarget.value);
                  setPage(0);
                }}
              >
                <option value="active">Действующие записи</option>
                <option value="all">Включая архив</option>
                <option value="archived">Только архив</option>
              </select>
            </label>
            <button
              class="button"
              disabled={frozen}
              aria-pressed={issuesOnly}
              onClick={() => {
                setIssuesOnly(!issuesOnly);
                setPage(0);
                if (!issuesOnly) setArchive('active');
              }}
            >
              Требуют проверки · {flagged.size}
            </button>
          </div>
          <div ref={panel}>
            {editor &&
              (editor.history && editor.row ? (
                <LedgerHistory
                  client={client}
                  row={conflict || editor.row}
                  busy={busy}
                  save={save}
                  close={close}
                />
              ) : (
                <LedgerForm
                  sheet={data.sheet}
                  row={editor.row}
                  latest={conflict}
                  section={section}
                  samples={rows}
                  headers={headers}
                  calc={calc}
                  save={save}
                  close={close}
                  busy={busy}
                />
              ))}
          </div>
          <div class="ledger-list">
            {!shown.length && <p>Подходящих записей нет</p>}
            {shown.slice(currentPage * 40, (currentPage + 1) * 40).map((row) => (
              <LedgerRecord
                key={row.id}
                {...{
                  sheet: data.sheet,
                  row,
                  headers,
                  calc,
                  locked: frozen || stale,
                  edit: () => open(row),
                  history: () => open(row, true),
                }}
              />
            ))}
          </div>
          {(selected?.totalable === true ||
            selected?.kind === 'entries' ||
            /^(ledger|entries|work_entries|main)$/.test(section)) && (
            <Totals sheet={data.sheet} {...{ rows, headers, calc }} />
          )}
          <div class="ledger-pagination">
            <p>
              {shown.length
                ? currentPage * 40 +
                  1 +
                  '–' +
                  Math.min((currentPage + 1) * 40, shown.length) +
                  ' из ' +
                  shown.length +
                  ' записей'
                : 'Записей: 0'}
            </p>
            {shown.length > 40 && (
              <div>
                <button class="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                  Предыдущие
                </button>
                <button
                  class="button"
                  disabled={(currentPage + 1) * 40 >= shown.length}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Следующие
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
