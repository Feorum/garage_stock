import { useRef, useState } from 'preact/hooks';
import { decimal, hundredths, money } from './pay-model';
import { Price } from './owner-summary';
import { errorText, read, type Money, type CommercialTerms } from './owner-model';
import type { GarageClient } from './shift-model';

export function OwnerCommercial({ client, orderId, terms, refresh, summary }: {
  client: GarageClient; orderId: string; terms: CommercialTerms; refresh(): Promise<void>; summary?: Money;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [basis, setBasis] = useState(terms.basis);
  const [version, setVersion] = useState(terms.version);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [message, setMessage] = useState('');
  function edit() {
    setAmount(terms.agreed_total_kopeks == null ? '' : decimal(terms.agreed_total_kopeks));
    setBasis(terms.basis);
    setVersion(terms.version);
    setEditing(true);
    setMessage('');
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (sending.current || terms.version !== version) return;
    const cents = amount.trim() ? hundredths(amount) : null;
    if (amount.trim() && cents == null) { setMessage('Введите сумму в BYN с точностью до копейки.'); return; }
    sending.current = true;
    setBusy(true);
    try {
      await read(client, 'garage_save_commercial', { p_order_id: orderId, p_expected_version: version,
        p_agreed_total_kopeks: cents, p_basis: basis });
      setEditing(false);
      window.dispatchEvent(new CustomEvent('garage-order-finance-updated', { detail: orderId }));
      setMessage('Условия заказа сохранены.');
      try { await refresh(); } catch { setMessage('Условия сохранены. Обновите заказ для просмотра расчёта.'); }
    } catch (failure) {
      setMessage(errorText(failure));
      await refresh().catch(() => {});
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const internal = terms.internal_total_kopeks;
  const base = terms.basis_total_kopeks;
  return <section class="order-commercial" aria-label="Договорная цена и база расчёта">
    {summary ? <Price value={summary} edit={editing ? undefined : edit} /> : <h3>Договорная цена и база расчёта</h3>}
    {editing ? <form onSubmit={save}><fieldset disabled={busy}>
      <label>Договорная сумма за заказ, BYN<input type="text" inputMode="decimal" placeholder="По ценам работ"
        value={amount} onInput={e => setAmount(e.currentTarget.value)} /></label>
      <label>От какой суммы считать 80%<select value={basis} onChange={e => setBasis(e.currentTarget.value as CommercialTerms['basis'])}>
        <option value="catalogue">Прайс б/н BYN</option>
        <option value="agreed">Согласованная цена для клиента</option>
      </select></label>
      {terms.version !== version && <p role="alert">Условия изменились.
        {' '}<button type="button" class="button" onClick={edit}>Загрузить текущие условия</button></p>}
      <div class="button-row"><button class="button button-primary" type="submit" disabled={terms.version !== version}>Сохранить условия</button>
        <button class="button" type="button" onClick={() => { setEditing(false); setMessage(''); }}>Отмена</button></div>
    </fieldset></form> : <>
      {!summary && <button class="button" type="button" onClick={edit}>Договорная сумма · {terms.agreed_total_kopeks == null ? 'по ценам работ' : money(terms.agreed_total_kopeks)}</button>}
      <dl class="act-parties">
        <div><dt>Основа расчёта</dt><dd>{terms.basis === 'catalogue' ? 'Прайс б/н BYN' : 'Согласованная цена'}{base != null && ' · ' + money(base)}</dd></div>
        <div><dt>Первые 20%</dt><dd>{base != null && internal != null ? money(base - internal) : 'Уточните цены'}</dd></div>
        <div><dt>Цена для расходников и зарплаты</dt><dd>{internal != null ? money(internal) : 'Уточните цены'}</dd></div>
      </dl>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
