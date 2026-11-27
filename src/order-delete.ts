import { read } from './owner-model';
import type { Client } from './workspace-types';

type DeletionResult = { order_id: string; photo_paths?: string[] };

export function confirmOrderDeletion(vehicle: string) {
  return window.confirm('Удалить заказ «' + vehicle + '» навсегда? Работы, расчёты, выплаты, документы, заметки и фотографии заказа будут удалены. Отдельные записи в финансовом журнале сохранятся.');
}

export async function deleteOrder(client: Client, id: string, custom: boolean, version: number, requestId: string) {
  if (!navigator.onLine) throw new Error('Offline');
  const args = { p_order_id: id, p_custom: custom, p_expected_version: version, p_request_id: requestId };
  let lastBatch: string | undefined;
  for (;;) {
    const result = await read<DeletionResult>(client, 'garage_permanently_delete_order', args);
    if (result?.order_id !== id) throw new Error('Unconfirmed order deletion');
    const paths = result.photo_paths;
    if (paths === undefined) return;
    const prefix = (custom ? 'custom/' : '') + id + '/';
    const batch = JSON.stringify(paths);
    if (!Array.isArray(paths) || !paths.length || batch === lastBatch ||
      paths.some(path => typeof path !== 'string' || !path.startsWith(prefix))) {
      throw new Error('Unconfirmed photo deletion');
    }
    const { error } = await client.storage.from('garage-order-photos').remove(paths);
    if (error) throw error;
    lastBatch = batch;
  }
}
