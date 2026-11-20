import './owner-workflow.css';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { customerPrice, money, decimal, hundredths, payRead, type Payout, type PrivatePricing } from './pay-model';
import { isConflict } from './owner-model';
import type { GarageClient } from './shift-model';

export function PayoutSummary({ payout }: { payout: Payout }) {
  const proposed = payout.pool_kopeks == null;
  const amount = proposed ? payout.suggested_pool_kopeks : payout.pool_kopeks;
  const shares = proposed ? payout.suggested_shares : payout.shares;
  if (proposed && payout.suggested_pool_kopeks === undefined) return null;
  return (
    <section
      class="payout-summary"
      aria-label={proposed ? 'Предложение по оплате' : 'Сохранённое распределение'}
    >
      <h4>{proposed ? 'Предложение по оплате' : 'Сохранённое распределение'}</h4>
      <p>
        {amount == null
          ? 'Ставка не указана. Введите сумму при распределении.'
          : (proposed ? 'По прайсу · ' : 'Сумма механикам · ') + money(amount)}
      </p>
      {Boolean(shares?.length) && (
        <ul>
          {shares!.map((s) => (
            <li key={s.mechanic_id}>
              {s.name} · {s.kopeks == null ? 'Сумма не указана' : money(s.kopeks)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TaskPricing({
  client,
  taskId,
  value,
  reload,
  onClose,
}: {
  client: GarageClient;
  taskId: string;
  value: PrivatePricing;
  reload(): Promise<void>;
  onClose?(message?: string): void;
}) {
  const [edit, setEdit] = useState(Boolean(onClose));
  const [base, setBase] = useState(value.private_version ?? 0);
  const [amount, setAmount] = useState(value.override_kopeks == null ? '' : decimal(value.override_kopeks));
  const [memo, setMemo] = useState(value.private_comment || '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef({ key: '', id: '' });
  const sending = useRef(false);
  const amountInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (edit) amountInput.current?.focus(); }, [edit]);
  const stale = conflict || (edit && base !== value.private_version);
  function open() {
    setBase(value.private_version ?? 0);
    setAmount(value.override_kopeks == null ? '' : decimal(value.override_kopeks));
    setMemo(value.private_comment || '');
    setConflict(false);
    setError('');
    setSaved(false);
    setEdit(true);
  }
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (sending.current || stale) return;
    const cents = amount.trim() ? hundredths(amount) : null;
    if (amount.trim() && cents == null) return setError('Введите сумму в BYN с точностью до копейки.');
    const args = {
      p_task_id: taskId,
      p_expected_version: base,
      p_override_kopeks: cents,
      p_private_comment: memo.trim(),
    };
    const key = JSON.stringify(args);
    if (request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await payRead(client, 'garage_save_task_pricing', { ...args, p_request_id: request.current.id });
      request.current = { key: '', id: '' };
      setEdit(false);
      setSaved(true);
      try {
        await reload();
      } catch {
        const message = 'Стоимость сохранена. Обновите данные заказа.';
        if (onClose) onClose(message);
        else setError(message);
        return;
      }
      onClose?.('Стоимость и комментарий сохранены.');
    } catch (failure) {
      if (isConflict(failure)) {
        setConflict(true);
        setError('Стоимость или комментарий изменились в другой сессии.');
        await reload().catch(() => {});
      } else setError('Сохранение не подтверждено. Проверьте связь и повторите попытку.');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const price = customerPrice(value);
  return (
    <section class="owner-task-price" aria-label="Стоимость работы · только владельцу">
      {!onClose && <dl class="task-price-values">
        <div>
          <dt>Цена для клиента</dt>
          <dd>{price == null ? 'Цена не указана' : money(price)}</dd>
        </div>
      </dl>}
      {!onClose && value.private_comment && (
        <p class="owner-private-comment">
          <strong>Личный комментарий владельца</strong>
          <br />
          {value.private_comment}
        </p>
      )}
      {edit ? (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>Стоимость для клиента</legend>
            <label>
              Стоимость работы, BYN
              <input
                type="text"
                ref={amountInput}
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                placeholder={value.catalogue_kopeks != null ? decimal(value.catalogue_kopeks) : undefined}
                onInput={(e) => setAmount(e.currentTarget.value)}
              />
            </label>
            <small>
              {value.catalogue_kopeks == null ? 'Цена в прайсе не указана.' :
                `По прайсу — ${money(value.catalogue_kopeks)}. Оставьте поле пустым, чтобы применить эту цену.`}
            </small>
            <label>
              Личный комментарий владельца
              <textarea maxLength={2000} value={memo} onInput={(e) => setMemo(e.currentTarget.value)} />
            </label>
            {stale && (
              <div class="notice">
                <p>Ваш ввод сохранён. Актуальная цена: {price == null ? 'не указана' : money(price)}.
                  {value.private_comment && ' Комментарий: ' + value.private_comment}</p>
                {base !== value.private_version ? (
                  <button
                    class="button"
                    type="button"
                    onClick={() => {
                      setBase(value.private_version!);
                      setConflict(false);
                      setError('');
                    }}
                  >
                    Продолжить с моими значениями
                  </button>
                ) : (
                  <button class="button" type="button" onClick={() => void reload().catch(() => {})}>
                    Обновить стоимость
                  </button>
                )}
              </div>
            )}
            <div class="button-row">
              <button class="button button-primary" type="submit" disabled={stale}>
                Сохранить стоимость
              </button>
              <button
                class="button"
                type="button"
                onClick={() => {
                  setEdit(false);
                  setError('');
                  onClose?.();
                }}
              >
                Отмена
              </button>
            </div>
          </fieldset>
        </form>
      ) : (
        !onClose && value.private_version != null && (
          <button class="button" type="button" onClick={open}>
            Изменить стоимость
          </button>
        )
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Стоимость и комментарий сохранены.</p>}
    </section>
  );
}
