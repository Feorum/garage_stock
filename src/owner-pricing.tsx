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
  inline = false,
  onSaved,
}: {
  client: GarageClient;
  taskId: string;
  value: PrivatePricing;
  reload(): Promise<void>;
  inline?: boolean;
  onSaved?(): void;
}) {
  const [edit, setEdit] = useState(false);
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
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (edit) {
      amountInput.current?.focus();
      if (inline) amountInput.current?.select();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [edit]);
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
  function close() {
    restoreFocus.current = true;
    setEdit(false);
    setError('');
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
      onSaved?.();
      try {
        await reload();
        close();
        setSaved(true);
      } catch {
        close();
        setError('Стоимость сохранена. Обновите данные заказа.');
      }
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
  const placeholder = inline ? price : value.catalogue_kopeks;
  const display = price == null ? 'Цена не указана' : money(price);
  const comment = <textarea aria-label="Личный комментарий владельца" maxLength={2000}
    value={memo} onInput={e => setMemo(e.currentTarget.value)} />;
  return (
    <section class={inline ? 'job-inline-price' : 'owner-task-price'} aria-label="Стоимость работы · только владельцу">
      {!inline && <dl class="task-price-values"><div><dt>Цена для клиента</dt><dd>{display}</dd></div></dl>}
      {!inline && value.private_comment && <p class="owner-private-comment">
        <strong>Личный комментарий владельца</strong><br />{value.private_comment}
      </p>}
      {edit ? (
        <form class={inline ? 'money-row-form' : undefined} onSubmit={submit} onKeyDown={event => {
          if (inline && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!sending.current) close();
          }
        }}>
          <fieldset disabled={busy}>
            {!inline && <legend>Стоимость для клиента</legend>}
            <div class={inline ? 'money-row-controls' : undefined}>
              <label>
                {!inline && 'Стоимость работы, BYN'}
                <input type="text" ref={amountInput} inputMode="decimal" autoComplete="off"
                  aria-label="Стоимость работы, BYN" value={amount}
                  placeholder={placeholder == null ? undefined : decimal(placeholder)}
                  onInput={e => setAmount(e.currentTarget.value)} />
              </label>
              {inline && <button class="button button-primary" type="submit" aria-label="Сохранить стоимость" disabled={stale}>Сохранить</button>}
              {inline && <button class="button" type="button" onClick={close}>Отмена</button>}
            </div>
            <small>
              {value.catalogue_kopeks == null ? 'Цена в прайсе не указана.' :
                `По прайсу — ${money(value.catalogue_kopeks)}. Оставьте поле пустым, чтобы применить эту цену.`}
            </small>
            {inline ? <details>
              <summary>Личный комментарий</summary>{comment}
            </details> : <label>Личный комментарий владельца{comment}</label>}
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
            {!inline && <div class="button-row">
              <button class="button button-primary" type="submit" disabled={stale}>Сохранить стоимость</button>
              <button class="button" type="button" onClick={close}>Отмена</button>
            </div>}
          </fieldset>
        </form>
      ) : value.private_version != null && (
        <button ref={trigger} class={inline ? 'money-row-value job-amount' : 'button'} type="button"
          aria-label={inline ? 'Изменить стоимость · ' + display : undefined}
          disabled={busy} onClick={open}>{inline ? display : 'Изменить стоимость'}</button>
      )}
      {inline && !edit && value.private_comment && <p class="owner-private-comment">{value.private_comment}</p>}
      {error && <p role="alert">{error}</p>}
      {saved && <small class={inline ? 'sr-only' : undefined} role="status">
        {inline ? 'Стоимость сохранена.' : 'Стоимость и комментарий сохранены.'}
      </small>}
    </section>
  );
}
