/**
 * Table Export tool — turn tabular data into a downloadable CSV or Excel file and
 * return a link that renders inline in the chat (mirrors generate_image's
 * generate → putUpload → return-url shape).
 *
 * The link EXPIRES: the file id encodes its deadline (see storage/uploads.ts), the
 * GET route 410s past it, and the FE card shows an "expired" state. Small files are
 * served through the API proxy (/api/upload/:id); large files prefer a presigned
 * direct link when an object-storage driver supports it.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { defineTool, type ToolMeta } from '../define.js';
import { makeExpiringId, expiryOf, putUpload, presignUpload, contentTypeForId } from '../../storage/uploads.js';
import { buildCsv, buildXlsx, validateSheets, type SheetSpec } from './workbook.js';

/** How long a generated export stays downloadable. */
const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Above this size, hand out a presigned direct link instead of proxying bytes.
 * Override with EXPORT_PRESIGN_THRESHOLD_BYTES — set it to 0 to presign every
 * export (handy for verifying the presigned path locally, since model-authored
 * exports rarely exceed the 5 MB default).
 */
function presignThreshold(): number {
  const raw = Number(process.env.EXPORT_PRESIGN_THRESHOLD_BYTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 1024 * 1024;
}

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const sheetSchema = z.object({
  name: z.string().describe('Sheet/tab name'),
  columns: z.array(z.string()).min(1).describe('Header row — the column names'),
  rows: z
    .array(z.array(cellSchema))
    .describe('Data rows; each row aligns to `columns` (cells: string/number/boolean/null)'),
});

const exportTableSchema = z.object({
  format: z.enum(['csv', 'xlsx']).describe('csv = a single table; xlsx = one or more sheets, with styling'),
  filename: z.string().describe('Human-facing file name WITHOUT extension, e.g. "Q3 revenue by region"'),
  sheets: z.array(sheetSchema).min(1).describe('One entry per sheet/tab. CSV uses only the first entry.'),
});

type ExportTableInput = z.infer<typeof exportTableSchema>;

const ILLEGAL_FILENAME_CHARS = '\\/:*?"<>|';

/** Strip path/illegal/control chars from a model-provided file name (keeps Unicode). */
function sanitizeFilename(name: string): string {
  const cleaned = Array.from(name || 'export')
    .map((ch) => ((ch.codePointAt(0) ?? 0) < 0x20 || ILLEGAL_FILENAME_CHARS.includes(ch) ? ' ' : ch))
    .join('');
  const base = cleaned.replace(/\s+/g, ' ').trim().slice(0, 80);
  return base || 'export';
}

const meta: ToolMeta = {
  id: 'export_table',
  name: 'Table Export',
  brief: 'Export tabular data as a downloadable CSV or Excel file',
  description: `Generate a downloadable CSV or Excel (.xlsx) file from tabular data. The result renders automatically as a download card in the chat UI.
Use this when the user asks to export, download, or get a spreadsheet / Excel / CSV of structured data (analysis results, lists, reports, comparison tables).
Provide the data as \`columns\` + \`rows\`. For multiple tabs, use format "xlsx" with several sheets (CSV holds a single table).
Do NOT use for images (use generate_image) or for prose/formatted documents.
The UI already shows a download button, so do NOT put the file URL or a download link in your text reply — just briefly confirm the file is ready. The link expires after 7 days.`,
  category: 'team',
  is_global: true,
  icon: 'FileSpreadsheet',
  group: 'media',
  presentation: 'artifact', // download card renders inline in the message body
};

export function createExportTableTool() {
  return tool({
    description: meta.description,
    inputSchema: exportTableSchema,
    execute: async (input: ExportTableInput) => {
      try {
        const sheets = input.sheets as SheetSpec[];
        validateSheets(sheets);

        const isCsv = input.format === 'csv';
        if (isCsv && sheets.length > 1) {
          // Be explicit rather than silently dropping the extra sheets' data.
          return { error: 'CSV holds a single table. Use format "xlsx" for multiple sheets.' };
        }

        const buffer = isCsv ? buildCsv(sheets[0]) : await buildXlsx(sheets);
        const ext = isCsv ? 'csv' : 'xlsx';
        const id = makeExpiringId(ext, EXPORT_TTL_MS);
        await putUpload(id, buffer, contentTypeForId(id));

        // Large exports: prefer a presigned direct link when the driver supports it
        // (offloads bandwidth). Upstream (local disk) returns null → proxy link.
        let url = `/api/upload/${id}`;
        if (buffer.length > presignThreshold()) {
          const presigned = await presignUpload(id).catch(() => null);
          if (presigned) url = presigned;
        }

        const filename = `${sanitizeFilename(input.filename)}.${ext}`;
        const totalRows = sheets.reduce((n, s) => n + s.rows.length, 0);
        logger.info(`[ExportTable] 📊 ${filename} (${ext}, ${(buffer.length / 1024).toFixed(1)}KB, ${totalRows} rows)`);

        return {
          success: true,
          url,
          filename,
          format: ext,
          size_bytes: buffer.length,
          rows: totalRows,
          sheet_count: isCsv ? 1 : sheets.length,
          // Exact enforcement boundary (from the id) so the FE card and the server agree.
          expires_at: new Date(expiryOf(id) ?? Date.now() + EXPORT_TTL_MS).toISOString(),
        };
      } catch (err) {
        const message = toErrorMessage(err);
        logger.error(`[ExportTable] ❌ ${message}`);
        return { error: `Export failed: ${message}` };
      }
    },
  });
}

export const exportTableTool = defineTool({ meta, kind: 'static', create: () => createExportTableTool() });
