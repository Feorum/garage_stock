import type { GarageClient } from './shift-model';

export interface Candidate { mechanic_id: string; name: string; former: boolean }
export interface Share extends Candidate { basis_points: number; kopeks: number }
export interface ProposedShare extends Candidate { basis_points: number; kopeks: number | null }
export interface Payout {
  order_payroll?: boolean;
  version?: number;
  candidates?: Candidate[];
  pool_kopeks: number | null;
  shares: Share[];
  suggested_pool_kopeks?: number | null;
  suggested_shares?: ProposedShare[];
  equal_split?: boolean;
}
export interface PrivatePricing {
  net_amount?: number | null;
  catalogue_kopeks?: number | null;
  override_kopeks?: number | null;
  effective_kopeks?: number | null;
  private_version?: number;
  private_comment?: string;
}
export interface PayItem extends Payout, PrivatePricing {
  task_id: string;
  version: number;
  order_id?: string;
  order_number: string;
  vehicle: string;
  work_name: string;
  options: { tint_percent?: number };
  completed_at: string;
  candidates: Candidate[];
}
export type PayEditorItem = Pick<PayItem, 'task_id' | 'version' | 'pool_kopeks' | 'shares' | 'suggested_shares' | 'suggested_pool_kopeks' | 'candidates'>;
export interface Revision { version: number; actor_name: string; saved_at: string; pool_kopeks: number; shares: Share[]; reason: string }

const moneyFormat = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'BYN', currencyDisplay: 'code' });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Minsk', dateStyle: 'short', timeStyle: 'short' });
export const money = (kopeks: number) => moneyFormat.format(kopeks / 100);
export function customerPrice(value: PrivatePricing): number | null {
  if (value.effective_kopeks !== undefined) return value.effective_kopeks;
  return value.override_kopeks ?? value.catalogue_kopeks
    ?? (value.net_amount == null ? null : Math.round(value.net_amount * 100));
}
export const date = (value: string) => dateFormat.format(new Date(value));
export const decimal = (hundredths: number) => (hundredths / 100).toFixed(2).replace('.', ',');
export const title = (item: PayItem) => item.work_name + (item.options?.tint_percent ? ' · ' + item.options.tint_percent + '%' : '');

// Parse decimal text as integers so monetary calculations never use binary fractions.
export function hundredths(value: string): number | null {
  const match = /^(\d{1,10})(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export function initialAmounts(item: PayEditorItem): Record<string, string> {
  const shares = item.pool_kopeks == null ? item.suggested_shares || [] : item.shares;
  const amounts: Record<string, string> = {};
  for (const person of item.candidates) {
    const share = shares.find(s => s.mechanic_id === person.mechanic_id);
    if (share || !person.former) amounts[person.mechanic_id] = share?.kopeks == null ? '' : decimal(share.kopeks);
  }
  return amounts;
}

export function equalAmounts(ids: string[], total: number): Record<string, string> {
  const each = Math.floor(total / ids.length);
  const remainder = total % ids.length;
  return Object.fromEntries([...ids].sort().map((id, i) => [id, decimal(each + (i < remainder ? 1 : 0))]));
}

export async function payRead<T>(client: GarageClient, method: string, args?: Record<string, unknown>): Promise<T> {
  const reply = await client.rpc(method, args);
  if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.data as T;
}
