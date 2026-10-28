import { z } from 'zod';
import { nowIso, type ExportDataset, type ExportSourceContext } from '@greenhouse/api/extension-kit';
import { dispatchTablesAgentAction } from './platform/agent-adapter.js';
import { tableRowIdSchema } from './platform/schema-plan.js';
import { tableQuerySchema } from './tools/tables-query.js';
const MAX_EXPORT_ROWS = 10_000;
const MAX_EXPORT_COLUMNS = 100;
const TABLE_PAGE_SIZE = 500;
type ExportDataContext = ExportSourceContext;
const tablesSourceSchema = z.object({
  type: z.literal('tables_records'),
  table_id: tableRowIdSchema,
  query: tableQuerySchema.omit({ cursor: true, limit: true }).optional(),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

async function loadTablesRecords(
  source: z.infer<typeof tablesSourceSchema>,
  context: ExportDataContext,
): Promise<ExportDataset> {
  const schemaResult = await dispatchTablesAgentAction(
    context,
    'getSchema',
    { tableId: source.table_id },
    { tableId: source.table_id },
  );
  if (!schemaResult.ok) throw new Error(schemaResult.message);
  const schema = asRecord(schemaResult.data) ?? {};
  const table = asRecord(schema.table) ?? {};
  const fields = Array.isArray(schema.fields)
    ? schema.fields.map(asRecord).filter((field): field is Record<string, unknown> => Boolean(field))
    : [];

  const records: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const result = await dispatchTablesAgentAction(
      context,
      'queryRecords',
      {
        tableId: source.table_id,
        query: { ...(source.query ?? {}), cursor, limit: TABLE_PAGE_SIZE },
      },
      { tableId: source.table_id },
    );
    if (!result.ok) throw new Error(result.message);
    const page = asRecord(result.data) ?? {};
    const total = typeof page.total === 'number' ? page.total : 0;
    if (total > MAX_EXPORT_ROWS) {
      throw new Error(`Export contains ${total} rows; narrow the filters to ${MAX_EXPORT_ROWS} rows or fewer`);
    }
    const pageRows = Array.isArray(page.records)
      ? page.records.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row))
      : [];
    records.push(...pageRows);
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
  } while (cursor);

  const dynamicColumns = fields
    .map((field) => ({
      id: typeof field.id === 'string' ? field.id : undefined,
      name: typeof field.name === 'string' ? field.name : undefined,
    }))
    .filter((field): field is { id: string; name: string } => field.id != null && Boolean(field.name));
  if (dynamicColumns.length + 3 > MAX_EXPORT_COLUMNS) {
    throw new Error(`Export supports at most ${MAX_EXPORT_COLUMNS} columns`);
  }
  const rows = records.map((record) => {
    const values = {
      ...(asRecord(record.values) ?? {}),
      ...(asRecord(record.computed_values) ?? {}),
    };
    return Object.fromEntries([
      ['__record_id', record.id],
      ...dynamicColumns.map((field) => [`field_${field.id}`, values[String(field.id)]] as const),
      ['__created_at', record.created_at],
      ['__updated_at', record.updated_at],
    ]);
  });
  const tableName =
    typeof table.name === 'string' && table.name.trim() ? table.name.trim() : `table-${source.table_id}`;
  return {
    columns: [
      { key: '__record_id', label: 'ID' },
      ...dynamicColumns.map((field) => ({ key: `field_${field.id}`, label: field.name })),
      { key: '__created_at', label: 'Created at' },
      { key: '__updated_at', label: 'Updated at' },
    ],
    rows,
    defaultFilename: `${tableName}-${nowIso().slice(0, 10)}`,
    defaultSheetName: tableName,
  };
}

export const tablesExportSource = {
  type: 'tables_records',
  schema: tablesSourceSchema,
  describe:
    'Read every matching record from an internal multidimensional table. Discover table/field IDs with tables_query first.',
  load: (source: Record<string, unknown>, ctx: ExportSourceContext) =>
    loadTablesRecords(tablesSourceSchema.parse(source), ctx),
};
