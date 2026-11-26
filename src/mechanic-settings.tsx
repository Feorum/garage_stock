import { useEffect, useRef, useState } from 'preact/hooks';
import { RateForm, type Rate } from './mechanic-rates';
import { readRpc } from './workspace-rpc';
import { accountRequest } from './mechanic-accounts';
import { workshopDay, type Client } from './workspace-types';
import './mechanic-settings.css';

interface Account { id: string; name: string; email: string | null; role: string; active: boolean; pending?: boolean }
const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 2 });

function AccountForm({ client, account, saved, pending, cancel }: {
  client: Client; account: Account | null; saved(account: Account, created: boolean): void;
  pending(saving: boolean): void; cancel?: () => void;
}) {
  const [emailDraft, setEmail] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const email = emailDraft ?? account?.email ?? '';
  const normalizedEmail = email.trim();
  const normalizedName = name.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const changedEmail = emailDraft !== null && normalizedEmail.toLowerCase() !== (account?.email || '').toLowerCase();
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (lock.current) return;
    setError('');
    if (!account && (!normalizedName || normalizedName.includes('@'))) return setError('Укажите имя механика без символа @.');
    if ((!account || password) && ([...password].length < 12 || new TextEncoder().encode(password).length > 72)) {
      return setError('Укажите пароль от 12 символов и до 72 байт.');
    }
    if (account && !changedEmail && !password) return;
    lock.current = true;
    setBusy(true);
    pending(true);
    const body = account
      ? { action: 'update' as const, id: account.id, ...(changedEmail ? { email: normalizedEmail } : {}), ...(password ? { password } : {}) }
      : { action: 'create' as const, name: normalizedName, ...(normalizedEmail ? { email: normalizedEmail } : {}), password };
    try {
      const { id } = await accountRequest<{ id: string }>(client, body);
      if (!id || (account && id !== account.id)) throw new Error('Сервис не подтвердил сохранение данных.');
      if (live.current) {
        setPassword('');
        setEmail(null);
        saved(account ? { ...account, email: changedEmail ? normalizedEmail : account.email }
          : { id, name: normalizedName, email: normalizedEmail || null, role: 'mechanic', active: true }, !account);
      }
    } catch (failure) {
      if (live.current) setError(failure instanceof Error ? failure.message : 'Не удалось сохранить учётную запись.');
    } finally {
      lock.current = false;
      pending(false);
      if (live.current) setBusy(false);
    }
  }
  return <form class="ms-account-form" onSubmit={save}>
    <fieldset disabled={busy}>
      {!account && <label>Имя механика<input value={name} required maxLength={120} autoComplete="off"
        onInput={e => setName(e.currentTarget.value)} /></label>}
      <label>{account ? 'Электронная почта' : 'Электронная почта (необязательно)'}<input type="email" autoComplete="off" value={email} maxLength={254} required={Boolean(account?.email && changedEmail)}
        onInput={e => setEmail(e.currentTarget.value)} /></label>
      <label>{account ? 'Новый пароль' : 'Пароль'}<input type="password" autoComplete="new-password" minLength={12}
        required={!account} value={password} onInput={e => setPassword(e.currentTarget.value)} /></label>
      <p class="field-hint">{account ? 'Заполните пароль, чтобы заменить действующий.' : 'Для входа достаточно имени и пароля от 12 символов.'}</p>
      <div class="ms-actions"><button class="button button-primary" type="submit" disabled={Boolean(account && !changedEmail && !password)}>
        {busy ? 'Сохранение…' : account ? 'Сохранить доступ' : 'Создать механика'}</button>
        {cancel && <button type="button" class="button" onClick={cancel}>Отмена</button>}</div>
    </fieldset>{error && <p role="alert">{error}</p>}
  </form>;
}

