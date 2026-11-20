import { useLayoutEffect, useRef } from 'preact/hooks';
import { availableWorks, workName, type Money } from './owner-model';
import { customerPrice } from './pay-model';

export interface GiftOffer {
  work_code: string;
  qualifying_count: number;
}

export function qualifies(offer: GiftOffer | null, group: string, codes: string[]): boolean {
  return Boolean(
    offer &&
    availableWorks(group).includes(offer.work_code) &&
    new Set(codes.filter((code) => code !== offer.work_code)).size >= offer.qualifying_count,
  );
}

export function quoteWithGift(quote: Money, code?: string): Money {
  if (!code || !quote.items?.some((item) => item.work_code === code)) return quote;
  const items = quote.items.map((item) =>
    item.work_code === code ? { ...item, override_kopeks: 0, effective_kopeks: 0 } : item,
  );
  const total = items.reduce<number | null>((sum, item) => {
    const price = customerPrice(item);
    return sum == null || price == null ? null : sum + price;
  }, 0);
  return { ...quote, items, effective_total_kopeks: total };
}

export function GiftDialog({ offer, choose }: { offer: GiftOffer; choose(accept: boolean): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      class="gift-dialog"
      aria-labelledby="gift-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        choose(false);
      }}
    >
      <h2 id="gift-dialog-title">Предложить работу в подарок</h2>
      <p>В заказе достаточно работ для акции. Добавить «{workName(offer.work_code)}» в подарок клиенту?</p>
      <p>
        Стоимость для клиента составит 0 BYN. Предложение по оплате механикам рассчитывается по полной ставке.
      </p>
      <div class="button-row">
        <button type="button" class="button button-primary" onClick={() => choose(true)}>
          Добавить подарок
        </button>
        <button type="button" class="button" onClick={() => choose(false)}>
          Без подарка
        </button>
      </div>
    </dialog>
  );
}
