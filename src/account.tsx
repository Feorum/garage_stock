import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { User } from '@supabase/supabase-js';
import { installRussianValidation } from './locale.js';

installRussianValidation();
const callback = new URL(location.href);
const hash = new URLSearchParams(callback.hash.slice(1));
// Secure email change sends two links. The first redirects without a session.
const confirmOtherEmail = [hash, callback.searchParams].some(params =>
  params.get('message')?.startsWith('Confirmation link accepted. Please proceed to confirm link sent to the other email'));
const passwordLink = ['invite', 'recovery'].includes(hash.get('type') || '');
const invalid =
  [hash, callback.searchParams].some((params) => params.has('error') || params.has('error_description')) ||
  callback.searchParams.has('code') || callback.searchParams.has('token_hash');

function NameForm({ userId }: { userId: string }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [feedback, setFeedback] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    setFeedback('');
    async function load() {
      try {
        const { sb } = await import('./supabase.js');
        const { data, error } = await sb.from('profiles').select('name').eq('id', userId).single();
        if (error || !data) throw new Error();
        if (active) { setSaved(data.name); setName(data.name); }
      } catch {
        if (active) setFeedback('Не удалось загрузить имя профиля.');
      }
    }
    void load();
    return () => { active = false; };
  }, [userId, attempt]);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (lock.current || saved === null || !name.trim()) return;
    lock.current = true;
    setBusy(true);
    setFeedback('');
    try {
      const { sb } = await import('./supabase.js');
      const { data, error } = await sb.rpc('garage_update_profile_name', { p_name: name.trim() });
      if (error?.code === '23505') { setFeedback('Это имя уже занято. Выберите другое.'); return; }
      if (error?.code === '22023') { setFeedback('Введите имя до 120 символов без @ и управляющих символов.'); return; }
      if (error || typeof data !== 'string') throw new Error();
      setSaved(data);
      setName(data);
      setFeedback('Имя сохранено.');
    } catch {
      setFeedback('Не удалось сохранить имя. Проверьте подключение и повторите попытку.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return <form class="login-form profile-field-form" onSubmit={submit}>
    <label for="profile-name">Имя для входа</label>
    <input id="profile-name" name="name" autoComplete="username" required value={name}
      onInput={e => { setName(e.currentTarget.value); setFeedback(''); }} disabled={busy || saved === null} />
    {saved === null && feedback
      ? <button class="button button-small" type="button" onClick={() => setAttempt(n => n + 1)}>Повторить</button>
      : <button class="button button-small" type="submit" disabled={busy || saved === null || !name.trim() || name.trim() === saved}>
        Сохранить имя
      </button>}
    <p class="form-feedback" role="status">{feedback}</p>
  </form>;
}

function EmailForm({ user }: { user: User }) {
  const [current, setCurrent] = useState(user.email || '');
  const [pending, setPending] = useState(user.new_email || '');
  const [email, setEmail] = useState(user.email || '');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  // Confirmation may arrive in another tab while this form is still open.
  useEffect(() => {
    const confirmed = user.email || '';
    setEmail(draft => draft === current ? confirmed : draft);
    setCurrent(confirmed);
    setPending(user.new_email || '');
  }, [user.email, user.new_email]);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFeedback('');
    const address = email.trim();
    try {
      const { sb } = await import('./supabase.js');
      if (address.toLowerCase().endsWith('@accounts.garage.invalid')) {
        setFeedback('Укажите действующий адрес электронной почты.');
        return;
      }
      const { data, error } = await sb.auth.updateUser({ email: address }, {
        emailRedirectTo: new URL('account.html', location.href).href,
      });
      if (error || !data.user) {
        setFeedback(error?.status === 429 ? 'Слишком много запросов. Повторите попытку позже.' :
          'Не удалось сменить почту. Проверьте адрес и повторите попытку.');
        return;
      }
      const confirmed = data.user.email || current;
      setCurrent(confirmed);
      setEmail(confirmed);
      if (confirmed.toLowerCase() === address.toLowerCase()) {
        setPending('');
        setFeedback('Электронная почта изменена.');
      } else {
        setPending(data.user.new_email || address);
      }
    } catch {
      setFeedback('Не удалось сменить почту. Проверьте подключение и повторите попытку.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (current.toLowerCase().endsWith('@accounts.garage.invalid')) {
    return <div class="profile-field-form">
      <p>Почта не указана. Вход доступен по имени.</p>
      <p class="field-hint">Чтобы добавить почту для входа и восстановления пароля, обратитесь к владельцу.</p>
    </div>;
  }

  return <form class="login-form profile-field-form" onSubmit={submit}>
    <label for="profile-email">Электронная почта</label>
    <input id="profile-email" type="email" autoComplete="email" required value={email} disabled={busy}
      onInput={e => { setEmail(e.currentTarget.value); setFeedback(''); }} />
    <button class="button button-small" type="submit" disabled={busy || !email.trim() || email.trim().toLowerCase() === current.toLowerCase()}>
      Сменить почту
    </button>
    <p class="form-feedback" role="status">{feedback}</p>
    {pending && <p class="profile-pending" role="status">Ожидает подтверждения адрес {pending}. Проверьте письма о смене почты.</p>}
  </form>;
}

function PasswordForm({ onSaved }: { onSaved?: () => void }) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving.current) return;
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const password = String(values.get('password') ?? '');
    if ([...password].length < 12) return setFeedback('Используйте не менее 12 символов.');
    if (new TextEncoder().encode(password).length > 72) return setFeedback('Используйте пароль длиной до 72 байт.');
    if (password !== values.get('confirm-password')) return setFeedback('Пароли не совпадают.');
    saving.current = true;
    setBusy(true);
    setFeedback('Сохраняем пароль…');
    try {
      const { sb } = await import('./supabase.js');
      const { error } = await sb.auth.updateUser({ password });
      if (error?.code === 'reauthentication_needed') {
        setFeedback('Войдите в Garage заново, затем повторите смену пароля.');
        return;
      }
      if (error) throw error;
      setFeedback('Пароль сохранён.');
      onSaved?.();
    } catch {
      setFeedback('Не удалось сохранить пароль. Проверьте подключение и повторите попытку.');
    } finally {
      form.reset();
      saving.current = false;
      setBusy(false);
    }
  }
  return <form class="login-form" id="password-form" onSubmit={save}>
    <p>Придумайте пароль длиной не менее 12 символов.</p>
    <label for="password">Новый пароль</label>
    <input type="password" id="password" name="password" required minLength={12} autoComplete="new-password" />
    <label for="confirm-password">Повторите новый пароль</label>
    <input type="password" id="confirm-password" name="confirm-password" required minLength={12} autoComplete="new-password" />
    <button id="save-password" class="button button-primary" disabled={busy}>Сохранить пароль</button>
    <p id="message" class="form-feedback" role="status">{feedback}</p>
  </form>;
}