export function MechanicSettings({ client }: { client: Client }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [rosterError, setRosterError] = useState('');
  const [rateError, setRateError] = useState(false);
  const [rosterAttempt, reloadRoster] = useState(0);
  const [rateAttempt, reloadRates] = useState(0);
  const [pickedId, pick] = useState('');
  const [creating, setCreating] = useState(false);
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const actionLock = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const focusPanel = () => requestAnimationFrame(() => panel.current?.focus());
  useEffect(() => {
    let live = true;
    setRosterError('');
    accountRequest<{ accounts: Account[] }>(client, { action: 'list' }).then(result => {
      if (!Array.isArray(result.accounts)) throw new Error('Сервис вернул некорректный список механиков.');
      if (live) setAccounts(result.accounts.filter(a => a.role === 'mechanic'));
    }).catch(failure => {
      if (live) { setAccounts(null); setRosterError(failure instanceof Error ? failure.message : 'Не удалось загрузить механиков.'); }
    });
    return () => { live = false; };
  }, [client, rosterAttempt]);

  useEffect(() => {
    const scope = new AbortController();
    setRateError(false);
    readRpc<Rate[]>(client, 'garage_mechanic_rates', {}, scope.signal).then(result => {
      if (!Array.isArray(result)) throw new Error();
      if (!scope.signal.aborted) setRates(result);
    }).catch(() => { if (!scope.signal.aborted) { setRates(null); setRateError(true); } });
    return () => scope.abort();
  }, [client, rateAttempt]);

  const applications = (accounts ?? []).filter(account => account.pending);
  const roster = (accounts ?? []).filter(account => !account.pending).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'ru') || a.id.localeCompare(b.id));
  const selected = roster.find(a => a.id === pickedId) ?? roster[0];
  const today = workshopDay();
  const currentRates = new Map<string, Rate>();
  for (const row of rates ?? []) {
    const previous = currentRates.get(row.mechanic_id);
    if (row.effective_date <= today && (!previous || row.effective_date > previous.effective_date)) currentRates.set(row.mechanic_id, row);
  }
  function saved(account: Account, created: boolean) {
    setAccounts(items => [...(items ?? []).filter(a => a.id !== account.id), account]);
    pick(account.id);
    setCreating(false);
    if (created) focusPanel();
    reloadRoster(n => n + 1);
    setNotice(created ? 'Механик добавлен. Выберите дату и задайте ставку.' : 'Данные для входа сохранены.');
  }

  async function changeAccess(account: Account, action: 'approve' | 'reject' | 'delete') {
    if (writing || actionLock.current) return;
    if (action === 'delete' && !window.confirm('Удалить профиль «' + account.name + '»? История работ и выплат сохранится.')) return;
    if (action === 'reject' && !window.confirm('Отклонить заявку от «' + account.name + '»?')) return;
    actionLock.current = true;
    setWriting(true);
    setActionError('');
    setNotice('');
    try {
      const { id } = await accountRequest<{ id: string }>(client, { action, id: account.id });
      if (id !== account.id) throw new Error('Сервис не подтвердил изменение доступа.');
      setAccounts(items => (items ?? []).flatMap(person => person.id !== id ? [person] :
        action === 'approve' ? [{ ...person, active: true, pending: false }] : []));
      if (action === 'approve') { pick(id); setCreating(false); focusPanel(); }
      reloadRoster(n => n + 1);
      setNotice(action === 'approve' ? 'Заявка одобрена. Механик может войти по имени и паролю.'
        : action === 'reject' ? 'Заявка отклонена.' : 'Профиль механика удалён.');
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Не удалось изменить доступ.');
    } finally {
      actionLock.current = false;
      setWriting(false);
    }
  }

  return <div class="ms-settings">
    <header class="ms-heading"><h1 data-route-heading tabIndex={-1}>Механики</h1>
      {!creating && <button class="button button-primary" type="button" disabled={writing}
        onClick={() => { setCreating(true); setNotice(''); focusPanel(); }}>Добавить механика</button>}
    </header>
    {actionError && <p class="notice notice-error" role="alert">{actionError}</p>}
    {notice && <p class="ms-notice" role="status">{notice}</p>}
    {rosterError && <p class="notice" role="alert">{rosterError}{' '}
      <button type="button" class="button button-small" onClick={() => reloadRoster(n => n + 1)}>Повторить</button></p>}
    {rateError && <p class="notice" role="alert">Не удалось загрузить ставки.{' '}
      <button type="button" class="button button-small" onClick={() => reloadRates(n => n + 1)}>Повторить</button></p>}
    <section class="ms-panel ms-applications" aria-label="Заявки на доступ">
      <div class="ms-heading"><h2>Заявки на доступ</h2>
        <button type="button" class="button button-small" disabled={writing} onClick={() => reloadRoster(n => n + 1)}>Обновить заявки</button>
      </div>
      {accounts && (applications.length ? <ul>{applications.map(person => <li key={person.id}>
        <strong>{person.name}</strong>
        <div class="ms-actions">
          <button type="button" class="button button-primary" disabled={writing} onClick={() => void changeAccess(person, 'approve')}>Одобрить</button>
          <button type="button" class="button" disabled={writing} onClick={() => void changeAccess(person, 'reject')}>Отклонить</button>
        </div>
      </li>)}</ul> : <p>Новых заявок пока нет.</p>)}
    </section>
    <div class="ms-columns">
      <section class="ms-panel ms-directory" aria-label="Список механиков">
        <h2>Список механиков</h2>
        {accounts === null ? !rosterError && <p role="status">Загружаем механиков…</p> : !roster.length ? <p>Механиков пока нет.</p> :
          <ul>{roster.map(person => {
            const rate = currentRates.get(person.id);
            return <li key={person.id}><button type="button" disabled={writing} aria-label={'Настроить ' + person.name}
              aria-pressed={!creating && selected?.id === person.id} onClick={() => { pick(person.id); setCreating(false); setNotice(''); focusPanel(); }}>
              <span><strong>{person.name}</strong><small>{!person.active ? 'Доступ отключён' : person.email || 'Почта не указана'}</small></span>
              <span class="ms-percent" title="Действующая ставка">{rate ? percent.format(rate.rate_bp / 10000) : '—'}</span>
            </button></li>;
          })}</ul>}
      </section>
      {creating ? <section class="ms-panel" aria-label="Новый механик" ref={panel} tabIndex={-1}>
        <h2>Новый механик</h2><AccountForm key="new" client={client} account={null} saved={saved} pending={setWriting} cancel={() => setCreating(false)} />
      </section> : selected && <section class="ms-panel ms-person" key={selected.id} aria-label={'Настройки · ' + selected.name} ref={panel} tabIndex={-1}>
        <h2>{selected.name}</h2>
        {!selected.active ? <p>Доступ механика отключён.</p> : <>
          <section class="ms-rate" aria-label="Процент механика"><h3>Процент механика</h3>
            {rates ? <RateForm client={client} selected={{ mechanicId: selected.id, rates, refresh: () => reloadRates(n => n + 1) }} />
              : !rateError && <p role="status">Загружаем ставки…</p>}
          </section>
          <section class="ms-access" aria-label="Доступ к мастерской"><h3>Доступ к мастерской</h3>
            <AccountForm client={client} account={selected} saved={saved} pending={setWriting} />
          </section>
        </>}
        <button type="button" class="button order-cancel-link" disabled={writing}
          onClick={() => void changeAccess(selected, 'delete')}>Удалить профиль</button>
      </section>}
    </div>
  </div>;
}
