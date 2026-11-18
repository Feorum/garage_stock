import type { Calc, Header, LedgerRow, Section, Sheet, Value } from './ledger-types';
export function ledgerSectionLabel(section: Section): string;
export function ledgerWarning(w: unknown): string;
export function ledgerReadOnly(sheet: Sheet, section: string, row: LedgerRow | null): boolean;
export function ledgerHeaders(sheet: Sheet, section: string, rows: LedgerRow[]): Header[];
export function ledgerValue(value: Value | undefined, type?: string): string;
export interface Result {
  value: Value;
  status: string;
  error?: string;
  warning?: string;
}
export function resultFor(sheet: Sheet, row: LedgerRow, column: string, calc: Calc): Result;
export function resultLabel(r: Result, type?: string): string;
export function ledgerIssues(sheet: Sheet, row: LedgerRow, headers: Header[], calc: Calc): string[];
export function rowDescription(row: LedgerRow, headers: Header[]): string;
export function ledgerFailure(error: unknown): string;