function Account() {
  const [state, setState] = useState<'checking' | 'form' | 'invalid' | 'saved' | 'confirm-email'>('checking');
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    async function verify() {
      try {
        if (confirmOtherEmail && !invalid) { setState('confirm-email'); return; }
        const { sb } = await import('./supabase.js');
        const result = await sb.auth.getSession();
        history.replaceState(null, '', location.pathname);
        if (invalid || result.error || !result.data.session) throw new Error();
        const expectedId = result.data.session.user.id;
        // Stop displaying and editing this profile if another tab changes the active account.
        if (!active) return;
        const subscription = sb.auth.onAuthStateChange((event, session) => {
          if (active && (event === 'SIGNED_OUT' || (session && session.user.id !== expectedId))) {
            active = false;
            setUser(null);
            setState('invalid');
          } else if (active && session?.user.id === expectedId && ['USER_UPDATED', 'SIGNED_IN'].includes(event)) {
            setUser(previous => previous ? session.user : null);
          }
        }).data.subscription;
        unsubscribe = () => subscription.unsubscribe();
        const verified = await sb.auth.getUser();
        if (verified.error || !verified.data.user || verified.data.user.id !== expectedId) throw new Error();
        const profile = await sb.from('profiles').select('id,active').eq('id', expectedId).single();
        if (profile.error || !profile.data || profile.data.active === false) throw new Error();
        if (active) { setUser(verified.data.user); setState('form'); }
      } catch {
        if (active) setState('invalid');
      } finally {
        history.replaceState(null, '', location.pathname);
      }
    }
    void verify();
    return () => { active = false; unsubscribe?.(); };
  }, []);
  return <section class="login-panel account-card">
    <span class="wordmark" aria-label="Garage"><span class="brand-mark" aria-hidden="true"><i /><i /><i /></span>Garage</span>
    <h1 id="title">{state === 'saved' ? 'Пароль сохранён' : passwordLink ? 'Установка пароля' : 'Мой профиль'}</h1>
    {state === 'checking' && <p role="status">Проверяем учётную запись…</p>}
    {state === 'confirm-email' && <p role="status">Откройте ссылку из письма во втором почтовом ящике, чтобы завершить смену адреса.</p>}
    {state === 'invalid' && <>
      <p>Ссылка отсутствует, недействительна или срок её действия истёк.</p>
      <p>Если пароль уже задан, откройте Garage и войдите. Для новой ссылки обратитесь к владельцу.</p>
    </>}
    {state === 'saved' && <p>При следующем входе используйте новый пароль.</p>}
    {state === 'form' && user && (passwordLink
      ? <PasswordForm onSaved={() => setState('saved')} />
      : <>
        <NameForm userId={user.id} />
        <EmailForm user={user} />
        <details class="profile-password"><summary>Изменить пароль</summary><PasswordForm /></details>
      </>)}
    {state !== 'checking' && <a class="button" id="open-app" href="index.html">Открыть Garage</a>}
  </section>;
}
render(<Account />, document.getElementById('account')!);
