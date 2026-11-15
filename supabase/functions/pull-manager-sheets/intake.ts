import type { ParsedSheet } from './parser.ts';

export type RawSource = {
  date: string; manager_label: string; vehicle: string; vin: string; colour: string;
  wrapping: string; tint: string; completion: string; notes: string;
};

// Keep displayed Manager text separate from normalized operational selections.
// The weekday cache and row position never become observation identities.
export function rawSource(row: unknown[]): RawSource {
  const cell = (column: number) => String(row[column] ?? '');
  return { date: cell(0), manager_label: cell(2), vehicle: cell(3), vin: cell(4),
    colour: cell(5), wrapping: cell(6), tint: cell(7), completion: cell(8), notes: cell(9) };
}

export function intakeRows(parsed: ParsedSheet) {
  return parsed.rows.map(row => ({ row_number: row.row_number, source_key: row.source_key,
    raw: row.raw, suggested_order: row.suggested_order,
    suggested_tasks: row.tasks, issues: row.issues }));
}

export function ownerBindings(value: any, expectedVersion: number, parsed: ParsedSheet) {
  const currentRows = new Set(parsed.rows.map(row => row.row_number));
  if (!value || value.version !== expectedVersion || !Array.isArray(value.owner_managed_keys)
      || !Array.isArray(value.owner_managed_rows)
      || value.owner_managed_keys.some((key: unknown) => typeof key !== 'string'
        || !/^\d{4}-\d{2}-\d{2}\|[A-HJ-NPR-Z0-9]{17}$/.test(key))
      || value.owner_managed_rows.some((row: unknown) => !Number.isInteger(row)
        || !currentRows.has(row as number))) throw new Error('INVALID_INTAKE_BINDINGS');
  return { ownerManagedKeys: [...new Set<string>(value.owner_managed_keys)],
    ownerManagedRows: [...new Set<number>(value.owner_managed_rows)] };
}
