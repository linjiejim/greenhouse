/**
 * Station links on what tables_query answers (`url`: `#/tables/<base>`, `…/table/<table>`,
 * `…?record=<id>`, the addresses packages/types/src/object-refs.ts reads), so a reply can link
 * the base, table or record it talks about and every client opens it in place.
 */

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const idOf = (row: Row, key = 'id'): string | null => {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
};

export const baseUrl = (baseId: string) => `#/tables/${baseId}`;
export const tableUrl = (baseId: string, tableId: string) => `#/tables/${baseId}/table/${tableId}`;
export const recordUrl = (baseId: string, tableId: string, recordId: string) =>
  `${tableUrl(baseId, tableId)}?record=${recordId}`;

function linkBase(base: unknown): unknown {
  if (!isRow(base)) return base;
  const id = idOf(base);
  return id ? { ...base, url: baseUrl(id) } : base;
}

function linkTable(table: unknown, baseId: string | null): unknown {
  if (!isRow(table)) return table;
  const id = idOf(table);
  const base = idOf(table, 'base_id') ?? baseId;
  return id && base ? { ...table, url: tableUrl(base, id) } : table;
}

function linkRecord(record: unknown, baseId: string | null, tableId: string | null): unknown {
  if (!isRow(record)) return record;
  const id = idOf(record);
  const table = idOf(record, 'table_id') ?? tableId;
  return id && table && baseId ? { ...record, url: recordUrl(baseId, table, id) } : record;
}

const mapList = (value: unknown, link: (item: unknown) => unknown) => (Array.isArray(value) ? value.map(link) : value);

/**
 * `data` as a tables_query action answered it, with `url` on each base, table and record it
 * holds. `baseId`/`tableId` fill in what a row does not carry (a record knows its table only).
 */
export function withLinks(data: unknown, ids: { baseId?: string | null; tableId?: string | null } = {}): unknown {
  if (!isRow(data)) return data;
  const baseId = ids.baseId ?? (isRow(data.base) ? idOf(data.base) : null);
  const tableId = ids.tableId ?? null;
  const out: Row = { ...data };
  if ('bases' in out) out.bases = mapList(out.bases, linkBase);
  if ('base' in out) out.base = linkBase(out.base);
  if ('tables' in out) out.tables = mapList(out.tables, (table) => linkTable(table, baseId));
  if ('table' in out) out.table = linkTable(out.table, baseId);
  if ('record' in out) out.record = linkRecord(out.record, baseId, tableId);
  if ('records' in out) out.records = mapList(out.records, (record) => linkRecord(record, baseId, tableId));
  return out;
}
