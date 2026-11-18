import {
  resultFor,
  resultLabel,
  ledgerValue,
  ledgerIssues,
  ledgerReadOnly,
  rowDescription,
} from './ledger-shared.js';
import type { Calc, Header, LedgerRow, Sheet } from './ledger-types';
export function needsReview(sheet: Sheet, row: LedgerRow, headers: Header[], calc: Calc) {
  return (
    ledgerIssues(sheet, row, headers, calc).length > 0 ||
    headers.some((h) => resultFor(sheet, row, h.column, calc).status === 'error')
  );
}
function Values({
  sheet,
  row,
  headers,
  calc,
  original = false,
}: {
  sheet: Sheet;
  row: LedgerRow;
  headers: Header[];
  calc: Calc;
  original?: boolean;
}) {
  const cells = original ? row.original_cells || {} : row.cells;
  return (
    <dl class="ledger-values">
      {headers.map((h) => {
        const cell = cells[h.column];
        if (!cell || (cell.value == null && cell.cached == null && !cell.formula)) return null;
        const result = original
          ? { value: (cell.formula ? cell.cached : cell.value) ?? null, status: 'ok', error: '', warning: '' }
          : resultFor(sheet, row, h.column, calc);
        return (
          <div key={h.column}>
            <dt>
              {h.column} · {original ? h.sourceLabel || h.label : h.label}
            </dt>
            <dd>{resultLabel(result, cell.type)}</dd>
            {result.error && <p class="is-warning">{result.error}</p>}
            {result.warning && <p class="is-warning">{result.warning}</p>}
            {cell.formula && (
              <p class="ledger-cell-note">
                {cell.override && !original ? 'Значение задано вручную' : 'Исходная формула'} ·{' '}
                <code>{cell.formula}</code>
              </p>
            )}
          </div>
        );
      })}
    </dl>
  );
}
export function LedgerRecord({
  sheet,
  row,
  headers,
  calc,
  locked,
  edit,
  history,
}: {
  sheet: Sheet;
  row: LedgerRow;
  headers: Header[];
  calc: Calc;
  locked: boolean;
  edit: () => void;
  history: () => void;
}) {
  const date = headers.find((h) => /date|дат[аы]/i.test(h.label))?.column || 'A';
  const amount = headers.find((h) => /^(price|цена|сумма|стоимость)(\s|$)/i.test(h.label))?.column || 'B';
  const results = headers.map((h) => resultFor(sheet, row, h.column, calc));
  const errors = results.filter((r) => r.status === 'error').length,
    manual = results.filter((r) => r.status === 'override').length;
  const issues = ledgerIssues(sheet, row, headers, calc);
  return (
    <details class="ledger-record" data-ledger-row={row.id}>
      <summary class="ledger-summary">
        <span class="ledger-row-number">{row.source_row ?? 'Новая'}</span>
        <span class="ledger-row-date">
          {resultLabel(resultFor(sheet, row, date, calc), row.cells[date]?.type)}
        </span>
        <strong class="ledger-row-description">{rowDescription(row, headers)}</strong>
        <span class="ledger-row-amount">{resultLabel(resultFor(sheet, row, amount, calc))}</span>
        <span class="ledger-row-state">
          {row.archived
            ? 'В архиве'
            : errors
              ? 'Недоступно: ' + errors
              : issues.length
                ? 'Нужна проверка'
                : manual
                  ? 'Вручную: ' + manual
                  : row.version > 1
                    ? 'Изменено'
                    : 'Исходная запись'}
        </span>
      </summary>
      <div class="ledger-record-body">
        {issues.map((i) => (
          <p class="is-warning" key={i}>
            {i}
          </p>
        ))}
        <Values {...{ sheet, row, headers, calc }} />
        <p>
          {sheet.name} · {row.source_row ? 'исходная строка ' + row.source_row : 'ручная запись'} · версия{' '}
          {row.version}
        </p>
        {row.original_cells && (
          <details class="ledger-source-detail">
            <summary>Исходные значения и формулы книги</summary>
            <Values {...{ sheet, row, headers, calc }} original />
          </details>
        )}
        {!ledgerReadOnly(sheet, row.section, row) && (
          <div class="button-row">
            <button class="button" disabled={locked} onClick={edit}>
              Изменить запись
            </button>
            <button class="button" disabled={locked} onClick={history}>
              {row.archived ? 'История и восстановление' : 'История / архив'}
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
export function Totals({
  sheet,
  rows,
  headers,
  calc,
}: {
  sheet: Sheet;
  rows: LedgerRow[];
  headers: Header[];
  calc: Calc;
}) {
  return (
    <details class="ledger-source-detail">
      <summary>Текущие итоги по столбцам раздела</summary>
      <p>Все действующие записи раздела, включая ручные. Фильтры списка не меняют итог.</p>
      <dl class="ledger-values">
        {headers
          .filter((h) => !/rate|курс|процент|%|date|дата|цена\s*(за|м)/i.test(h.label))
          .map((h) => {
            let total = 0,
              count = 0,
              missing = 0,
              blank = 0;
            for (const row of rows) {
              if (row.archived) continue;
              const r = resultFor(sheet, row, h.column, calc);
              if (r.status === 'error') missing++;
              else if (typeof r.value === 'number' && Number.isFinite(r.value)) {
                total += r.value;
                count++;
              } else if (r.value == null || r.value === '') {
                blank++;
                if (/^(price|цена)(\s|$)/i.test(h.label)) missing++;
              }
            }
            if (!(count || missing)) return null;
            return (
              <div key={h.column}>
                <dt>
                  {h.column} · {h.label}
                </dt>
                <dd>{missing ? 'Недоступно' : ledgerValue(total)}</dd>
                {missing > 0 ? (
                  <p>
                    Неподтверждённых значений: {missing}. Сумма известных значений: {ledgerValue(total)}.
                  </p>
                ) : (
                  blank > 0 && <p>Пустых полей исключено: {blank}.</p>
                )}
              </div>
            );
          })}
      </dl>
    </details>
  );
}
