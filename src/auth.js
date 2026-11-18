const ROLES = new Set(['admin', 'mechanic']);

export function authErrorMessage(error = {}) {
  const code = error.code || '';
  if (code === 'email_not_confirmed') return 'Подтвердите адрес электронной почты по ссылке из письма.';
  if (code === 'user_banned') return 'Доступ к учётной записи ограничен. Обратитесь к владельцу.';
  if (error.status === 429 || code.startsWith('over_')) return 'Слишком много попыток. Подождите немного и повторите вход.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(error.message || '')) return 'Неверный адрес электронной почты или пароль.';
  return 'Не удалось войти. Проверьте адрес электронной почты, пароль и подключение.';
}

// Profile requests may finish after logout or a new session. Only the latest request may render.
export function createAuthController(client, { onChange }) {
  let revision = 0;
  let subscription;
  let scheduled;
  let signingIn = false;
  let signingOut = false;
  let destroyed = false;
  let verifiedId = null;

  function cancelScheduled() {
    clearTimeout(scheduled);
    scheduled = undefined;
  }

  function emit(state) {
    verifiedId = state.status === 'ready' ? state.profile.id : null;
    if (!destroyed) onChange(state);
  }

  function signedOut(message = '') {
    revision += 1;
    cancelScheduled();
    emit({ status: 'signed_out', message });
  }

  async function refresh(quiet = false) {
    if (destroyed || signingOut) return;
    cancelScheduled();
    const request = ++revision;
    const current = () => !destroyed && request === revision && !signingOut;
    if (!quiet) emit({ status: 'loading' });
    try {
      const session = await client.auth.getSession();
      if (!current()) return;
      if (session.error) {
        emit({ status: 'error', message: 'Не удалось проверить сеанс. Проверьте подключение и повторите попытку.' });
        return;
      }
      if (!session.data.session) return signedOut();

      const verified = await client.auth.getUser();
      if (!current()) return;
      if (verified.error || !verified.data.user) {
        if (!verified.data.user && (!verified.error || [401, 403].includes(verified.error.status))) {
          return signedOut('Сеанс завершён. Войдите снова, чтобы продолжить.');
        }
        emit({ status: 'error', message: 'Не удалось подтвердить учётную запись. Проверьте подключение и повторите попытку.' });
        return;
      }

      const user = verified.data.user;
      const result = await client.from('profiles').select('id,name,role,active').eq('id', user.id).single();
      if (!current()) return;
      if (result.error || !result.data) {
        emit({ status: 'error', message: 'Профиль недоступен. Повторите попытку или попросите владельца проверить доступ.' });
        return;
      }
      if (!ROLES.has(result.data.role)) {
        emit({ status: 'error', message: 'Для учётной записи не настроена подходящая роль. Попросите владельца проверить доступ.' });
        return;
      }
      if (result.data.active === false) {
        emit({ status: 'error', message: 'Доступ отключён. Попросите владельца проверить учётную запись.' });
        return;
      }
      emit({ status: 'ready', user, profile: { id: user.id, name: String(result.data.name || ''), role: result.data.role } });
    } catch {
      if (current()) emit({ status: 'error', message: 'Не удалось открыть учётную запись. Проверьте подключение и повторите попытку.' });
    }
  }

  function authChanged(event, session) {
    if (destroyed) return;
    if (event === 'SIGNED_OUT') return signedOut();
    if (signingIn || signingOut || event === 'INITIAL_SESSION') return;
    if (['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
      cancelScheduled();
      // Do not await SDK requests in its auth callback: they share the session lock.
      const sameUser = Boolean(verifiedId && verifiedId === session?.user?.id);
      if (!sameUser) emit({ status: 'loading' });
      scheduled = setTimeout(() => refresh(sameUser), 0);
    }
  }

  return {
    refresh,
    async start() {
      if (subscription || destroyed) return;
      const result = client.auth.onAuthStateChange(authChanged);
      subscription = result.data.subscription;
      await refresh();
    },
    async signIn(email, password) {
      if (signingIn || signingOut || destroyed) return;
      signingIn = true;
      try {
        const result = await client.auth.signInWithPassword({ email, password });
        if (result.error) return { error: authErrorMessage(result.error) };
        await refresh();
        return {};
      } catch {
        return { error: 'Не удалось войти. Проверьте подключение и повторите попытку.' };
      } finally {
        signingIn = false;
      }
    },
    async signOut() {
      if (signingOut || destroyed) return;
      signingOut = true;
      revision += 1;
      cancelScheduled();
      emit({ status: 'loading', message: 'Выполняется выход…' });
      try {
        const result = await client.auth.signOut({ scope: 'local' });
        if (result.error) {
          emit({ status: 'error', message: 'Не удалось выйти. Повторите попытку, прежде чем оставить это устройство.' });
          return;
        }
        signedOut();
      } catch {
        emit({ status: 'error', message: 'Не удалось выйти. Проверьте подключение и повторите попытку.' });
      } finally {
        signingOut = false;
      }
    },
    destroy() {
      destroyed = true;
      revision += 1;
      cancelScheduled();
      subscription?.unsubscribe();
    }
  };
}
