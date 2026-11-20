import { useEffect, useRef, useState } from 'preact/hooks';
import { read, type Money, type OwnerOrder } from './owner-model';
import type { GarageClient } from './shift-model';

export function useOrderFinancials(client: GarageClient, order: OwnerOrder) {
  const [price, setPrice] = useState<Money | null>(null);
  const [priceError, setPriceError] = useState(false);
  const epoch = useRef(0);

  async function financials() {
    const at = ++epoch.current;
    setPriceError(false);
    try {
      const data = await read<Money>(client, 'garage_order_financials', { p_order_id: order.id });
      if (at === epoch.current) setPrice(data);
      return data;
    } catch (error) {
      if (at === epoch.current) setPriceError(true);
      throw error;
    }
  }

  useEffect(() => {
    void financials().catch(() => {});
    return () => { epoch.current++; };
  }, [client, order]);

  return { price, priceError, financials };
}
