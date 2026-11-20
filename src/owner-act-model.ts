import type { Money, OwnerOrder } from './owner-model';
import { customerPrice } from './pay-model';
import { taskName } from './shift-model';
import type { ActDocumentData } from './act-document';

export interface ActRecord {
  number: string | null;
  suggested_number: string | null;
  contract_number: string;
  contract_date: string;
  act_date: string;
  version: number;
  vin: string;
  customer_name: string;
  contractor_name: string;
}

export type ActFields = Pick<ActDocumentData, 'number' | 'contractNumber' | 'contractDate' | 'actDate' | 'vin'>;

export function fieldsFrom(record: ActRecord): ActFields {
  return {
    number: record.number ?? record.suggested_number ?? '',
    actDate: record.act_date, contractNumber: record.contract_number,
    contractDate: record.contract_date, vin: record.vin || '',
  };
}

export function actJobs(order: OwnerOrder, financials: Money) {
  const amounts = new Map((financials.tasks ?? financials.items ?? []).map(row => [row.task_id, customerPrice(row)]));
  return order.tasks.filter(task => task.status === 'completed').map(task => ({
    id: task.id, name: taskName(task), kopeks: amounts.get(task.id) ?? null,
  }));
}

export function templateBytes(chunks: string[]) {
  if (!Array.isArray(chunks) || !chunks.length || chunks.some(chunk => typeof chunk !== 'string' || !chunk)) {
    throw new Error('Missing template');
  }
  const parts = chunks.map(chunk => atob(chunk));
  const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) result[offset++] = part.charCodeAt(i);
  }
  return result;
}

export function downloadAct(file: Uint8Array<ArrayBuffer>, filename: string) {
  const url = URL.createObjectURL(new Blob([file], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
