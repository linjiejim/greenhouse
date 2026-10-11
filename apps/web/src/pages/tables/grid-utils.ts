import {
  buildTableCellUserDirectory,
  coerceTableCellText,
  inferCellDateOrder,
  splitCellList,
  type TableCellDateOrder,
  type TableCellTextContext,
} from '@greenhouse/types/table-cell-text';
import type { TableFieldConfig, TableRecordValues } from '@greenhouse/types/tables';
import type { TableBatchRecordItem, TableField, TableRecord, TableUserOption } from '../../lib/api/tables';
import { safeParse } from '../../lib/utils';

export function parseClipboardMatrix(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const rows = normalized.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows.map((row) => row.split('\t'));
}

/**
 * One pasted cell → the value to write; throws the reason it cannot be read.
 * Everything but linked records reads the way an import does (one coercer,
 * `@greenhouse/types/table-cell-text`); a link cell takes record ids (`12`,
 * `#12`, `12, 13`), the only text the grid can tell apart without a lookup.
 * An empty cell clears the field.
 */
export function parsePastedCell(field: TableField, raw: string, ctx: TableCellTextContext): unknown {
  if (!raw.trim()) return null;
  const config = safeParse<TableFieldConfig>(field.config, {});
  if (field.type === 'relation') {
    const ids = splitCellList(raw).map((entry) => Number(entry.replace(/^#/, '')));
    if (ids.some((id) => !Number.isInteger(id) || id <= 0))
      throw new Error(`${field.name}: "${raw.trim()}" is not a record id`);
    return config.relation?.multiple ? ids : ids[0];
  }
  const result = coerceTableCellText({ name: field.name, type: field.type, config }, raw, ctx);
  if (!result.ok) throw new Error(result.error);
  return result.value ?? null;
}

export function buildPasteBatch(input: {
  matrix: string[][];
  startRow: number;
  startColumn: number;
  records: TableRecord[];
  fields: TableField[];
  users: TableUserOption[];
  /** IANA zone for datetimes pasted without an offset (the viewer's). */
  timeZone: string;
}): TableBatchRecordItem[] {
  const users = buildTableCellUserDirectory(input.users);
  // `03/04/2024` is read day-first only when the pasted column has a `25/12/2024`.
  const dateOrders = new Map<number, TableCellDateOrder>();
  const dateOrder = (columnOffset: number) => {
    let order = dateOrders.get(columnOffset);
    if (!order) {
      order = inferCellDateOrder(input.matrix.map((row) => row[columnOffset] ?? ''));
      dateOrders.set(columnOffset, order);
    }
    return order;
  };
  return input.matrix.map((row, rowOffset) => {
    const values: TableRecordValues = {};
    row.forEach((raw, columnOffset) => {
      const field = input.fields[input.startColumn + columnOffset];
      if (!field) return;
      values[String(field.id)] = parsePastedCell(field, raw, {
        timeZone: input.timeZone,
        users,
        dateOrder: dateOrder(columnOffset),
      });
    });
    const record = input.records[input.startRow + rowOffset];
    return record
      ? { record_id: record.id, revision: record.revision, values }
      : {
          values,
        };
  });
}
