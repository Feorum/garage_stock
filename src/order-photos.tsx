import { useEffect, useRef, useState } from 'preact/hooks';
import './order-photos.css';
import { instantLabel } from './shift-model';
import type { Client } from './workspace-types';

const bucket = 'garage-order-photos';
const formats = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/avif', 'avif']]);
const maxBytes = 20 * 1024 * 1024;
const pageSize = 50;
type Photo = { name: string; created_at: string };

export function OrderPhotos({ client, orderId, custom = false, upload = false, offline = false, initialLoad = false }: {
  client: Client; orderId: string; custom?: boolean; upload?: boolean; offline?: boolean; initialLoad?: boolean;
}) {
  const folder = custom ? 'custom/' + orderId : orderId;
  const [files, setFiles] = useState<Photo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  const running = useRef(false);
  const offset = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const draft = useRef<{ file: File; name: string } | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function run(action: () => Promise<void>, error: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    setMessage('');
    try { await action(); }
    catch {
      if (active.current) { setFailed(true); setMessage(error); }
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function list(append = false) {
    const start = append ? offset.current : 0;
    const { data, error } = await client.storage.from(bucket).list(folder, {
      limit: pageSize, offset: start, sortBy: { column: 'created_at', order: 'desc' },
    });
    if (error) throw error;
    if (!active.current) return;
    offset.current = start + data.length;
    const next = append ? [...(files || []), ...data] : data;
    setFiles([...new Map(next.map(photo => [photo.name, photo])).values()]);
    setMore(data.length === pageSize);
  }
  function load(append = false) {
    setPreview('');
    void run(() => list(append), 'Не удалось загрузить список фотографий. Проверьте подключение и доступ к заказу.');
  }
  useEffect(() => {
    if (initialLoad && !offline) load();
  }, [initialLoad, offline, client, folder]);
  async function save() {
    const pending = draft.current;
    if (!pending || !upload) return;
    const store = client.storage.from(bucket);
    const { error } = await store.upload(folder + '/' + pending.name, pending.file, {
      contentType: pending.file.type, cacheControl: '0', upsert: false,
    });
    if (error) {
      // A retry following a lost reply may find the original immutable upload.
      const existing = await store.list(folder, { search: pending.name, limit: 1 });
      if (existing.error || !existing.data?.some(photo => photo.name === pending.name)) throw error;
    }
    draft.current = null;
    if (!active.current) return;
    try {
      await list();
      if (active.current) setMessage('Фото прикреплено.');
    } catch {
      if (active.current) { setFiles(null); setMessage('Фото прикреплено. Откройте список ещё раз.'); }
    }
  }
  function send() {
    void run(save, 'Не удалось подтвердить загрузку. Проверьте подключение и доступ к заказу.');
  }
  function pick(file?: File) {
    if (!file) return;
    const ext = formats.get(file.type);
    draft.current = null;
    if (!ext || !file.size || file.size > maxBytes) {
      setFailed(true);
      setMessage('Выберите фото JPEG, PNG, WebP или AVIF размером до 20 МБ.');
      return;
    }
    draft.current = { file, name: crypto.randomUUID() + '.' + ext };
    setPreview('');
    send();
  }
  function open(photo: Photo) {
    setPreview('');
    void run(async () => {
      // Authenticated download applies current order visibility on every opening.
      const { data, error } = await client.storage.from(bucket).download(folder + '/' + photo.name);
      if (error) throw error;
      if (active.current) setPreview(URL.createObjectURL(data));
    }, 'Не удалось открыть фото. Проверьте подключение и доступ к заказу.');
  }
  const disabled = offline || busy;
  return <section class="order-photos" aria-label="Фотопротокол">
    <h3>Фотопротокол</h3>
    <div class="button-row">
      {upload && <>
        <input hidden ref={input} type="file" accept={[...formats.keys()].join(',')}
          aria-label="Файл фотографии" onChange={e => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            pick(file);
          }} />
        <button type="button" class="button" disabled={disabled} onClick={() => input.current?.click()}>Прикрепить фото</button>
      </>}
      <button type="button" class="button" disabled={disabled} onClick={() => load()}>
        {files ? 'Обновить фотографии' : 'Показать фотографии'}
      </button>
    </div>
    {busy && <p role="status">Загрузка…</p>}
    {message && <p role={failed ? 'alert' : 'status'}>{message}{' '}
      {failed && upload && draft.current && <button type="button" class="button" disabled={disabled} onClick={send}>Повторить загрузку</button>}
    </p>}
    {files && (files.length ? <ul class="photo-list">{files.map((photo, index) => <li key={photo.name}>
      <button class="button" type="button" disabled={disabled} onClick={() => open(photo)}>
        Фото {index + 1} · {instantLabel(photo.created_at)}
      </button>
    </li>)}</ul> : <p>Фотографий пока нет.</p>)}
    {files && more && <button type="button" class="button" disabled={disabled} onClick={() => load(true)}>Ещё фотографии</button>}
    {preview && <figure class="photo-preview">
      <img src={preview} alt="Фотография автомобиля по заказу" />
      <figcaption><button type="button" class="button" onClick={() => setPreview('')}>Закрыть фото</button></figcaption>
    </figure>}
  </section>;
}
