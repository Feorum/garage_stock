import { useEffect, useRef, useState } from 'preact/hooks';
import {
  parseSpreadsheetId,
  parseSheetGid,
  TAB_ID,
  READER_GUIDE,
  generateSecret,
  feedbackMessage,
  REVIEW_MESSAGES,
  connectionUrl,
} from './sheet-format.js';
import { useOwnerData, useResource } from './owner-data';
import { readRpc } from './workspace-rpc';
import type { Client, Navigate } from './workspace-types';

export interface Source {
  id: string;
  source_id?: string;
  name: string;
  spreadsheet_id: string;
  sheet_gid: number;
  active: boolean;
  reader_only: boolean;
  version: number;
  review_count: number;
  last_success_at?: string;
  last_error_code?: string;
  summary?: { awaiting_stability?: number; feedback_confirmed?: number; feedback_pending?: number };
}
interface Review {
  row_number: number;
  vehicle?: string;
  planned_date?: string;
  source_key?: string;
  reason_codes?: string[];
}
interface Intake {
  id: string;
  order_id?: string;
  source_id: string;
  source_key?: string;
}
interface Setup {
  source: Source;
  secret: string;
  api: string;
}
const keyOf = (source: Source) => source.id || source.source_id!;
const reasons: Record<string, string> = REVIEW_MESSAGES;

