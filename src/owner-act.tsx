import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { read, type Money, type OwnerOrder } from './owner-model';
import { money } from './pay-model';
import { actWorkLines } from './act-amounts.js';
import { actVehicleName } from './vehicle-models';
import type { GarageClient } from './shift-model';
import { actQuote, actJobs, downloadAct, fieldsFrom, templateBytes, type ActRecord, type ActFields, type ActFormat } from './owner-act-model';
import './owner-act.css';

interface Props {
  order: OwnerOrder;
  client: GarageClient;
  price: Money | null;
  refreshPrice(): Promise<Money>;
  refreshOrder(): Promise<void>;
}

export function OwnerAct(props: Props) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const toggle = useRef<HTMLButtonElement>(null);
  function close(message = '') {
    setOpen(false);
    setNotice(message);
    requestAnimationFrame(() => toggle.current?.focus({ preventScroll: true }));
  }
  return <section class="owner-act" aria-label="Акт выполненных работ">
    {open
      ? <ActForm {...props} close={close} />
      : <button ref={toggle} class="button" type="button" onClick={() => { setNotice(''); setOpen(true); }}>
          Скачать акт (.docx)
        </button>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

function ActForm({ order, client, price, refreshPrice, refreshOrder, close }: Props & { close(message?: string): void }) {
  const [record, setRecord] = useState<ActRecord | null>(null);
  const [mode, setMode] = useState<ActFormat>('weighted');
  const [fields, setFields] = useState<ActFields | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [retryReason, setRetryReason] = useState('');
  const alive = useRef(false);
  const sending = useRef(false);
  const firstField = useRef<HTMLInputElement>(null);
  const orderVersion = useRef(order.version);
  orderVersion.current = order.version;

  async function load(why = '') {
    setBusy(true);
    setMessage('');
    try {
      if (why === '40001') {
        await refreshOrder();
        if (!alive.current) return;
        await refreshPrice();
      }
      const fresh = await read<ActRecord>(client, 'garage_act_get', { p_order_id: order.id });
      if (!alive.current) return;
      setFields(previous => {
        const next = fieldsFrom(fresh);
        // A different order can claim the suggestion while this form is open.
        if (why === '23505' && previous && !fresh.number) {
          return { ...previous, number: next.number };
        }
        if (why === '40001' && previous && fresh.version === record?.version) return previous;
        return next;
      });
      setRecord(fresh);
      if (!why || fresh.version !== record?.version) setMode(fresh.act_format ?? 'weighted');
      setRetryReason('');
      setMessage(why === '23505' ? 'Этот номер уже занят. Проверьте следующий номер и скачайте акт.'
        : why === '40001' ? 'Заказ или акт изменился. Проверьте обновлённые работы, сумму и реквизиты перед скачиванием.' : '');
    } catch (error) {
      if (!alive.current) return;
      setRetryReason(why || 'initial');
      setMessage((error as { code?: string }).code === '55000'
        ? 'Шаблон акта ещё не настроен.' : 'Не удалось загрузить реквизиты акта.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  useLayoutEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [client, order.id]);
  useLayoutEffect(() => {
    firstField.current?.focus({ preventScroll: true });
  }, [record]);

  const quote = record?.pricing_snapshot ?? (price ? actQuote(order, price) : null);
  const agreed = quote?.agreed_total_kopeks ?? null;
  const layout = agreed == null ? 'weighted' : mode;
  const preview = quote ? actJobs(order, quote, layout) : [];
  const unpriced = layout === 'names' ? [] : preview.filter(job => job.kopeks == null);
  const lineTotal = preview.reduce((sum, job) => sum + (job.kopeks ?? 0), 0);
  const wrongDiscount = layout === 'discount' && agreed != null && agreed > lineTotal;
  const total = agreed ?? lineTotal;
  const month = fields?.actDate.slice(5, 7) || '';
  const serial = fields?.number.split('/')[0] ?? '';
  const mismatch = Boolean(record?.number && record.number.split('/')[1] !== month);

  function field(key: keyof ActFields, value: string) {
    setFields(current => current && { ...current, [key]: value });
    setMessage('');
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (sending.current || !fields || !record || !price || !quote || unpriced.length || !preview.length || mismatch || wrongDiscount) return;
    sending.current = true;
    setBusy(true);
    setMessage('');
    let phase: 'prices' | 'document' | 'save' = 'prices';
    try {
      const latest = await refreshPrice();
      if (!alive.current) return;
      const freshQuote = record.pricing_snapshot ?? actQuote(order, latest);
      if (orderVersion.current !== order.version || JSON.stringify(quote) !== JSON.stringify(freshQuote)) {
        setMessage('Состав работ или цены изменились. Проверьте заказ и скачайте акт ещё раз.');
        return;
      }
      const expectedAmounts = latest.commercial || record.pricing_snapshot
        ? { mode: layout, quote: freshQuote } : freshQuote.allocated;
      const data = { ...fields, number: record.number || serial + '/' + month,
        contractNumber: fields.contractNumber.trim(), vin: fields.vin.trim(), vehicle: actVehicleName(order.vehicle, order.vehicle_group_code),
        jobs: preview, mode: layout, agreedTotal: agreed };
      phase = 'document';
      const [generator, chunks] = await Promise.all([import('./act-document'), read<string[]>(client, 'garage_act_template')]);
      if (!alive.current) return;
      const file = await generator.generateActDocument(templateBytes(chunks), data);
      const filename = generator.actFilename(data);
      if (!alive.current) return;
      if (orderVersion.current !== order.version) {
        setMessage('Заказ изменился. Проверьте работы и скачайте акт ещё раз.');
        return;
      }
      phase = 'save';
      const saved = await read<ActRecord>(client, 'garage_act_save', {
        p_order_id: order.id, p_number: data.number, p_contract_number: data.contractNumber,
        p_contract_date: data.contractDate, p_act_date: data.actDate, p_vin: data.vin, p_expected_version: record.version,
        p_expected_order_version: order.version, p_expected_amounts: expectedAmounts,
      });
      if (!alive.current) return;
      if (saved.number !== data.number) {
        await load('40001');
        return;
      }
      downloadAct(file, filename);
      close('Акт № ' + saved.number + ' готов к скачиванию.');
    } catch (failure) {
      if (!alive.current) return;
      const code = (failure as { code?: string }).code;
      if (phase === 'save' && (code === '23505' || code === '40001')) await load(code);
      else if (code === '42501') setMessage('Для скачивания акта нужен доступ владельца.');
      else if (code === '22023') setMessage('Проверьте номер, даты, VIN и реквизиты договора.');
      else if (phase === 'prices') setMessage('Не удалось проверить цены выполненных работ. Обновите заказ и повторите попытку.');
      else if (phase === 'document') setMessage('Не удалось сформировать документ. Проверьте доступность шаблона и повторите попытку.');
      else setMessage('Сохранение реквизитов не подтверждено. Повторите с теми же данными.');
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <form onSubmit={submit} class="act-form">
    <h3>Акт выполненных работ</h3>
    {record && fields && <>
      <dl class="act-parties">
        <div><dt>Заказчик</dt><dd>{record.customer_name}</dd></div>
        <div><dt>Исполнитель</dt><dd>{record.contractor_name}</dd></div>
      </dl>
      <fieldset disabled={busy || Boolean(retryReason)}>
        <div class="act-fields">
          <label>Номер акта
            {record.number ? <input ref={firstField} value={record.number} readOnly /> :
              <span class="act-serial"><input ref={firstField} type="text" aria-label="Номер акта" inputMode="numeric" maxLength={15} pattern="[1-9][0-9]{0,14}" required
                value={serial} onInput={e => field('number', e.currentTarget.value)} /><span>/{month}</span></span>}
          </label>
          <label>Дата акта<input type="date" required min="0001-01-01" max="9999-12-31" value={fields.actDate}
            onInput={e => field('actDate', e.currentTarget.value)} /></label>
          <label>Номер договора<input type="text" maxLength={120} required value={fields.contractNumber}
            onInput={e => field('contractNumber', e.currentTarget.value)} /></label>
          <label>Дата договора<input type="date" required min="0001-01-01" max="9999-12-31" value={fields.contractDate}
            onInput={e => field('contractDate', e.currentTarget.value)} /></label>
          <label>VIN для акта<input type="text" maxLength={40} required value={fields.vin}
            onInput={e => field('vin', e.currentTarget.value)} /></label>
        </div>
        {agreed != null && <label>Отображение договорной суммы
          <select value={layout} onChange={e => { setMode(e.currentTarget.value as ActFormat); setMessage(''); }}>
            <option value="weighted">Пропорционально по работам</option>
            <option value="discount">Исходные цены и скидка отдельной строкой</option>
            <option value="names">Названия работ и общий итог</option>
          </select>
        </label>}
        {preview.length > 0 && <ul aria-label="Работы в акте">
          {actWorkLines(preview, layout !== 'names').map(line => <li key={line.label}>
            {line.label}{line.kopeks != null && ' · ' + money(line.kopeks)}
          </li>)}
          {layout === 'discount' && agreed != null && !unpriced.length && lineTotal > agreed && <li>Скидка · −{money(lineTotal - agreed)}</li>}
        </ul>}
        {wrongDiscount && <p role="alert">Договорная сумма превышает сумму работ. Выберите другой формат акта.</p>}
        {mismatch && <p role="alert">Месяц даты должен совпадать с месяцем сохранённого номера акта.</p>}
        {unpriced.length > 0 && <p role="alert">Укажите цену для клиента в строках работ: {unpriced.map(job => job.name).join(', ')}.</p>}
        {!preview.length && <p role="status">{price ? 'В заказе нет выполненных работ.' : 'Ожидаем цены работ.'}</p>}
        {preview.length > 0 && !unpriced.length && <p>Итого по акту <strong>{money(total)}</strong></p>}
      </fieldset>
    </>}
    {message && <p role="alert">{message}</p>}
    {busy && <p role="status">{sending.current ? 'Готовим документ…' : 'Загружаем реквизиты…'}</p>}
    <div class="button-row">
      <button class="button" type="button" disabled={sending.current} onClick={() => close()}>Закрыть</button>
      {retryReason ? <button class="button" type="button" disabled={busy} onClick={() => void load(retryReason)}>Повторить загрузку</button>
        : record && <button type="submit" class="button button-primary"
            disabled={busy || !price || !preview.length || Boolean(unpriced.length) || wrongDiscount || mismatch}>Скачать Word</button>}
    </div>
  </form>;
}
