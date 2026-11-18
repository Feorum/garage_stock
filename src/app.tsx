import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createAuthController } from './auth.js';
import { getSections, resolveRoute } from './navigation.js';
import { installRussianValidation } from './locale.js';
import type { Section as ShiftSection } from './shift-model';
import { ShiftView } from './shift';
import { OwnerOrders } from './owner-orders';
import { PayView } from './pay';
import { Reports } from './reports';
import { LedgerView } from './ledger-view';
import { SheetsView } from './sheets-view';
import type { Client, Profile, Navigate } from './workspace-types';

type Auth = ReturnType<typeof createAuthController>;
type State =
  | { status: 'loading' | 'signed_out' | 'error'; message?: string }
  | { status: 'ready'; profile: Profile };
const brand = (
  <span class="wordmark" aria-label="Garage">
    Garage<span aria-hidden="true">/</span>
  </span>
);

function SignIn({ auth, client, message }: { auth: Auth; client: Client; message?: string }) {
  const [feedback, setFeedback] = useState(message || '');
  const [loading, setLoading] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const locked = useRef(false);
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (locked.current) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const email = String(data.get('email') || '').trim();
    locked.current = true;
    setLoading(true);
    setFeedback('');
    try {
      if (recovery) {
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: new URL('account.html', location.href).href,
        });
        if (error) throw error;
        setFeedback('Если учётная запись существует, мы отправили ссылку на указанную почту.');
      } else {
        const result = await auth.signIn(email, String(data.get('password') || ''));
        if (result?.error) setFeedback(result.error);
        const password = form.elements.namedItem('password') as HTMLInputElement | null;
        if (password) password.value = '';
      }
    } catch {
      setFeedback('Не удалось связаться с сервисом. Проверьте подключение и повторите попытку.');
    } finally {
      locked.current = false;
      setLoading(false);
    }
  }
  return (
    <main id="main-content" tabIndex={-1} class="login-layout">
      <section class="login-panel">
        {brand}
        <h1>{recovery ? 'Восстановление пароля' : 'Вход в мастерскую'}</h1>
        <form class="login-form" onSubmit={submit}>
          <label for="email">Электронная почта</label>
          <input name="email" id="email" type="email" autoComplete="username" required />
          {!recovery && (
            <>
              <label for="password">Пароль</label>
              <input name="password" id="password" type="password" autoComplete="current-password" required />
            </>
          )}
          <button class="button button-primary" type="submit" disabled={loading}>
            {loading ? 'Подождите…' : recovery ? 'Получить ссылку' : 'Войти'}
          </button>
          <p class="form-feedback" role="status">
            {feedback}
          </p>
        </form>
        <button
          class="button button-small"
          type="button"
          disabled={loading}
          onClick={() => {
            setRecovery(!recovery);
            setFeedback('');
          }}
        >
          {recovery ? 'Вернуться ко входу' : 'Восстановить пароль'}
        </button>
      </section>
    </main>
  );
}

