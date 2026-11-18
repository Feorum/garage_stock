import type { GarageClient } from './shift-model';

export interface Candidate { mechanic_id: string; name: string; former: boolean }
export interface Share extends Candidate { basis_points: number; kopeks: number }
export interface PayItem {
  task_id: string;
  version: number;
  order_number: string;
  vehicle: string;
  work_name: string;
  options: { tint_percent?: number };
  completed_at: string;
  pool_kopeks: number | null;
  shares: Share[];
  candidates: Candidate[];
}
export interface Revision { version: number; actor_name: string; saved_at: string; pool_kopeks: number; shares: Share[]; reason: string }

const moneyFormat = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'BYN', currencyDisplay: 'code' });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Minsk', dateStyle: 'short', timeStyle: 'short' });
export const money = (kopeks: number) => moneyFormat.format(kopeks / 100);
export const date = (value: string) => dateFormat.format(new Date(value));
export const decimal = (hundredths: number) => (hundredths / 100).toFixed(2).replace('.', ',');
export const title = (item: PayItem) => item.work_name + (item.options?.tint_percent ? ' · ' + item.options.tint_percent + '%' : '');

// Parse decimal text as integers so monetary calculations never use binary fractions.
export function hundredths(value: string): number | null {
  const match = /^(\d{1,10})(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export async function payRead<T>(client: GarageClient, method: string, args?: Record<string, unknown>): Promise<T> {
  const reply = await client.rpc(method, args);
  if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.data as T;
}
