// Browser-test fixture only. The public build does not include this module.
export function createClient() {
  const fixture = globalThis.__garageTest || {};
  const calls = globalThis.__garageCalls = [];
  const listeners = new Set();
  const user = { id: '11111111-1111-4111-8111-111111111111' };
  let session = fixture.signedIn === false ? null : { user };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms || 0));
  const emit = (event, next = session) => {
    session = next;
    for (const callback of listeners) callback(event, session);
  };

  globalThis.__garageAuth = {
    signOut: () => emit('SIGNED_OUT', null),
    signIn: () => emit('SIGNED_IN', { user }),
    refresh: () => emit('TOKEN_REFRESHED', session),
  };

  const profile = async () => {
    const row = fixture.profile === undefined
      ? { name: 'Test Owner', role: 'admin' } : fixture.profile;
    const error = fixture.profileError;
    await pause(fixture.profileDelay);
    return { data: row, error: error ? { message: error } : null };
  };

  return {
    auth: {
      async getSession() {
        calls.push({ method: 'getSession' });
        await pause(fixture.sessionDelay);
        return { data: { session }, error: null };
      },
      async getUser() {
        calls.push({ method: 'getUser' });
        await pause(fixture.userDelay);
        return {
          data: { user: session?.user || null },
          error: fixture.userError ? { message: fixture.userError } : null,
        };
      },
      onAuthStateChange(callback) {
        listeners.add(callback);
        queueMicrotask(() => {
          if (listeners.has(callback)) callback('INITIAL_SESSION', session);
        });
        return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
      },
      async signInWithPassword() {
        // Do not record credentials, even the fake credentials used by tests.
        calls.push({ method: 'signInWithPassword' });
        await pause(fixture.loginDelay);
        if (fixture.loginError) {
          return { data: { user: null, session: null }, error: { message: fixture.loginError } };
        }
        session = { user };
        queueMicrotask(() => emit('SIGNED_IN', session));
        return { data: { user, session }, error: null };
      },
      async signOut() {
        calls.push({ method: 'signOut' });
        await pause(fixture.signOutDelay);
        if (fixture.signOutError) return { error: { message: fixture.signOutError } };
        emit('SIGNED_OUT', null);
        return { error: null };
      },
      async updateUser() {
        calls.push({ method: 'updateUser' });
        return { data: { user }, error: fixture.updateError ? { message: fixture.updateError } : null };
      },
    },
    from(table) {
      calls.push({ method: 'from', table });
      if (table !== 'profiles') throw new Error(`Unexpected skeleton database read: ${table}`);
      const query = {
        select() { return query; },
        eq() { return query; },
        single: profile,
        maybeSingle: profile,
      };
      return query;
    },
  };
}
