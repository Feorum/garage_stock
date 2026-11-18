import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { installRussianValidation } from './locale.js';

installRussianValidation();
const callback = new URL(location.href);
const hash = new URLSearchParams(callback.hash.slice(1));
const invalid =
  [hash, callback.searchParams].some((params) => params.has('error') || params.has('error_description')) ||
  callback.searchParams.has('code') ||
  callback.searchParams.has('token_hash');

function Account() {
  const [state, setState] = useState<'checking' | 'form' | 'invalid' | 'saved'>('checking');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    async function verify() {
      try {
        const { sb } = await import('./supabase.js');
        const result = await sb.auth.getSession();
        history.replaceState(null, '', location.pathname);
        if (invalid || result.error || !result.data.session) throw new Error();
        const user = await sb.auth.getUser();
        if (user.error || !user.data.user) throw new Error();
        if (active) setState('form');
      } catch {
        if (active) setState('invalid');
      } finally {
        history.replaceState(null, '', location.pathname);
      }
    }
    void verify();
    return () => {
      active = false;
    };
  }, []);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving.current) return;
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const password = String(values.get('password') ?? '');
    if (password.length < 12) return setFeedback('Используйте не менее 12 символов.');
    if (password !== values.get('confirm-password')) return setFeedback('Пароли не совпадают.');
    saving.current = true;
    setBusy(true);
    setFeedback('Сохраняем пароль…');
    try {
      const { sb } = await import('./supabase.js');
      const result = await sb.auth.updateUser({ password });
      if (result.error) throw result.error;
      setState('saved');
      setFeedback('');
    } catch {
      setFeedback('Не удалось сохранить пароль. Проверьте подключение и повторите попытку.');
    } finally {
      form.reset();
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <section class="login-panel account-card">
      <span class="wordmark">
        Garage<span>/</span>
      </span>
      <h1 id="title">{state === 'saved' ? 'Пароль сохранён' : 'Учётная запись'}</h1>
      {state === 'checking' && <p role="status">Проверяем ссылку на учётную запись…</p>}
      {state === 'invalid' && (
        <>
          <p>Ссылка отсутствует, недействительна или срок её действия истёк.</p>
          <p>Если пароль уже задан, откройте Garage и войдите. Для новой ссылки обратитесь к владельцу.</p>
        </>
      )}
      {state === 'saved' && <p>При следующем входе используйте адрес электронной почты и новый пароль.</p>}
      {state === 'form' && (
        <form class="login-form" id="password-form" onSubmit={save}>
          <p>Придумайте пароль длиной не менее 12 символов.</p>
          <label for="password">Новый пароль</label>
          <input
            type="password"
            id="password"
            name="password"
            required
            minLength={12}
            autoComplete="new-password"
          />
          <label for="confirm-password">Повторите новый пароль</label>
          <input
            type="password"
            id="confirm-password"
            name="confirm-password"
            required
            minLength={12}
            autoComplete="new-password"
          />
          <button id="save-password" class="button button-primary" disabled={busy}>
            Сохранить пароль
          </button>
        </form>
      )}
      <p id="message" role="status">
        {feedback}
      </p>
      {state !== 'checking' && (
        <a class="button" id="open-app" href="index.html">
          Открыть Garage
        </a>
      )}
    </section>
  );
}
render(<Account />, document.getElementById('account')!);
