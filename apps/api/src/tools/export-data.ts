/**
 * Generic chat data export.
 *
 * The model may export rows already present in its tool context, or ask one of
 * the guarded server adapter to read a complete Tables dataset. Source
 * adapters remain responsible for authorization; this tool only persists the
 * already-authorized tabular result as a session-scoped file artifact.
 */

import { tool } from 'ai';
import type { DatabaseProvider } from '@greenhouse/db';
import { nowIso } from '@greenhouse/utils/date';
import { toErrorMessage } from '@greenhouse/utils/error';
import { z } from 'zod';
import type { ZodObject, ZodRawShape } from 'zod';
import { chatFileKeyFor, deleteObjectAtKey, putObjectAtKey } from '../storage/uploads.js';
import { defineTool, type ToolMeta } from './define.js';
import { extensionExportSources } from './export-sources.js';
import { generateTabularExport, type TabularExportColumn, type TabularExportFormat } from './tabular-export.js';

const MAX_EXPORT_ROWS = 10_000;
const MAX_EXPORT_COLUMNS = 100;
const MAX_EXPORT_BYTES = 25 * 1024 * 1024;

const inlineSourceSchema = z.object({
  type: z.literal('inline'),
  columns: z
    .array(z.object({ key: z.string().min(1), label: z.string().min(1) }))
    .max(MAX_EXPORT_COLUMNS)
    .optional()
    .describe('Optional stable column order and display labels. Inferred from rows when omitted.'),
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .max(MAX_EXPORT_ROWS)
    .describe('Rows already obtained from another tool. Do not transcribe large server datasets into this field.'),
});

/**
 * The union is built at module load from core's inline member plus whatever the
 * active extensions registered — `zod` needs the members up front, and the
 * extension list is a load-time registration, so by the time this evaluates the
 * set is complete and fixed for the process.
 */
const sourceSchemas = [inlineSourceSchema, ...extensionExportSources().map((source) => source.schema)] as unknown as [
  typeof inlineSourceSchema,
  ...ZodObject<ZodRawShape>[],
];

const exportDataSchema = z.object({
  source: z.discriminatedUnion('type', sourceSchemas),
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  filename: z
    .string()
    .max(120)
    .optional()
    .describe('Optional filename. The selected format extension is added automatically.'),
  sheet_name: z.string().max(31).optional().describe('Optional XLSX worksheet name.'),
});

type ExportDataInput = z.infer<typeof exportDataSchema>;
type ExportSource = ExportDataInput['source'];

export interface ExportDataContext {
  userId: string;
  sessionId: string;
}

interface ExportDataset {
  columns: TabularExportColumn[];
  rows: Array<Record<string, unknown>>;
  defaultFilename: string;
  defaultSheetName: string;
}

const meta: ToolMeta = {
  id: 'export_data',
  name: 'Data Export',
  brief: 'Export structured data to a downloadable XLSX or CSV file',
  description: `Export structured data to a real downloadable XLSX (default) or CSV file in the current chat.

Sources:
- inline: export rows already returned by another tool. Supply columns when stable labels/order matter.
${extensionExportSources()
  .map((source) => `- ${source.type}: ${source.describe}`)
  .join('\n')}

The server-backed sources enforce the signed-in user's permissions and are limited to 10,000 rows. Return the file artifact to the user; never paste the exported rows into the answer.`,
  category: 'core',
  is_global: true,
  builtin: true,
  icon: 'FileSpreadsheet',
  runtime_risk: 'r1',
  sort_order: 14,
  presentation: 'artifact',
};

function extensionlessFilename(raw: string | undefined, fallback: string): string {
  const printable = Array.from(raw?.trim() || fallback, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('');
  const value = printable
    .replace(/\.(?:csv|xlsx)$/i, '')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 100);
  return value || fallback;
}

function inferColumns(rows: ReadonlyArray<Record<string, unknown>>): TabularExportColumn[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (keys.length > MAX_EXPORT_COLUMNS) {
        throw new Error(`Export supports at most ${MAX_EXPORT_COLUMNS} columns`);
      }
    }
  }
  return keys.map((key) => ({ key, label: key }));
}

async function loadDataset(
  db: DatabaseProvider,
  source: ExportSource,
  context: ExportDataContext,
): Promise<ExportDataset> {
  // The extension members widen the union to `Record<string, unknown>`, so
  // dispatch on the discriminator before narrowing back to core's inline shape.
  const extension = extensionExportSources().find((candidate) => candidate.type === source.type);
  if (extension) return extension.load(source as unknown as Record<string, unknown>, context, db);
  const inline = source as Extract<ExportSource, { type: 'inline' }>;
  return {
    columns: inline.columns ?? inferColumns(inline.rows),
    rows: inline.rows,
    defaultFilename: `data-export-${nowIso().slice(0, 10)}`,
    defaultSheetName: 'Data',
  };
}

async function executeExport(db: DatabaseProvider, input: ExportDataInput, context: ExportDataContext) {
  try {
    const dataset = await loadDataset(db, input.source, context);
    if (dataset.columns.length === 0) return { error: 'No columns are available for export' };
    const format: TabularExportFormat = input.format;
    const stem = extensionlessFilename(input.filename, dataset.defaultFilename);
    const name = `${stem}.${format}`;
    const generated = await generateTabularExport({
      format,
      columns: dataset.columns,
      rows: dataset.rows,
      sheetName: input.sheet_name ?? dataset.defaultSheetName,
    });
    if (generated.buffer.length > MAX_EXPORT_BYTES) {
      return {
        error: `Generated ${format.toUpperCase()} exceeds 25 MiB; narrow the filters and export in smaller batches`,
      };
    }

    const storageKey = chatFileKeyFor(name);
    await putObjectAtKey(storageKey, generated.buffer, generated.contentType);
    try {
      const file = await db.chatFiles.create({
        session_id: context.sessionId,
        name,
        content_type: generated.contentType,
        size: generated.buffer.length,
        storage_key: storageKey,
        created_by: context.userId,
      });
      return {
        type: 'file',
        file_id: file.id,
        name: file.name,
        content_type: file.content_type,
        size: file.size,
        row_count: dataset.rows.length,
        format,
        download_url: `/api/chat-files/${file.id}/content`,
      };
    } catch (error) {
      await deleteObjectAtKey(storageKey).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return { error: `Export failed: ${toErrorMessage(error)}` };
  }
}

export function createExportDataTool(db: DatabaseProvider, context: ExportDataContext) {
  return tool({
    description: meta.description,
    inputSchema: exportDataSchema,
    execute: (input: ExportDataInput) => executeExport(db, input, context),
  });
}

export const exportDataTool = defineTool({ meta, kind: 'lazy' });