function ReaderSetup({ setup, close }: { setup: Setup; close: () => void }) {
  const [reveal, setReveal] = useState(false);
  const [feedback, setFeedback] = useState('');
  const values = {
    SPREADSHEET_ID: setup.source.spreadsheet_id,
    SHEET_GID: String(setup.source.sheet_gid),
    INTEGRATION_ID: keyOf(setup.source),
    INTEGRATION_SECRET: setup.secret,
    API_URL: setup.api,
  };
  const labels: Record<string, string> = {
    SPREADSHEET_ID: 'Идентификатор таблицы',
    SHEET_GID: 'Идентификатор листа',
    INTEGRATION_ID: 'Идентификатор подключения',
    INTEGRATION_SECRET: 'Секретный ключ',
    API_URL: 'Адрес сервера',
  };
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        'function setupConnection() {\n  PropertiesService.getScriptProperties().setProperties(' +
          JSON.stringify(values, null, 2) +
          ');\n  install();\n}\n',
      );
      setFeedback('Скопировано. Вставьте функцию в свой закрытый проект.');
    } catch {
      setFeedback('Копирование недоступно. Скопируйте значения полей вручную.');
    }
  }
  return (
    <section class="sheet-setup" aria-label="Настройка закрытого загрузчика">
      <h2>Настройка закрытого загрузчика</h2>
      <p>
        Google запрашивает разрешение на редактирование таблиц. В рабочей копии скрипт добавляет список
        моделей в столбец D и записывает результаты работ в столбцы I и J.
      </p>
      <ol>
        <li>Создайте отдельный закрытый проект Google Apps Script.</li>
        <li>
          Скопируйте файлы Code.gs, Feedback.gs и манифест из инструкции, затем добавьте функцию настройки
          ниже.
        </li>
        <li>
          Запустите setupConnection и предоставьте разрешения. После настройки удалите временную функцию из
          проекта.
        </li>
      </ol>
      <a href={READER_GUIDE} target="_blank" rel="noopener noreferrer">
        Открыть код загрузчика и инструкцию
      </a>
      <div class="form-grid">
        {Object.entries(values).map(([key, value]) => (
          <label key={key}>
            {labels[key]}
            <input
              type={key === 'INTEGRATION_SECRET' && !reveal ? 'password' : 'text'}
              readOnly
              autoComplete="off"
              value={value}
            />
          </label>
        ))}
      </div>
      <p>Сохраните ключ сейчас в закрытом проекте. Новый ключ отключит предыдущий.</p>
      <div class="button-row">
        <button class="button" onClick={() => setReveal(!reveal)}>
          {reveal ? 'Скрыть ключ' : 'Показать ключ'}
        </button>
        <button class="button button-primary" onClick={copy}>
          Скопировать функцию настройки
        </button>
        <button class="button" onClick={close}>
          Скрыть данные подключения
        </button>
      </div>
      <p role="status">{feedback}</p>
    </section>
  );
}
export function SheetsView({ client, navigate }: { client: Client; navigate: Navigate }) {
  const store = useOwnerData();
  const sourceList = useResource(store.sources);
  const sources = sourceList.data ?? [];
  const loading = !sourceList.loaded;
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState({ title: '', message: '' });
  const [showConnect, setShowConnect] = useState(false);
  const [gid, setGid] = useState('');
  const gidInput = useRef<HTMLInputElement>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [review, setReview] = useState<{ source: Source; rows: Review[]; intakes: Intake[] } | null>(null);
  const scope = useRef(new AbortController());
  const locked = useRef(false);
  const attempt = useRef<{ source: string; version: number; secret: string } | null>(null);
  const tell = (title: string, message = '') => setFeedback({ title, message });
  async function refresh() {
    await store.sources.read(true).then(() => tell(''), error => tell('Подключения недоступны', feedbackMessage(error)));
  }
  useEffect(() => {
    return () => {
      scope.current.abort();
      attempt.current = null;
    };
  }, [client]);
  async function act(title: string, action: () => Promise<void>) {
    if (locked.current || scope.current.signal.aborted) return;
    locked.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (!scope.current.signal.aborted) tell(title, feedbackMessage(error));
    } finally {
      locked.current = false;
      if (!scope.current.signal.aborted) setBusy(false);
    }
  }
  function apply(source: Source, fresh: Partial<Source>) {
    store.sources.set([{ ...source, ...fresh }, ...(store.sources.get().data || []).filter((s) => keyOf(s) !== keyOf(source))]);
  }
  function connect(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const id = parseSpreadsheetId(data.get('url'));
    if (!name || !id || !TAB_ID.test(gid) || Number(gid) > 2147483647)
      return tell(
        'Проверьте подключение',
        'Укажите название, корректную ссылку или идентификатор таблицы Google и идентификатор листа заказов.',
      );
    void act('Подключение не подтверждено', async () => {
      const result = await readRpc<Source>(
        client,
        'garage_connect_sheet_pull',
        { p_name: name, p_spreadsheet_id: id, p_sheet_gid: Number(gid) },
        scope.current.signal,
      );
      if (scope.current.signal.aborted) return;
      apply(result, {});
      form.reset();
      setGid('');
      setShowConnect(false);
      tell(
        'Рабочая копия подключена',
        'Завершите настройку закрытого загрузчика. Исходная таблица не изменяется.',
      );
    });
  }
  function toggle(source: Source) {
    void act('Изменение подключения не подтверждено', async () => {
      const updated = await readRpc<Source>(
        client,
        'garage_set_sheet_active',
        { p_source_id: keyOf(source), p_active: !source.active, p_expected_version: source.version },
        scope.current.signal,
      );
      if (scope.current.signal.aborted) return;
      apply(source, updated);
      tell(updated.active ? 'Импорт возобновлён' : 'Импорт приостановлен');
    });
  }
  function reader(source: Source) {
    void act('Настройка загрузчика не подтверждена', async () => {
      const id = keyOf(source);
      if (attempt.current?.source !== id || attempt.current.version !== source.version)
        attempt.current = { source: id, version: source.version, secret: generateSecret() };
      const { secret } = attempt.current;
      const updated = await readRpc<Source>(
        client,
        'garage_prepare_sheet_reader',
        { p_source_id: id, p_secret: secret, p_expected_version: source.version },
        scope.current.signal,
      );
      if (scope.current.signal.aborted) return;
      apply(source, updated);
      attempt.current = null;
      const { publicApiOrigin } = await import('./supabase.js');
      if (scope.current.signal.aborted) return;
      setSetup({
        source,
        secret,
        api: new URL('/functions/v1/pull-manager-sheets/source', publicApiOrigin).href,
      });
      tell('Настройки закрытого загрузчика готовы');
    });
  }
  function reviews(source: Source) {
    void act('Проверка недоступна', async () => {
      const rows = await readRpc<Review[]>(
        client,
        'garage_sheet_pull_reviews',
        { p_source_id: keyOf(source) },
        scope.current.signal,
      );
      const intakes = rows.some((row) => row.source_key)
        ? await readRpc<Intake[]>(client, 'garage_manager_intakes', {}, scope.current.signal).catch(() => [])
        : [];
      if (!scope.current.signal.aborted) setReview({ source, rows, intakes });
    });
  }
  useEffect(() => {
    const returned = () => {
      void refresh();
      if (review) reviews(review.source);
    };
    window.addEventListener('garage-order-drawer-closed', returned);
    return () => window.removeEventListener('garage-order-drawer-closed', returned);
  }, [client, review?.source]);
  return (
    <section class="sheets-workspace" aria-label="Подключения таблиц">
      <div class="sheet-list-heading">
        <h2>Подключённые таблицы</h2>
        <button class="button" disabled={busy} onClick={refresh}>
          Обновить состояние
        </button>
      </div>
      <div class="sheets-feedback" role="status">
        <strong>{feedback.title}</strong>
        {feedback.message && <p>{feedback.message}</p>}
      </div>
      {sourceList.failed && !feedback.title && <p role="alert">Не удалось загрузить подключения.</p>}
      {loading && <p role="status">Загрузка подключений таблиц…</p>}
      {!loading && !sourceList.failed && !sources.length && <p>Рабочая копия не подключена</p>}
      <div class="sheet-source-list">
        {sources.map((source) => {
          const url = connectionUrl(source, 0),
            summary = source.summary;
          const state = !source.active
            ? 'Импорт приостановлен'
            : source.last_error_code
              ? 'Требуется проверка'
              : source.last_success_at
                ? 'Синхронизация выполнена'
                : source.reader_only
                  ? 'Ожидается настройка загрузчика'
                  : 'Ожидается первая синхронизация';
          return (
            <article key={keyOf(source)} class="sheet-source-card" data-source-id={keyOf(source)}>
              <h3>{source.name}</h3>
              <span class="tag">{state}</span>
              {source.last_success_at && (
                <p>
                  Последняя успешная проверка:{' '}
                  {new Date(source.last_success_at).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}
                </p>
              )}
              <p>
                {source.review_count
                  ? 'Строк на проверке у владельца: ' + source.review_count + '.'
                  : source.last_success_at
                    ? 'Сейчас нет строк, ожидающих проверки.'
                    : 'Результаты проверки появятся после первого успешного чтения.'}
              </p>
              {!!summary?.awaiting_stability && (
                <p>
                  Ожидают повторного чтения: {summary.awaiting_stability}. Перед публикацией данные должны
                  остаться неизменными при двух чтениях с интервалом не менее минуты.
                </p>
              )}
              {Number.isInteger(summary?.feedback_confirmed) &&
                Number.isInteger(summary?.feedback_pending) && (
                  <p>
                    Результаты выполнения: подтверждено {summary?.feedback_confirmed} · ожидает{' '}
                    {summary?.feedback_pending}.
                  </p>
                )}
              <div class="sheet-source-actions">
                <button class="button" disabled={busy} onClick={() => reviews(source)}>
                  Проверить строки
                </button>
                {url && (
                  <a class="button" href={url} target="_blank" rel="noopener noreferrer">
                    Открыть рабочую копию
                  </a>
                )}
                <button class="button" disabled={busy} onClick={() => toggle(source)}>
                  {source.active ? 'Приостановить импорт' : 'Возобновить импорт'}
                </button>
                <button class="button" disabled={busy} onClick={() => reader(source)}>
                  Настроить закрытый загрузчик
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {review && (
        <section class="sheet-review-area">
          <h2>Строки для проверки владельцем</h2>
          {review.rows.length === 0 && <p>Сейчас нет строк, ожидающих проверки.</p>}
          {review.rows.map((row, i) => {
            const url = connectionUrl(review.source, row.row_number);
            const matches = review.intakes.filter(
              (d) =>
                row.source_key && d.source_key === row.source_key && d.source_id === keyOf(review.source),
            );
            return (
              <article class="sheet-source-card" key={i}>
                <h3>
                  Строка {row.row_number} · {row.vehicle}
                </h3>
                {row.planned_date && <p>{row.planned_date}</p>}
                <ul>
                  {[
                    ...new Set(
                      (row.reason_codes || []).map(
                        (c) => reasons[c] || reasons[c.toLowerCase()] || 'Проверьте запрос в рабочей копии.',
                      ),
                    ),
                  ].map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
                {matches.length === 1 && (
                  <button
                    class="button"
                    onClick={() => navigate('orders', matches[0].order_id || matches[0].id)}
                  >
                    Проверить в заказах
                  </button>
                )}
                {url && (
                  <a class="button" href={url} target="_blank" rel="noopener noreferrer">
                    Открыть исходную строку
                  </a>
                )}
              </article>
            );
          })}
          <button class="button" onClick={() => setReview(null)}>
            Закрыть проверку
          </button>
        </section>
      )}
      {!showConnect && (
        <button class="button" onClick={() => setShowConnect(true)}>
          Добавить подключение
        </button>
      )}
      {showConnect && (
        <form class="sheet-registration" onSubmit={connect}>
          <fieldset disabled={busy}>
            <legend>Подключение рабочей копии</legend>
            <label>
              Название подключения
              <input name="name" required maxLength={120} />
            </label>
            <label>
              Ссылка или идентификатор таблицы
              <input
                name="url"
                required
                autoComplete="off"
                onInput={(e) => {
                  const found = parseSheetGid(e.currentTarget.value);
                  if (found !== null) {
                    setGid(String(found));
                    gidInput.current?.setCustomValidity('');
                  }
                }}
              />
            </label>
            <label>
              Идентификатор листа заказов
              <input
                ref={gidInput}
                required
                inputMode="numeric"
                value={gid}
                onInput={(e) => setGid(e.currentTarget.value)}
              />
            </label>
            <p>Используйте рабочую копию. Исходная таблица не изменяется.</p>
            <button class="button button-primary">Подключить рабочую копию</button>
            <button class="button" type="button" onClick={() => setShowConnect(false)}>
              Закрыть
            </button>
          </fieldset>
        </form>
      )}
      {setup && <ReaderSetup key={setup.secret} setup={setup} close={() => setSetup(null)} />}
    </section>
  );
}
