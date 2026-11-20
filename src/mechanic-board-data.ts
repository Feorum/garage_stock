import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Order, Task, VehicleWorkflow } from './shift-model';
import { subscribeBoardUpdates } from './board-updates';
import { readRpc } from './workspace-rpc';
import type { Client } from './workspace-types';

export interface BoardTask extends Task {
  can_check_work?: boolean;
  can_uncheck_work?: boolean;
}
export interface BoardOrder extends Order {
  tasks: BoardTask[];
  vehicle_workflow?: VehicleWorkflow & { can_submit?: boolean; handed_by?: string | null };
}

export function useBoardOrders(client: Client, profileId: string) {
  const [orders, setOrders] = useState<BoardOrder[] | null>(null);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const loader = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => loader.current(), []);
  useEffect(() => {
    const controller = new AbortController();
    let reading: Promise<void> | undefined;
    let repeat = false;
    let connected = false;
    let lastRead = 0;
    async function read() {
      do {
        repeat = false;
        try {
          const data = await readRpc<BoardOrder[]>(client, 'garage_list_orders', {}, controller.signal);
          if (controller.signal.aborted) return;
          if (!Array.isArray(data)) throw new Error();
          lastRead = Date.now();
          setOrders(data);
          setError('');
        } catch (cause) {
          if (controller.signal.aborted) return;
          const code = (cause as { code?: string })?.code;
          if (code === '42501' || code === 'PGRST301') setOrders(null);
          setError('Не удалось обновить заказы. Проверьте подключение.');
        }
      } while (repeat && navigator.onLine && !controller.signal.aborted);
    }
    function load() {
      if (controller.signal.aborted || !navigator.onLine) return Promise.resolve();
      if (reading) repeat = true;
      else
        reading = read().finally(() => {
          reading = undefined;
        });
      return reading;
    }
    const visible = () => !document.hidden && navigator.onLine;
    const onSignal = () => {
      if (visible()) void load();
    };
    const onConnection = () => {
      setOnline(navigator.onLine);
      onSignal();
    };
    loader.current = load;
    setOrders(null);
    setError('');
    void load();
    const unsubscribe = subscribeBoardUpdates(client, profileId, onSignal, (ready) => {
      connected = ready;
    });
    const timer = window.setInterval(() => {
      if (visible() && !reading && (!connected || Date.now() - lastRead >= 30000)) void load();
    }, 3000);
    window.addEventListener('focus', onSignal);
    window.addEventListener('online', onConnection);
    window.addEventListener('offline', onConnection);
    document.addEventListener('visibilitychange', onSignal);
    return () => {
      controller.abort();
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('focus', onSignal);
      window.removeEventListener('online', onConnection);
      window.removeEventListener('offline', onConnection);
      document.removeEventListener('visibilitychange', onSignal);
    };
  }, [client, profileId]);
  return { orders, error, online, refresh };
}

type Change = {
  orderId: string;
  requestId: string;
} & (
  | { action: 'check'; taskId: string }
  | { action: 'uncheck'; taskId: string; version: number }
  | { action: 'submit'; taskId?: never; version: number; note: string }
);
export interface ChangeState {
  change: Change;
  status: 'pending' | 'unknown' | 'rejected';
  message?: string;
}

export function useBoardChanges(client: Client, refresh: () => Promise<void>) {
  const [changes, setChanges] = useState<Record<string, ChangeState>>({});
  const current = useRef(changes);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function update(key: string, value?: ChangeState) {
    const next = { ...current.current };
    if (value) next[key] = value;
    else delete next[key];
    current.current = next;
    if (mounted.current) setChanges(next);
  }

  async function execute(change: Change, retry = false) {
    const key = change.taskId || change.orderId;
    if (!navigator.onLine || current.current[key]?.status === 'pending') return false;
    if (current.current[key]?.status === 'unknown' && !retry) return false;
    const conflict = Object.entries(current.current).some(
      ([otherKey, state]) =>
        otherKey !== key &&
        state.change.orderId === change.orderId &&
        state.status !== 'rejected' &&
        (!change.taskId || !state.change.taskId),
    );
    if (conflict) return false;
    update(key, { change, status: 'pending' });
    let accepted = false;
    try {
      const result = change.action === 'submit'
        ? await client.rpc('garage_submit_work', {
            p_order_id: change.orderId,
            p_expected_version: change.version,
            p_note: change.note,
            p_request_id: change.requestId,
          })
        : await client.rpc(change.action === 'check' ? 'garage_check_work' : 'garage_uncheck_work', {
            p_task_id: change.taskId,
            p_request_id: change.requestId,
            ...(change.action === 'uncheck' ? { p_expected_version: change.version } : {}),
          });
      if (result.error) throw { ...result.error, status: result.status };
      accepted = true;
      if (mounted.current) await refresh();
      update(key);
    } catch (cause) {
      const error = cause as { code?: string; message?: string; status?: number };
      const unknown =
        !error?.code ||
        (error.status ?? 0) >= 500 ||
        /network|fetch|timeout|connection|lost/i.test(error?.message || '');
      let message = 'Не удалось сохранить изменение. Обновите заказы и повторите попытку.';
      if (unknown) message = 'Ответ не получен. Проверьте отправку.';
      else if (error.code === '40001') message = 'Заказ изменился. Проверьте обновлённые работы.';
      else if (error.code === '42501') message = 'Это действие больше недоступно.';
      else if (/without financial information/i.test(error.message || ''))
        message = 'Укажите в комментарии только сведения о работе.';
      update(key, { change, status: unknown ? 'unknown' : 'rejected', message });
      if (mounted.current) await refresh();
    }
    return accepted;
  }

  return {
    changes,
    check: (orderId: string, taskId: string) =>
      execute({ action: 'check', orderId, taskId, requestId: crypto.randomUUID() }),
    uncheck: (orderId: string, taskId: string, version: number) =>
      execute({ action: 'uncheck', orderId, taskId, version, requestId: crypto.randomUUID() }),
    submit: (orderId: string, version: number, note: string) =>
      execute({ action: 'submit', orderId, version, note: note.trim(), requestId: crypto.randomUUID() }),
    retry: (state: ChangeState) => execute(state.change, true),
    dismiss: (key: string) => {
      if (current.current[key]?.status === 'rejected') update(key);
    },
  };
}
