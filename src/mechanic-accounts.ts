import type { Client } from './workspace-types';

type AccountRequest = { action: 'list' }
  | { action: 'create'; name: string; email?: string; password: string }
  | { action: 'register'; name: string; password: string }
  | { action: 'update'; id: string; email?: string; password?: string }
  | { action: 'approve' | 'reject' | 'delete'; id: string };

export async function accountRequest<T>(client: Client, body: AccountRequest): Promise<T> {
  const { data, error } = await client.functions.invoke<T>('garage-accounts', { body });
  if (!error && data) return data;
  if (error?.context instanceof Response) {
    const response = await error.context.json().catch(() => null);
    if (typeof response?.error === 'string' && typeof response?.code === 'string') throw new Error(response.error);
  }
  throw new Error('Не удалось связаться с сервисом учётных записей. Проверьте подключение и повторите попытку.');
}
