const ROLES = new Set(['admin', 'mechanic']);

// Profile requests may finish after logout or a new session. Only the latest request may render.
export function createAuthController(client, { onChange }) {
  let revision = 0;
  let subscription;
  let scheduled;
  let signingIn = false;
  let signingOut = false;
  let destroyed = false;

  function cancelScheduled() {
    clearTimeout(scheduled);
    scheduled = undefined;
  }

  function emit(state) {
    if (!destroyed) onChange(state);
  }

  function signedOut(message = '') {
    revision += 1;
    cancelScheduled();
    emit({ status: 'signed_out', message });
  }

  async function refresh() {
    if (destroyed || signingOut) return;
    cancelScheduled();
    const request = ++revision;
    const current = () => !destroyed && request === revision && !signingOut;
    emit({ status: 'loading' });
    try {
      const session = await client.auth.getSession();
      if (!current()) return;
      if (session.error) {
        emit({ status: 'error', message: 'We couldn’t check your session. Check your connection and try again.' });
        return;
      }
      if (!session.data.session) return signedOut();

      const verified = await client.auth.getUser();
      if (!current()) return;
      if (verified.error || !verified.data.user) {
        if (!verified.data.user && (!verified.error || [401, 403].includes(verified.error.status))) {
          return signedOut('Your session has ended. Sign in again to continue.');
        }
        emit({ status: 'error', message: 'We couldn’t verify your account. Check your connection and try again.' });
        return;
      }

      const user = verified.data.user;
      const result = await client.from('profiles').select('id,name,role,active').eq('id', user.id).single();
      if (!current()) return;
      if (result.error || !result.data) {
        emit({ status: 'error', message: 'Your account profile is unavailable. Try again, or ask the Owner to check your access.' });
        return;
      }
      if (!ROLES.has(result.data.role)) {
        emit({ status: 'error', message: 'This account does not have a supported workspace role. Ask the Owner to check your access.' });
        return;
      }
      if (result.data.active === false) {
        emit({ status: 'error', message: 'Your workspace access is inactive. Ask the Owner to check your account.' });
        return;
      }
      emit({ status: 'ready', user, profile: { id: user.id, name: String(result.data.name || ''), role: result.data.role } });
    } catch {
      if (current()) emit({ status: 'error', message: 'We couldn’t open your account. Check your connection and try again.' });
    }
  }

  function authChanged(event) {
    if (destroyed) return;
    if (event === 'SIGNED_OUT') return signedOut();
    if (signingIn || signingOut || event === 'INITIAL_SESSION') return;
    if (['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
      cancelScheduled();
      // Do not await SDK requests in its auth callback: they share the session lock.
      scheduled = setTimeout(() => refresh(), 0);
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
        if (result.error) return { error: result.error.message || 'Sign-in failed. Check your email and password.' };
        await refresh();
        return {};
      } catch {
        return { error: 'We couldn’t sign you in. Check your connection and try again.' };
      } finally {
        signingIn = false;
      }
    },
    async signOut() {
      if (signingOut || destroyed) return;
      signingOut = true;
      revision += 1;
      cancelScheduled();
      emit({ status: 'loading', message: 'Signing out…' });
      try {
        const result = await client.auth.signOut({ scope: 'local' });
        if (result.error) {
          emit({ status: 'error', message: 'We couldn’t sign you out. Try again before leaving this device.' });
          return;
        }
        signedOut();
      } catch {
        emit({ status: 'error', message: 'We couldn’t sign you out. Check your connection and try again.' });
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
