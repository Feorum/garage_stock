import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useState } from 'preact/hooks';
import { useSyncExternalStore } from 'preact/compat';
import { subscribeBoardUpdates } from './board-updates';
import { accountRequest } from './mechanic-accounts';
import { dashboardOrders, type CustomOrderSummary } from './dashboard-model';
import { readRpc } from './workspace-rpc';
import type { Client } from './workspace-types';
import type { OwnerOrder, OwnerIntake, Staff } from './owner-model';
import type { GiftOffer } from './owner-gift';
import type { ReviewRate } from './owner-review';
import type { Account } from './mechanic-settings';
import type { Rate } from './mechanic-rates';
import type { PayItem } from './pay-model';
import type { Source } from './sheets-view';
import type { Workbook } from './ledger-types';
import { readLedgerSheetVersion, type LedgerCalculation } from './ledger-reconciliation-read';

interface Snapshot<T> { data: T | null; failed: boolean; loaded: boolean }

// Each resource belongs to one authenticated workspace. Switching tabs only
// subscribes to its latest snapshot. A newer refresh wins over a late response.
class Resource<T> {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot<T> = { data: null, failed: false, loaded: false };
  private request?: Promise<T>;
  constructor(private fetch: () => Promise<T>, private signal: AbortSignal) {}
  get = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  set(data: T) {
    this.request = undefined;
    this.publish({ data, failed: false, loaded: true });
  }
  private publish(value: Snapshot<T>) {
    if (this.signal.aborted) return;
    this.snapshot = value;
    this.listeners.forEach(notify => notify());
  }
  read(force = false): Promise<T> {
    if (!force) {
      if (this.request) return this.request;
      if (this.snapshot.loaded && !this.snapshot.failed) return Promise.resolve(this.snapshot.data as T);
    }
    const request = this.fetch().then(data => {
      if (request === this.request) this.publish({ data, failed: false, loaded: true });
      return data;
    }, cause => {
      if (request === this.request) {
        const denied = cause?.code === '42501' || String(cause?.code).startsWith('PGRST30');
        this.publish({ data: denied ? null : this.snapshot.data, failed: true, loaded: true });
      }
      throw cause;
    }).finally(() => { if (this.request === request) this.request = undefined; });
    this.request = request;
    return request;
  }
}

export interface PriceRow { order_id: string; tasks: ReviewRate[] }
export type Prices = Map<string, PriceRow>;

export function newestSheet(book: Workbook) {
  const period = (s: Workbook['sheets'][number]) => {
    const p = s.metadata?.source_period;
    return p?.year && p?.month ? p.year * 12 + p.month : 0;
  };
  return [...book.sheets].sort((a, b) => period(b) - period(a))[0]?.id;
}

