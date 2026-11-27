import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { readRpc } from './workspace-rpc';
import type { Client } from './workspace-types';

type Values = Record<string, unknown>;
interface Preferences {
  values: Values;
  ready: boolean;
  message: string;
  save(key: string, value: unknown): void;
  retry(): void;
}
const Context = createContext<Preferences | null>(null);

export function OwnerPreferences({ client, ownerId, children }: {
  client: Client; ownerId: string; children: ComponentChildren;
}) {
  const [values, setValues] = useState<Values>({});
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('');
  const changes = useRef(new Map<string, unknown>());
  const writing = useRef(false);
  const loading = useRef(false);
  const [scope] = useState(() => new AbortController());
  const pendingKey = 'garage:pending-preferences:' + ownerId;

  // Preserve only unacknowledged settings across reload or sign-out in this tab.
  // Confirmed preferences always come from the account.
  function rememberChanges() {
    try {
      if (changes.current.size) sessionStorage.setItem(pendingKey, JSON.stringify(Object.fromEntries(changes.current)));
      else sessionStorage.removeItem(pendingKey);
    } catch { /* The server save still works when browser storage is disabled. */ }
  }
  async function flush() {
    if (writing.current || scope.signal.aborted) return;
    writing.current = true;
    try {
      while (changes.current.size) {
        const [key, value] = changes.current.entries().next().value!;
        await readRpc(client, 'garage_save_owner_preference', {
          p_owner_id: ownerId, p_key: key, p_value: value,
        }, scope.signal);
        if (scope.signal.aborted) return;
        if (changes.current.get(key) === value) changes.current.delete(key);
        rememberChanges();
      }
      setMessage('');
    } catch {
      if (!scope.signal.aborted) setMessage('Не удалось сохранить настройки в аккаунте.');
    } finally { writing.current = false; }
  }
  async function load() {
    if (loading.current) return;
    loading.current = true;
    try {
      const data = await readRpc<Values>(client, 'garage_owner_preferences', {}, scope.signal);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      if (scope.signal.aborted) return;
      setValues({ ...data, ...Object.fromEntries(changes.current) });
      setReady(true);
      setMessage('');
      if (changes.current.size) void flush();
    } catch {
      if (!scope.signal.aborted) setMessage('Не удалось загрузить настройки кабинета.');
    } finally { loading.current = false; }
  }
  function save(key: string, value: unknown) {
    if (!ready) return;
    setValues(previous => ({ ...previous, [key]: value }));
    changes.current.set(key, value);
    rememberChanges();
    void flush();
  }
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey) || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) changes.current = new Map(Object.entries(saved));
    } catch { /* Recover using the account settings. */ }
    void load();
    return () => scope.abort();
  }, []);
  function retry() { void (ready ? flush() : load()); }
  useEffect(() => {
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [ready]);
  return <Context.Provider value={{ values, ready, message, save, retry }}>{children}</Context.Provider>;
}

export function OwnerPreferenceStatus() {
  const preferences = useContext(Context);
  return preferences?.message ? <p class="notice" role="alert">{preferences.message}{' '}
    <button type="button" class="button button-small" onClick={preferences.retry}>Повторить</button></p> : null;
}

export function useOwnerPreference<T>(key: string, fallback: T) {
  const preferences = useContext(Context);
  const value = preferences && Object.hasOwn(preferences.values, key) ? preferences.values[key] as T : fallback;
  return [value, (next: T) => preferences?.save(key, next), Boolean(preferences?.ready)] as const;
}
