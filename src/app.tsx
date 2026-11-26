import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createAuthController } from './auth.js';
import { getSections, isOwnerOrderDetail, resolveRoute } from './navigation.js';
import { installRussianValidation } from './locale.js';
import type { Section as ShiftSection } from './shift-model';
import { MechanicBoard } from './mechanic-board';
import { OwnerWorkspace } from './owner-workspace';
import { ExecutorMarker } from './executor-marker';
import { PayView } from './pay';
import { LedgerView } from './ledger-view';
import { SheetsView } from './sheets-view';
import type { Client, Profile, Navigate } from './workspace-types';

type Auth = ReturnType<typeof createAuthController>;
type State =
  | { status: 'loading' | 'signed_out' | 'error'; message?: string }
  | { status: 'ready'; profile: Profile };
const brand = (
  <span class="wordmark" aria-label="Garage">
    <span class="brand-mark" aria-hidden="true"><i /><i /><i /></span>Garage
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

function TabIcon({ icon }: { icon: string }) {
  if (icon === 'B' || icon === 'G') return <span class="nav-letter" aria-hidden="true">{icon}</span>;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {icon === 'home' && <><path d="m3 10 9-7.5 9 7.5M5.5 9v11h13V9" /><path d="M10 20v-6h4v6" /></>}
      {icon === 'review' && <><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="m7.5 12 3 3 6-6" /></>}
      {icon === 'orders' && <><path d="M8 5H5v16h14V5h-3" /><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M8 11h8m-8 4h5" /></>}
      {icon === 'book' && <path d="M12 5.5C9 3.8 5.5 3.7 2.5 4.5v15c3-.8 6.5-.7 9.5 1 3-1.7 6.5-1.8 9.5-1v-15c-3-.8-6.5-.7-9.5 1Zm0 0v15" />}
      {icon === 'history' && <path d="M3 12a9 9 0 1 0 2.7-6.4L3 8.3m0-4.5v4.6h4.6M12 7v5l3.4 2" />}
    </svg>
  );
}

function Workspace({ auth, client, profile }: { auth: Auth; client: Client; profile: Profile }) {
  const [hash, setHash] = useState(location.hash);
  const [online, setOnline] = useState(navigator.onLine);
  const positions = useRef(new Map<string, number>());
  const main = useRef<HTMLElement>(null);
  const previous = useRef(hash);
  const drawerOrigin = useRef('orders');
  const route = resolveRoute(profile.role, hash);
  const drawer = profile.role === 'admin' && isOwnerOrderDetail(route.id, route.record);
  const visibleRoute = drawer ? resolveRoute(profile.role, '#' + drawerOrigin.current) : route;
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
    document.title = (drawer ? 'Карточка заказа' : route.label) + ' · Garage';
    const origin = drawerOrigin.current;
    if (profile.role === 'admin') {
      if (!route.record && route.id === route.section.id) drawerOrigin.current = route.id;
      else if (!drawer) drawerOrigin.current = 'orders';
    }
    if (previous.current === hash) return;
    const prior = resolveRoute(profile.role, previous.current);
    previous.current = hash;
    // Inline rows retain their focus and scroll position when opened or folded.
    if (profile.role === 'mechanic' && prior.id === route.id) return;
    // The order dialog owns focus and restores it to the originating row on close.
    if (profile.role === 'admin') {
      const wasDrawer = isOwnerOrderDetail(prior.id, prior.record);
      if (drawer || (wasDrawer && !route.record && route.id === origin)) return;
    }
    const target = main.current?.querySelector<HTMLElement>('[data-route-heading]') || main.current;
    target?.focus({ preventScroll: true });
    window.scrollTo(0, positions.current.get(hash) ?? 0);
  }, [hash, profile.role]);
  let screen;
  const props = { client, profile, navigate, section: route.id, recordId: route.record };
  if (profile.role === 'admin') {
    switch (route.id) {
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
        screen = <OwnerWorkspace {...props} backgroundSection={drawer ? drawerOrigin.current : undefined} />;
    }
  } else screen = <MechanicBoard {...props} section={route.id as ShiftSection} />;
  const roleName = profile.role === 'admin' ? 'Владелец' : 'Механик';
  const cabinet = profile.role === 'admin' ? 'Кабинет владельца' : 'Кабинет механика';
  const name = profile.name || roleName;
  const today = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Minsk',
  }).format(new Date());
  return (
    <div class="workspace">
      <header class="workspace-header">
        {brand}
        <div class="nav-group">
          <span class="nav-caption">{cabinet}</span>
          <nav class="workspace-nav" aria-label={cabinet} data-workspace-role={profile.role}>
            {getSections(profile.role).map(item => (
              <a key={item.id} class="nav-link" href={'#' + item.id} aria-label={item.label} title={item.label}
                aria-current={visibleRoute.section.id === item.id ? 'page' : undefined}>
                <TabIcon icon={item.icon} /><span class="nav-label">{item.label}</span>
              </a>
            ))}
          </nav>
        </div>
        <div class="account-identity">
          <div class="account-controls">
            <details class="account-menu">
              <summary>
                {profile.role === 'mechanic'
                  ? <ExecutorMarker name={name} color={profile.color} id={profile.id} />
                  : name}
              </summary>
              <div>
                <a class="account-link" href="account.html">Учётная запись</a>
                <button class="button button-small" type="button" onClick={() => auth.signOut()}>Выйти</button>
              </div>
            </details>
            <span class="profile-role">{roleName}</span>
          </div>
        </div>
      </header>
      <div class="workspace-body">
        <div class="workspace-topbar">
          <span class="workspace-path">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 20V7l9-4 9 4v13h-3V10H6v10z M6 14h12 M6 17h12" />
            </svg>
            Мастерская <span class="path-divider" aria-hidden="true">/</span> <b>{visibleRoute.label}</b>
          </span>
          <div class="workspace-status">
            <span class="workshop-date">{today}</span>
            <span class={'connection' + (online ? '' : ' is-offline')} role="status">
              {online ? 'В сети' : 'Нет сети'}
            </span>
          </div>
        </div>
        <main ref={main} tabIndex={-1} id="main-content" class="workspace-main">
          {profile.role === 'admin' && ['pay', 'ledger', 'sheets'].includes(route.id) && (
            <div class="page-heading"><h1>{route.label}</h1></div>
          )}
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
