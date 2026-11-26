import { useEffect, useRef, useState } from 'preact/hooks';
import { isConflict, read } from './owner-model';
import type { GarageClient } from './shift-model';
import './owner-order-note.css';

interface Props { client: GarageClient; orderId: string; custom?: boolean }
interface Note { note: string; version: number }

export function OwnerOrderNote(props: Props) {
  return <NoteEditor key={String(!!props.custom) + props.orderId} {...props} />;
}

function NoteEditor({ client, orderId, custom = false }: Props) {
  const [saved, setSaved] = useState<Note | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState('');
  const sending = useRef(false);
  const mounted = useRef(false);
  const request = useRef<{ id: string; version: number; note: string }>();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setLoadError(false);
    read<Note>(client, 'garage_owner_order_note', { p_order_id: orderId, p_custom: custom })
      .then(value => {
        if (!value || typeof value.note !== 'string' || !Number.isInteger(value.version)) throw new Error();
        if (!current) return;
        setSaved(value);
        if (!conflict) setDraft(value.note);
      })
      .catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [client, orderId, custom, reload]);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!saved || sending.current || draft === saved.note) return;
    const note = draft;
    if (request.current?.note !== note || request.current.version !== saved.version) {
      request.current = { id: crypto.randomUUID(), note, version: saved.version };
    }
    sending.current = true;
    setBusy(true);
    setMessage('');
    try {
      const value = await read<Note>(client, 'garage_save_owner_order_note', {
        p_order_id: orderId, p_custom: custom, p_expected_version: saved.version,
        p_note: note, p_request_id: request.current.id,
      });
      if (!value || value.note !== note || value.version !== saved.version + 1) throw new Error();
      if (mounted.current) {
        request.current = undefined;
        setSaved(value);
        setConflict(false);
        setMessage('Комментарий сохранён.');
      }
    } catch (error) {
      if (!mounted.current) return;
      if (isConflict(error)) {
        setConflict(true);
        setSaved(null);
        setReload(n => n + 1);
      } else {
        setMessage('Не удалось подтвердить сохранение. Повторите попытку.');
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section class="owner-order-note" aria-label="Комментарий к заказу">
    <form onSubmit={save}>
      <label>Комментарий к заказу
        <textarea rows={2} maxLength={4000} value={draft} disabled={!saved || busy}
          placeholder="Добавить комментарий…" onInput={e => { setDraft(e.currentTarget.value); setMessage(''); }} />
      </label>
      {conflict && saved && <div class="owner-order-note-conflict">
        <p>Комментарий изменился в другой сессии. Сохранённый текст</p>
        <blockquote>{saved.note || 'Пустой комментарий'}</blockquote>
      </div>}
      <div class="owner-order-note-actions">
        <span role="status">{loadError ? 'Не удалось загрузить комментарий.' :
          !saved ? 'Загружаем комментарий…' : busy ? 'Сохраняем…' : message}</span>
        {loadError ? <button class="button" type="button" onClick={() => setReload(n => n + 1)}>Повторить</button> :
          <button class="button" type="submit" disabled={!saved || busy || draft === saved.note}>
            {conflict ? 'Сохранить мой вариант' : 'Сохранить комментарий'}
          </button>}
      </div>
    </form>
  </section>;
}
