import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client, Profile } from './workspace-types';
import { subscribeBoardUpdates } from './board-updates';
import {
  listEntries,
  read,
  type EditorSeed,
  type OwnerIntake,
  type OwnerOrder,
  type Staff,
} from './owner-model';
import type { GiftOffer } from './owner-gift';
import { SourceReference } from './owner-summary';
import { OwnerDetail } from './owner-detail';
import { OrderEditor } from './owner-editor';
import { OwnerOrderEdit } from './owner-order-edit';
import { Omission } from './owner-omission';
import { OwnerOrderList } from './owner-order-list';
import { CustomOrderList, OrderType } from './owner-custom-orders';

interface Props {
  client: Client;
  profile: Profile;
  section: string;
  recordId?: string;
  standalone?: boolean;
  closeDetail?: () => void;
  navigate(section: string, recordId?: string): void;
}
interface Snapshot {
  orders: OwnerOrder[];
  intakes: OwnerIntake[];
  staff: Staff[];
  staffReady: boolean;
  intakeReady: boolean;
  giftOffer: GiftOffer | null;
  giftError: boolean;
}
const empty: Snapshot = {
  orders: [],
  intakes: [],
  staff: [],
  staffReady: false,
  intakeReady: false,
  giftOffer: null,
  giftError: false,
};
const intakeIssues: Record<string, string> = {
  NO_APPROVED_TASKS: 'Выберите запрошенные менеджером работы из каталога.',
  INVALID_PLANNED_DATE: 'Укажите полную плановую дату.',
  INVALID_VIN: 'Подтвердите VIN автомобиля.',
  INVALID_MANAGER: 'Подтвердите имя менеджера.',
  INVALID_VEHICLE: 'Укажите автомобиль.',
  UNKNOWN_VEHICLE_GROUP: 'Выберите подходящую группу автомобилей.',
  DUPLICATE_SOURCE_KEY: 'Проверьте повторяющиеся строки таблицы перед публикацией.',
};
export function OwnerOrders({ client, profile, recordId, standalone, closeDetail, navigate }: Props) {
  const [data, setData] = useState<Snapshot>(empty),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all');
  const [notice, setNotice] = useState(''),
    [loadError, setLoadError] = useState('');
  const [editor, setEditor] = useState<EditorSeed | null>(null),
    [omission, setOmission] = useState<OwnerOrder | null>(null);
  const generation = useRef(0),
    mounted = useRef(false),
    drafts = useRef(new Map<string, string>()),
    current = useRef<Snapshot>(empty);
  const view = useRef('');
  const giftPrompt = useRef<string>();
  view.current = [recordId, editor?.mode, omission?.id].join('/');
  const editingOrder = Boolean(recordId?.startsWith('edit-'));
  const id = recordId?.replace(/^(?:intake-|edit-)/, '');
  const activeOrder =
    data.orders.find((o) => o.id === id) ||
    data.orders.find((o) => o.id === data.intakes.find((i) => i.id === id)?.order_id);
  const activeIntake = data.intakes.find(
    (i) => (id && i.id === id) || (activeOrder && i.order_id === activeOrder.id),
  );
  const rows = listEntries(data.orders, data.intakes, query, filter);

  async function refresh(showLoading = false): Promise<Snapshot> {
    const turn = ++generation.current;
    if (showLoading) setLoading(true);
    try {
      const [orders, intakes, staff, offer] = await Promise.allSettled([
        read<OwnerOrder[]>(client, 'garage_list_orders'),
        read<OwnerIntake[]>(client, 'garage_manager_intakes'),
        read<Staff[]>(client, 'garage_staff'),
        read<GiftOffer | null>(client, 'garage_owner_gift_offer'),
      ]);
      if (orders.status === 'rejected') throw orders.reason;
      if (!Array.isArray(orders.value)) throw new Error('Invalid order list');
      const next = {
        orders: orders.value,
        giftOffer: offer.status === 'fulfilled' ? offer.value : null,
        giftError: offer.status === 'rejected',
        intakes:
          intakes.status === 'fulfilled' && Array.isArray(intakes.value)
            ? intakes.value
            : current.current.intakes,
        staff:
          staff.status === 'fulfilled' && Array.isArray(staff.value) ? staff.value : current.current.staff,
        staffReady: staff.status === 'fulfilled' && Array.isArray(staff.value),
        intakeReady: intakes.status === 'fulfilled' && Array.isArray(intakes.value),
      };
      if (turn === generation.current && mounted.current) {
        current.current = next;
        setData(next);
        setLoaded(true);
        setLoadError('');
      }
      return next;
    } catch (err) {
      if (turn === generation.current && mounted.current)
        setLoadError('Не удалось загрузить заказы. Проверьте подключение и обновите список.');
      throw err;
    } finally {
      if (turn === generation.current && mounted.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (profile.role !== 'admin') return;
    const silent = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => {});
    };
    void refresh(true).catch(() => {});
    const unsubscribe = subscribeBoardUpdates(client, profile.id, silent, undefined, standalone ? 'order-detail' : 'board');
    const interval = setInterval(silent, 30000);
    window.addEventListener('focus', silent);
    window.addEventListener('online', silent);
    document.addEventListener('visibilitychange', silent);
    return () => {
      mounted.current = false;
      unsubscribe();
      generation.current++;
      clearInterval(interval);
      drafts.current.clear();
      current.current = empty;
      window.removeEventListener('focus', silent);
      window.removeEventListener('online', silent);
      document.removeEventListener('visibilitychange', silent);
    };
  }, [client, profile.id, profile.role, standalone]);
  useEffect(() => {
    setEditor(recordId === 'new' ? { mode: 'new' } : null);
    setOmission(null);
  }, [recordId]);
  useEffect(() => {
    if (!editingOrder) giftPrompt.current = undefined;
  }, [editingOrder]);
  async function mutate<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!navigator.onLine) throw new Error('Offline');
    const origin = view.current;
    const key = JSON.stringify([name, args]);
    const requestId = drafts.current.get(key) || crypto.randomUUID();
    drafts.current.set(key, requestId);
    const result = await read<T>(client, name, { ...args, p_request_id: requestId });
    if (mounted.current) drafts.current.delete(key);
    if (!mounted.current || origin !== view.current) throw new Error('View disposed');
    return result;
  }
  async function freshSeed(): Promise<EditorSeed | null> {
    const latest = await refresh();
    if (editingOrder) {
      const order = latest.orders.find((o) => o.id === activeOrder?.id && o.status === 'published');
      return order
        ? { mode: 'edit', order, intake: latest.intakes.find((i) => i.order_id === order.id) }
        : null;
    }
    if (editor?.mode === 'intake') {
      const intake = latest.intakes.find(
        (i) => i.id === editor.intake?.id && !i.order_id && i.status === 'pending',
      );
      return intake && latest.intakeReady ? { mode: 'intake', intake } : null;
    }
    return null;
  }
  const afterSave = async (target: string, message: string) => {
    const origin = view.current;
    // Do not reopen the previous revision while the confirmed write is being reloaded.
    try {
      await refresh(true);
    } catch {
      if (mounted.current && origin === view.current) {
        setData((previous) => ({
          ...previous,
          orders: previous.orders.filter((order) => order.id !== target),
        }));
      }
    }
    if (!mounted.current || origin !== view.current) return;
    setEditor(null);
    setOmission(null);
    setNotice(message);
    navigate('orders', target);
  };
  if (profile.role !== 'admin') return null;
  const open = (target: string) => {
    setNotice('');
    setEditor(null);
    setOmission(null);
    navigate('orders', target);
  };
  const back = () => {
    setEditor(null);
    setOmission(null);
    if (closeDetail) closeDetail();
    else navigate('orders');
  };
  const refreshOrder = async () => { await refresh(); };
  const detail = Boolean(id || editor || omission);
  const orderDetail = editingOrder || Boolean(activeOrder && !editor && !omission);
  return (
    <div class={'owner-orders' + (detail ? ' has-detail' : '') + (orderDetail ? ' full-order' : '')}>
      {loadError && (
        <p role="alert" class="notice">
          {loadError}{' '}
          <button class="button" onClick={() => void refresh(true).catch(() => {})}>
            Повторить
          </button>
        </p>
      )}
      {loaded && !data.intakeReady && (
        <p role="status" class="notice">
          Заявки менеджеров недоступны. Обновите список для повторной загрузки.
        </p>
      )}
      {loaded && !data.staffReady && (
        <p role="status" class="notice">
          Не удалось загрузить механиков. Обновите список перед созданием заказа.
        </p>
      )}
      {notice && (
        <p class="notice" role="status">
          {notice}
        </p>
      )}
      <div class="owner-order-layout">
        {!standalone && !orderDetail && <section class="owner-order-index" aria-label="Список заказов">
          <div class="order-toolbar">
            <div class="order-search-controls">
              <input
                id="order-search"
                type="search"
                aria-label="Поиск заказов"
                placeholder="Автомобиль или VIN"
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <select
                id="order-filter"
                aria-label="Статус заказа"
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
              >
                <option value="open">Открытые</option>
                <option value="handoff">Переданы владельцу</option>
                <option value="review">Заявки на проверке</option>
                <option value="closed">Закрытые и отменённые</option>
                <option value="all">Все заказы</option>
              </select>
            </div>
            <div class="button-row toolbar-buttons">
              <button
                class="button"
                type="button"
                disabled={loading}
                onClick={() => void refresh(true).catch(() => {})}
              >
                Обновить
              </button>
              <button
                type="button"
                class="button button-primary"
                disabled={!data.staffReady}
                onClick={() => {
                  setNotice('');
                  setOmission(null);
                  setEditor({ mode: 'new' });
                }}
              >
                Новый заказ
              </button>
              {loaded && !data.staffReady && <a class="button" href="#orders/custom-new">Новый кастомный заказ</a>}
            </div>
          </div>
          {!loaded && !loadError && <p role="status">Загрузка заказов…</p>}
          {loaded && !rows.length && (
            <div class="empty-state">
              <h2>Подходящие стандартные заказы и заявки не найдены</h2>
              <p>
                {query
                  ? 'Попробуйте другой автомобиль или VIN.'
                  : 'Здесь появятся заказы и заявки менеджеров.'}
              </p>
            </div>
          )}
          <OwnerOrderList rows={rows} filter={filter} search={query} selectedId={id} open={open} />
          <CustomOrderList client={client} refreshWith={data} search={query} filter={filter} />
        </section>}
        {detail && (
          <section class="owner-order-pane" aria-label="Подробности заказа">
            {standalone && !loaded && !loadError && <p role="status">Загружаем заказ…</p>}
            {editor ? (<>
              {editor.mode === 'new' && <OrderType custom={false} change={() => navigate('orders', 'custom-new')} />}
              {(editor.mode !== 'new' || data.staffReady) && <OrderEditor
                key={editor.mode + '-' + (editor.order?.id || editor.intake?.id || '')}
                seed={editor}
                offer={data.giftOffer}
                giftError={data.giftError}
                client={client}
                mutate={mutate}
                staff={data.staff}
                close={() => recordId === 'new' ? navigate('orders', 'tools') : setEditor(null)}
                reload={freshSeed}
                saved={afterSave}
              />}
            </>) : omission ? (
              <Omission
                key={omission.id}
                order={omission}
                staff={data.staff}
                client={client}
                mutate={mutate}
                close={() => setOmission(null)}
                reload={async () => (await refresh()).orders.find((o) => o.id === omission.id) || null}
                saved={() =>
                  afterSave(
                    omission.id,
                    'Пропущенная выполненная работа добавлена. История остальных работ сохранена.',
                  )
                }
              />
            ) : activeOrder && editingOrder ? (
              <OwnerOrderEdit key={activeOrder.id} order={activeOrder} intake={activeIntake}
                promptGift={giftPrompt.current === activeOrder.id} offer={data.giftOffer}
                giftError={data.giftError} client={client} staff={data.staff} mutate={mutate}
                refreshOrder={refreshOrder} notify={setNotice} reload={freshSeed} saved={afterSave}
                close={() => navigate('orders', activeOrder.id)} />
            ) : activeOrder ? (
              <OwnerDetail
                key={activeOrder.id}
                order={activeOrder}
                staff={data.staff}
                offer={data.giftOffer}
                intake={activeIntake}
                client={client}
                mutate={mutate}
                reload={refreshOrder}
                notify={setNotice}
                edit={(promptGift = false) => {
                  setNotice('');
                  giftPrompt.current = promptGift ? activeOrder.id : undefined;
                  navigate('orders', 'edit-' + activeOrder.id);
                }}
                omit={() => setOmission(activeOrder)}
                back={back}
              />
            ) : activeIntake ? (
              <article class="owner-intake-detail">
                <button type="button" class="button" onClick={back}>
                  К списку заказов
                </button>
                <h2>
                  {String(
                    activeIntake.latest?.vehicle || activeIntake.original?.vehicle || 'Заявка менеджера',
                  )}
                </h2>
                <p>Заявка менеджера · ожидает выбора работ</p>
                <ul>
                  {[...new Set(activeIntake.issues)].map((i) => (
                    <li key={i}>{intakeIssues[i] || 'Проверьте исходную заявку.'}</li>
                  ))}
                </ul>
                <SourceReference intake={activeIntake} />
                {activeIntake.status === 'pending' && (
                  <button
                    class="button button-primary"
                    disabled={!data.intakeReady || !data.staffReady}
                    type="button"
                    onClick={() => setEditor({ mode: 'intake', intake: activeIntake })}
                  >
                    Изменить заказ
                  </button>
                )}
              </article>
            ) : loaded ? (
              <div class="notice">
                <p>Запись недоступна. Проверьте список заказов.</p>
                <button type="button" class="button" onClick={back}>
                  К списку заказов
                </button>
              </div>
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
}