function Workspace({ auth, client, profile }: { auth: Auth; client: Client; profile: Profile }) {
  const [hash, setHash] = useState(location.hash);
  const [online, setOnline] = useState(navigator.onLine);
  const positions = useRef(new Map<string, number>());
  const main = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const previous = useRef(hash);
  const route = resolveRoute(profile.role, hash);
  const navigate: Navigate = (section, recordId) => {
    location.hash = recordId ? section + '/' + encodeURIComponent(recordId) : section;
  };
  useEffect(() => {
    const readHash = () => {
      positions.current.set(previous.current, window.scrollY);
      setHash(location.hash);
    };
    const net = () => setOnline(navigator.onLine);
    window.addEventListener('hashchange', readHash);
    window.addEventListener('offline', net);
    window.addEventListener('online', net);
    return () => {
      window.removeEventListener('hashchange', readHash);
      window.removeEventListener('offline', net);
      window.removeEventListener('online', net);
    };
  }, []);
  useLayoutEffect(() => {
    const revealActive = () => {
      const strip = nav.current;
      const selected = strip?.querySelector('a[aria-current="page"]');
      if (!strip || !selected || strip.scrollWidth <= strip.clientWidth) return;
      const row = strip.getBoundingClientRect(),
        tab = selected.getBoundingClientRect();
      if (tab.left < row.left) strip.scrollLeft += tab.left - row.left;
      else if (tab.right > row.right) strip.scrollLeft += tab.right - row.right;
    };
    revealActive();
    window.addEventListener('resize', revealActive);
    return () => window.removeEventListener('resize', revealActive);
  }, [route.section.id]);
  useLayoutEffect(() => {
    document.title = route.section.label + ' · Garage';
    if (previous.current === hash) return;
    previous.current = hash;
    const target = main.current?.querySelector<HTMLElement>('[data-route-heading]') || main.current;
    target?.focus({ preventScroll: true });
    window.scrollTo(0, positions.current.get(hash) ?? 0);
  }, [hash]);
  let screen;
  const props = { client, profile, navigate, section: route.id, recordId: route.record };
  if (profile.role === 'admin') {
    switch (route.id) {
      case 'orders':
        screen = <OwnerOrders {...props} />;
        break;
      case 'reports':
        screen = <Reports {...props} />;
        break;
      case 'ledger':
        screen = <LedgerView client={client} />;
        break;
      case 'sheets':
        screen = <SheetsView client={client} navigate={navigate} />;
        break;
      case 'pay':
        screen = <PayView client={client} profile={profile} recordId={route.record} />;
        break;
      default:
        screen = <ShiftView {...props} section="shift" />;
    }
  } else screen = <ShiftView {...props} section={route.id as ShiftSection} />;
  const roleName = profile.role === 'admin' ? 'Владелец' : 'Механик';
  return (
    <div class="workspace">
      <aside class="sidebar">
        <a class="brand-link" href="#shift" aria-label="Garage — смена">
          {brand}
        </a>
        <nav
          ref={nav}
          class="workspace-nav"
          aria-label={profile.role === 'admin' ? 'Кабинет владельца' : 'Кабинет механика'}
          data-workspace-role={profile.role}
        >
          {getSections(profile.role).map((item) => (
            <a
              key={item.id}
              class="nav-link"
              href={'#' + item.id}
              aria-current={route.section.id === item.id ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <div class="workspace-body">
        <header class="workspace-header">
          <span class={'connection' + (online ? '' : ' is-offline')} role="status">
            {online ? 'В сети' : 'Нет сети · изменения требуют подключения'}
          </span>
          <details class="account-menu">
            <summary>{profile.name || roleName}</summary>
            <div>
              <span>{roleName}</span>
              <a class="account-link" href="account.html">
                Учётная запись
              </a>
              <button class="button button-small" type="button" onClick={() => auth.signOut()}>
                Выйти
              </button>
            </div>
          </details>
        </header>
        <main ref={main} tabIndex={-1} id="main-content" class="workspace-main">
          <div class="page-heading">
            <h1>{route.section.label}</h1>
          </div>
          {screen}
        </main>
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const auth = useRef<Auth | null>(null);
  const client = useRef<Client | null>(null);
  useEffect(() => {
    let mounted = true;
    async function start() {
      try {
        const { sb } = await import('./supabase.js');
        if (!mounted) return;
        client.current = sb;
        auth.current = createAuthController(sb, {
          onChange: (next: State) => {
            if (mounted) setState(next);
          },
        });
        await auth.current.start();
      } catch {
        if (mounted) setState({ status: 'error', message: 'Проверьте подключение и повторите попытку.' });
      }
    }
    void start();
    return () => {
      mounted = false;
      auth.current?.destroy();
    };
  }, []);
  if (state.status === 'ready' && auth.current && client.current) {
    return (
      <Workspace
        key={state.profile.id + state.profile.role}
        profile={state.profile}
        auth={auth.current}
        client={client.current}
      />
    );
  }
  if (state.status === 'signed_out' && auth.current)
    return <SignIn auth={auth.current} client={client.current!} message={state.message} />;
  return (
    <main id="main-content" tabIndex={-1} class="startup">
      {brand}
      {state.status === 'error' && <h1>Не удалось открыть рабочее пространство</h1>}
      <p role="status">{('message' in state && state.message) || 'Открываем рабочее пространство…'}</p>
      {state.status === 'error' && (
        <div class="button-row">
          <button class="button" onClick={() => (auth.current ? auth.current.refresh() : location.reload())}>
            Повторить
          </button>
          {auth.current && (
            <button class="button" onClick={() => auth.current?.signOut()}>
              Выйти
            </button>
          )}
        </div>
      )}
    </main>
  );
}
installRussianValidation();
document.querySelector('.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  document.getElementById('main-content')?.focus();
});
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  navigator.serviceWorker.register('./sw.js').catch(() => {});
render(<App />, document.getElementById('app')!);
