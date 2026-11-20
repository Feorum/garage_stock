import { quoteWithGift } from './owner-gift';
import { useEffect, useState } from 'preact/hooks';
import type { GarageClient } from './shift-model';
import { customerPrice, money } from './pay-model';
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
  const total = value.effective_total_kopeks !== undefined
    ? value.effective_total_kopeks
    : value.status === 'priced' && value.net_amount != null ? Math.round(value.net_amount * 100) : null;
  return (
    <section class="financial-summary" aria-label="Стоимость · только владельцу">
      {preview && value.items && value.items.length > 0 && (
        <ul class="quote-items">
          {value.items.map((item, index) => {
            const price = customerPrice(item);
            return (
              <li key={item.task_id || item.work_code || index}>
                <strong>{workName(item.work_code || '')}</strong>
                <span>{price == null ? 'Цена не указана' : money(price)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <dl data-price-kind="effective">
        <div>
          <dt>Итого для клиента</dt>
          <dd>{total == null ? 'Уточните цену работ' : money(total)}</dd>
        </div>
      </dl>
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