function ownerResources(client: Client, signal: AbortSignal) {
  const resource = <T,>(fetch: () => Promise<T>) => new Resource(fetch, signal);
  const rpc = <T,>(name: string) => readRpc<T>(client, name, {}, signal);
  const list = <T,>(name: string) => resource(async () => {
    const rows = await rpc<T[]>(name);
    if (!Array.isArray(rows)) throw new Error('Invalid list: ' + name);
    return rows;
  });
  const orders = list<OwnerOrder>('garage_list_orders');
  const intakes = list<OwnerIntake>('garage_manager_intakes');
  const custom = list<CustomOrderSummary>('garage_custom_orders');
  const staff = list<Staff>('garage_staff');
  const gift = resource(() => rpc<GiftOffer | null>('garage_owner_gift_offer'));
  const prices = resource(async () => {
    const rows = await orders.read();
    const ids = rows.filter(o => o.status !== 'cancelled').map(o => o.id);
    const result: Prices = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const batch = await readRpc<PriceRow[]>(client, 'garage_owner_review_prices', { p_order_ids: ids.slice(i, i + 100) }, signal);
      if (!Array.isArray(batch)) throw new Error('Invalid price list');
      for (const row of batch) result.set(row.order_id, row);
    }
    return result;
  });
  const accounts = resource(async () => {
    const result = await accountRequest<{ accounts: Account[] }>(client, { action: 'list' });
    if (!Array.isArray(result.accounts)) throw new Error('Сервис вернул некорректный список механиков.');
    return result.accounts.filter(account => account.role === 'mechanic');
  });
  const rates = list<Rate>('garage_mechanic_rates');
  const pay = list<PayItem>('garage_pay_worklist');
  const sources = list<Source>('garage_sheet_pull_sources');
  const books = list<Workbook>('garage_ledger_imports');
  const sheets = new Map<string, Resource<Awaited<ReturnType<typeof readLedgerSheetVersion>>>>();
  let calculation: LedgerCalculation | null = null;
  function sheet(id: string) {
    let item = sheets.get(id);
    if (!item) {
      item = resource(async () => {
        const result = await readLedgerSheetVersion(client, id, signal, calculation);
        if (sheets.get(id) === item) {
          const { id: bookId, revision } = result.calculation;
          for (const [cachedId, cached] of sheets) {
            const book = cached.get().data?.data.import;
            if (cachedId !== id && book?.id === bookId && book.revision < revision) sheets.delete(cachedId);
          }
          if (calculation?.id !== bookId || calculation.revision <= revision) calculation = result.calculation;
        }
        return result;
      });
      sheets.set(id, item);
    }
    return item;
  }
  function invalidateLedgerBook(bookId: string, currentSheet: string) {
    sheets.delete(currentSheet);
    const book = books.get().data?.find(item => item.id === bookId);
    for (const tab of book?.sheets ?? []) sheets.delete(tab.id);
    if (calculation?.id === bookId) calculation = null;
  }
  let updating: Promise<void> | null = null;
  let repeat = false;
  function refreshBoard(force = true): Promise<void> {
    if (updating) {
      repeat ||= force;
      return updating;
    }
    updating = (async () => {
      do {
        repeat = false;
        await Promise.allSettled([orders.read(force), intakes.read(force), custom.read(force), prices.read(force)]);
        force = true;
      } while (repeat && !signal.aborted);
    })().finally(() => { updating = null; });
    return updating;
  }
  function orderChanged() {
    void refreshBoard();
    void pay.read(true).catch(() => {});
  }
  function refreshTools(force: boolean) {
    void Promise.allSettled([accounts.read(force), rates.read(force), staff.read(force), gift.read(force),
      pay.read(force), sources.read(force), books.read(force).then(async latest => {
        for (const item of latest) {
          for (const tab of item.sheets) {
            const cachedSheet = sheets.get(tab.id)?.get().data;
            if (cachedSheet && cachedSheet.data.import.revision < item.revision) sheets.delete(tab.id);
          }
        }
        const id = latest[0] && newestSheet(latest[0]);
        if (id) await sheet(id).read();
      })]);
  }
  function preload() {
    void refreshBoard(false);
    refreshTools(false);
  }
  return { orders, intakes, custom, staff, gift, prices, accounts, rates, pay, sources, books, sheet, invalidateLedgerBook, preload, refreshTools, refreshBoard, orderChanged };
}

const Context = createContext<ReturnType<typeof ownerResources> | null>(null);
export function OwnerData({ client, ownerId, children }: { client: Client; ownerId: string; children: ComponentChildren }) {
  const [scope] = useState(() => new AbortController());
  const [store] = useState(() => ownerResources(client, scope.signal));
  useEffect(() => {
    store.preload();
    const refresh = () => { if (!document.hidden && navigator.onLine) void store.refreshBoard(); };
    const unsubscribe = subscribeBoardUpdates(client, ownerId, refresh, undefined, 'owner', false);
    let lastToolsRead = Date.now();
    const backgroundRefresh = () => {
      if (document.hidden || !navigator.onLine) return;
      refresh();
      if (Date.now() - lastToolsRead >= 60000) {
        lastToolsRead = Date.now();
        store.refreshTools(true);
      }
    };
    const timer = window.setInterval(backgroundRefresh, 30000);
    window.addEventListener('focus', backgroundRefresh);
    window.addEventListener('online', backgroundRefresh);
    document.addEventListener('visibilitychange', backgroundRefresh);
    window.addEventListener('garage-order-drawer-closed', refresh);
    window.addEventListener('garage-orders-changed', store.orderChanged);
    return () => {
      scope.abort(); unsubscribe(); clearInterval(timer);
      window.removeEventListener('focus', backgroundRefresh);
      window.removeEventListener('online', backgroundRefresh);
      document.removeEventListener('visibilitychange', backgroundRefresh);
      window.removeEventListener('garage-order-drawer-closed', refresh);
      window.removeEventListener('garage-orders-changed', store.orderChanged);
    };
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useOwnerData() { return useContext(Context)!; }
export function useResource<T>(resource: Resource<T>) {
  return useSyncExternalStore(resource.subscribe, resource.get);
}
export function useDashboardRows() {
  const store = useOwnerData();
  const { data: orders } = useResource(store.orders);
  const { data: custom } = useResource(store.custom);
  const { data: prices } = useResource(store.prices);
  return useMemo(() => dashboardOrders(orders || [], custom || [], prices), [orders, custom, prices]);
}
