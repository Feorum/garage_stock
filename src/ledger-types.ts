export type Value = string | number | boolean | null;
export interface Cell {
  type: string;
  value: Value;
  formula?: string | null;
  cached?: Value;
  override?: boolean;
  format?: string;
}
export type Cells = Record<string, Cell>;
export interface LedgerRow {
  id: string;
  source_row: number | null;
  section: string;
  cells: Cells;
  original_cells?: Cells;
  archived: boolean;
  version: number;
}
export interface Header {
  column: string;
  label: string;
  sourceLabel?: string;
  type?: string;
}
export interface Section {
  id: string;
  label?: string;
  kind?: string;
  addable?: boolean;
  totalable?: boolean;
  headers?: Header[];
}
export interface Sheet {
  id: string;
  name: string;
  metadata?: { source_period?: { year: number; month: number }; sections?: Section[]; warnings?: unknown[] };
}
export interface Workbook {
  id: string;
  revision: number;
  name?: string;
  filename?: string;
  sheets: Sheet[];
}
export interface LedgerData {
  import: Workbook;
  sheet: Sheet;
  rows: LedgerRow[];
}
export type Calc = ReturnType<typeof import('./ledger-calculations.js').createLedgerCalculator> | null;
export type Save = (name: string, args: Record<string, unknown>) => Promise<boolean>;
