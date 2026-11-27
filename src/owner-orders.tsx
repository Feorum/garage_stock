import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client, Profile } from './workspace-types';
import { useOwnerData, useResource } from './owner-data';
import {
  read,
  type EditorSeed,
  type OwnerOrder,
} from './owner-model';
import { SourceReference } from './owner-summary';
import { OwnerDetail } from './owner-detail';
import { OrderEditor } from './owner-editor';
import { OwnerOrderEdit } from './owner-order-edit';
import { Omission } from './owner-omission';
import { OrderType } from './owner-custom-orders';
import { IntakeIssues, isPendingManagerIntake } from './owner-intakes';

interface Props {
  client: Client;
  profile: Profile;
  recordId?: string;
  directReview?: boolean;
  closeDetail?: () => void;
  navigate(section: string, recordId?: string): void;
}
export function OwnerOrders({ client, profile, recordId, directReview = false, closeDetail, navigate }: Props) {
  const store = useOwnerData();
  const orders = useResource(store.orders);
  const intakes = useResource(store.intakes);
  const staff = useResource(store.staff);
  const gift = useResource(store.gift);
  const loaded = orders.loaded && intakes.loaded && staff.loaded && gift.loaded;
  const loading = !loaded;
  const loadError = orders.failed && 'Не удалось загрузить заказы. Проверьте подключение и обновите список.';
  const data = {
    orders: orders.data || [], intakes: intakes.data || [], staff: staff.data || [],
    staffReady: staff.loaded && !staff.failed, intakeReady: intakes.loaded && !intakes.failed,
    giftOffer: gift.data, giftError: gift.failed,
  };
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<EditorSeed | null>(null),
    [omission, setOmission] = useState<OwnerOrder | null>(null);
  const mounted = useRef(false);
  const drafts = useRef(new Map<string, string>());
  const view = useRef('');
  const giftPrompt = useRef<string>();
  view.current = [recordId, directReview, editor?.mode, omission?.id].join('/');
  const editingOrder = Boolean(recordId?.startsWith('edit-'));
  const id = recordId?.replace(/^(?:intake-|edit-)/, '');
  const activeOrder = directReview ? undefined :
    data.orders.find((o) => o.id === id) ||
    data.orders.find((o) => o.id === data.intakes.find((i) => i.id === id)?.order_id);
  const activeIntake = data.intakes.find(
    (i) => (id && i.id === id) || (activeOrder && i.order_id === activeOrder.id),
  );
  const pendingIntake = activeIntake && isPendingManagerIntake(activeIntake) ? activeIntake : undefined;
  const linkedOrderId = directReview ? activeIntake?.order_id : undefined;
  async function refresh() {
    await Promise.allSettled([store.refreshBoard(), store.staff.read(true), store.gift.read(true)]);
    const nextOrders = store.orders.get();
    if (nextOrders.failed || !nextOrders.data) throw new Error('Заказы недоступны');
    return { orders: nextOrders.data, intakes: store.intakes.get().data || [], intakeReady: !store.intakes.get().failed };
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; drafts.current.clear(); };
  }, []);
  useEffect(() => {
    setEditor(recordId === 'new' ? { mode: 'new' } : null);
    setOmission(null);
  }, [recordId, directReview]);
  useEffect(() => {
    if (!directReview || !pendingIntake || !data.intakeReady || !data.staffReady) return;
    setEditor(previous => previous?.intake?.id === pendingIntake.id ? previous : { mode: 'intake', intake: pendingIntake });
  }, [directReview, pendingIntake, data.intakeReady, data.staffReady]);
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
        (i) => i.id === editor.intake?.id && isPendingManagerIntake(i),
      );
      return intake && latest.intakeReady ? { mode: 'intake', intake } : null;
    }
    return null;
  }
  const afterSave = async (target: string, message: string) => {
    const origin = view.current;
    let feedback = message;
    // Do not reopen the previous revision while the confirmed write is being reloaded.
    try {
      await refresh();
    } catch {
      feedback = 'Заказ сохранён. Обновите список, чтобы увидеть изменения.';
    }
    if (!mounted.current || origin !== view.current) return;
    setEditor(null);
    setOmission(null);
    setNotice(feedback);
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
  return (
    <div class={'owner-orders' + (detail ? ' has-detail' : '') + ' full-order'}>
      {loadError && (
        <p role="alert" class="notice">
          {loadError}{' '}
          <button class="button" onClick={() => void refresh().catch(() => {})}>
            Повторить
          </button>
        </p>
      )}
      {loaded && !data.intakeReady && (
        <p role="status" class="notice">
          Заявки менеджеров недоступны.{' '}
          <button type="button" class="button" disabled={loading} onClick={() => void refresh().catch(() => {})}>Повторить загрузку заявок</button>
        </p>
      )}
      {loaded && !data.staffReady && (
        <p role="status" class="notice">
          Не удалось загрузить механиков.{' '}
          <button type="button" class="button" disabled={loading} onClick={() => void refresh().catch(() => {})}>Повторить загрузку механиков</button>
        </p>
      )}
      {notice && (
        <p class="notice" role="status">
          {notice}
        </p>
      )}
      <div class="owner-order-layout">
        {detail && (
          <section class="owner-order-pane" aria-label="Подробности заказа">
            {!loaded && !loadError && <p role="status">Загружаем заказ…</p>}
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
                close={() => directReview ? back() : recordId === 'new' ? navigate('orders') : setEditor(null)}
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
                deleted={() => {
                  store.orders.set((store.orders.get().data || []).filter(order => order.id !== activeOrder.id));
                  store.intakes.set((store.intakes.get().data || []).filter(intake => intake.order_id !== activeOrder.id));
                  setNotice('Заказ удалён.');
                  back();
                }}
                edit={(promptGift = false) => {
                  setNotice('');
                  giftPrompt.current = promptGift ? activeOrder.id : undefined;
                  navigate('orders', 'edit-' + activeOrder.id);
                }}
                omit={() => setOmission(activeOrder)}
                back={back}
              />
            ) : pendingIntake && !directReview ? (
              <article class="owner-intake-detail">
                <button type="button" class="button" onClick={back}>
                  К списку заказов
                </button>
                <h2>
                  {String(
                    pendingIntake.latest?.vehicle || pendingIntake.original?.vehicle || 'Заявка менеджера',
                  )}
                </h2>
                <p>Заявка менеджера · ожидает выбора работ</p>
                <IntakeIssues intake={pendingIntake} />
                <SourceReference intake={pendingIntake} />
                <button class="button button-primary" disabled={!data.intakeReady || !data.staffReady} type="button"
                  onClick={() => setEditor({ mode: 'intake', intake: pendingIntake })}>
                  Изменить заказ
                </button>
              </article>
            ) : loaded ? (
              <div class="notice">
                {directReview && data.intakeReady && !pendingIntake && <>
                  <p>Заявка уже обработана или недоступна.</p>
                  {linkedOrderId && <button type="button" class="button" onClick={() => open(linkedOrderId)}>
                    Открыть заказ
                  </button>}
                </>}
                {directReview && pendingIntake && data.intakeReady && data.staffReady && <p role="status">Открываем проверку заявки…</p>}
                {!directReview && <p>Запись недоступна. Проверьте список заказов.</p>}
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
