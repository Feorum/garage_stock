import type { Client } from './workspace-types';

export async function readRpc<T>(
  client: Client,
  name: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  let query = client.rpc(name, params);
  if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw error;
  return data as T;
}
