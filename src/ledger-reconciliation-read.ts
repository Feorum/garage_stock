import { createLedgerCalculator } from './ledger-calculations.js';
import type { Calc, LedgerData } from './ledger-types';
import { readRpc } from './workspace-rpc';
import type { Client } from './workspace-types';

export type LedgerCalculation = { id: string; revision: number; calculator: NonNullable<Calc> };

export async function readLedgerSheetVersion(
  client: Client,
  sheetId: string,
  signal: AbortSignal,
  reuse?: LedgerCalculation | null,
) {
  for (let tries = 0; tries < 3; tries++) {
    signal.throwIfAborted();
    const data = await readRpc<LedgerData>(client, 'garage_ledger_sheet', { p_sheet_id: sheetId }, signal);
    if (data?.sheet?.id !== sheetId || !data.import || !Array.isArray(data.rows)) throw new Error();
    if (reuse?.id === data.import.id && reuse.revision === data.import.revision) {
      return { data, calculation: reuse };
    }
    signal.throwIfAborted();
    const context = await readRpc<{ revision: number }>(
      client, 'garage_ledger_context', { p_import_id: data.import.id }, signal,
    );
    if (context?.revision === data.import.revision) {
      return {
        data,
        calculation: { id: data.import.id, revision: context.revision, calculator: createLedgerCalculator(context) },
      };
    }
  }
  throw { code: '40001' };
}
