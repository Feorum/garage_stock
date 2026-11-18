import { quoteWithGift } from './owner-gift';
import { useEffect, useState } from 'preact/hooks';
import type { GarageClient } from './shift-model';
import { money } from './pay-model';
import {
  read,
  workName,
  type Choice,
  type Money,
  type OwnerIntake,
  type Raw,
  quoteTasks,
} from './owner-model';

export function Price({ value, preview = false }: { value: Money; preview?: boolean }) {
  const rows = [
    ['Без НДС', value.net_amount],
    ['НДС', value.vat_amount],
    ['С НДС', value.gross_amount],
  ] as const;
  const complete =
    value.status === 'priced' && rows.every(([, n]) => n != null && Number.isFinite(Number(n)));
  const fmt = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'BYN' });
  return (
    <section class="financial-summary" aria-label="Стоимость · только владельцу">
      <p>{preview ? 'Выбранные работы' : 'Сохранённые расценки'} · только владельцу · BYN</p>
      {preview && Boolean(value.items?.length) && (
        <ul class="quote-items">
          {value.items!.map((item, index) => (
            <li key={item.task_id || item.work_code || index}>
              <strong>{workName(item.work_code || '')}</strong>
              <span>
                Ставка без НДС ·{' '}
                {item.catalogue_kopeks != null
                  ? money(item.catalogue_kopeks)
                  : item.net_amount != null
                    ? fmt.format(item.net_amount)
                    : 'не указана'}
              </span>
              {item.override_kopeks != null && (
                <span>Стоимость для клиента без НДС · {money(item.override_kopeks)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <h4>Справочно · по прайсу</h4>
      {complete ? (
        <dl data-price-kind="catalogue">
          {rows.map(([title, n]) => (
            <div key={title}>
              <dt>{title}</dt>
              <dd>{fmt.format(Number(n))}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div class="notice">
          <strong>Требуется проверка владельца</strong>
          <p>Стоимость части работ ещё не подтверждена. Неизвестные суммы не считаются нулевыми.</p>
        </div>
      )}
      {'effective_total_kopeks' in value && (
        <>
          <h4>Итого для клиента</h4>
          <dl data-price-kind="effective">
            {(
              [
                ['Без НДС', value.effective_total_kopeks],
                ['НДС', value.effective_tax_kopeks],
                ['С НДС', value.effective_gross_kopeks],
              ] as const
            ).map(([label, sum]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{sum == null ? 'Требует расчёта' : money(sum)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
export function Quote({
  client,
  group,
  choices,
  orderId,
  giftCode,
  onQuote,
}: {
  client: GarageClient;
  group: string;
  choices: Choice[];
  orderId?: string;
  giftCode?: string;
  onQuote?(value: Money | null): void;
}) {
  const [state, setState] = useState<Money | 'loading' | 'error' | null>(null);
  const [attempt, retry] = useState(0);
  const payload = JSON.stringify(quoteTasks(choices));
  useEffect(() => {
    let active = true;
    onQuote?.(null);
    if (
      !group ||
      choices.length === 0 ||
      choices.some((c) => c.work_code === 'W19' && ![5, 15].includes(Number(c.options.tint_percent)))
    ) {
      setState(null);
      return;
    }
    setState('loading');
    read<Money>(client, 'garage_quote_order', {
      p_vehicle_group_code: group,
      p_tasks: JSON.parse(payload),
      p_order_id: orderId || null,
    })
      .then((r) => {
        if (active) {
          setState(r);
          onQuote?.(r);
        }
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [client, group, payload, orderId, attempt, onQuote]);
  return (
    <div class="order-price-preview" aria-live="polite">
      {state === 'error' ? (
        <>
          <p>Не удалось рассчитать стоимость.</p>
          <button class="button" type="button" onClick={() => retry((n) => n + 1)}>
            Повторить расчёт
          </button>
        </>
      ) : state === 'loading' ? (
        <p>Рассчитываем выбранные работы…</p>
      ) : state ? (
        <Price value={quoteWithGift(state, giftCode)} preview />
      ) : (
        <p>Выберите работы для расчёта стоимости.</p>
      )}
    </div>
  );
}
const rawFields: [string, string][] = [
  ['Дата', 'date'],
  ['Менеджер', 'manager_label'],
  ['Автомобиль', 'vehicle'],
  ['VIN', 'vin'],
  ['Цвет', 'colour'],
  ['Заявка на оклейку', 'wrapping'],
  ['Заявка на тонировку', 'tint'],
  ['Отметка выполнения в таблице', 'completion'],
  ['Примечания менеджера', 'notes'],
];
function Snapshot({ title, raw }: { title: string; raw: Raw }) {
  const display = (key: string) =>
    key === 'completion' && /^(true|false)$/i.test(String(raw[key]))
      ? String(raw[key]).toLowerCase() === 'true'
        ? 'Отмечено как выполненное (да)'
        : 'Не отмечено как выполненное (нет)'
      : String(raw[key] ?? '') || '—';
  return (
    <section>
      <h4>{title}</h4>
      <dl class="manager-reference-fields">
        {rawFields.map(([title, key]) => (
          <div key={key}>
            <dt>{title}</dt>
            <dd>{display(key)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
export function SourceReference({ intake }: { intake?: OwnerIntake }) {
  if (!intake) return null;
  const original = intake.original_observations?.length
    ? intake.original_observations
    : [{ raw: intake.original || {}, row_number: undefined }];
  const latest = intake.observations?.length
    ? intake.observations
    : [{ raw: intake.latest || {}, row_number: undefined }];
  return (
    <details class="manager-reference">
      <summary>Исходная заявка менеджера · только владельцу</summary>
      {original.map((v, i) => (
        <Snapshot
          key={i}
          raw={v.raw}
          title={'Исходный текст таблицы' + (v.row_number ? ' · Строка ' + v.row_number : '')}
        />
      ))}
      {intake.source_changed &&
        latest.map((v, i) => (
          <Snapshot
            key={i}
            raw={v.raw}
            title={'Актуальный текст таблицы' + (v.row_number ? ' · Строка ' + v.row_number : '')}
          />
        ))}
    </details>
  );
}
