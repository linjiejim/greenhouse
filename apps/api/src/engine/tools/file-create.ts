import { z } from 'zod';
import ExcelJS from 'exceljs';
import { and, eq } from 'drizzle-orm';
import { files as fileRows, getDb } from '@greenhouse/db';
import type { FilesService } from '../../modules/files/service.js';
import { ApiError, conflict } from '../../http/errors.js';
import { defineTool } from './define.js';

const MAX_BYTES = 1024 * 1024;
const TYPES = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
export function fileCreateTool(files: FilesService) {
  return defineTool({
    name: 'file_create',
    description:
      'Create a downloadable txt, md, csv, json or xlsx file without a computer, up to 1 MiB. Supply content for text formats; for xlsx supply rows (at most 1000 rows and 50 columns). Files attach to the reply. Private reversible write with receipt and undo; unavailable in rooms.',
    input: z.object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .refine(
          (name) =>
            !name.includes('/') &&
            !name.includes('\\') &&
            [...name].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
          'Use a file name without directories or control characters.',
        ),
      format: z.enum(['txt', 'md', 'csv', 'json', 'xlsx']),
      content: z.string().max(MAX_BYTES).optional(),
      rows: z
        .array(z.array(z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()])).max(50))
        .max(1000)
        .optional(),
    }),
    risk: 'write',
    callRisk: async () => 'tier1',
    surfaces: ['turn'],
    available: async (ctx) => !ctx.publicAgent && (await ctx.available('storage')),
    async guard(_args, ctx) {
      if (!ctx.conversation || ctx.conversation.kind === 'room' || ctx.conversation.ownerId !== ctx.memberId)
        throw new ApiError(403, 'private_conversation_required', 'Create files in your own private conversation.');
      const count = await getDb()
        .select({ id: fileRows.id })
        .from(fileRows)
        .where(and(eq(fileRows.runId, ctx.runId), eq(fileRows.purpose, 'attachment')));
      if (!ctx.undoRevisions && count.length >= 10)
        throw new ApiError(409, 'file_limit', 'Create at most ten files per turn.');
    },
    before: async (input) => ({ input }),
    async execute(args, ctx) {
      let bytes: Uint8Array;
      if (args.format === 'xlsx') {
        if (!args.rows?.length) throw new ApiError(400, 'invalid_input', 'An xlsx file needs rows.');
        if (Buffer.byteLength(JSON.stringify(args.rows), 'utf8') > MAX_BYTES)
          throw new ApiError(400, 'file_too_large', 'The spreadsheet data can be up to 1 MiB.');
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet('Sheet1').addRows(args.rows);
        bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
      } else {
        if (args.content === undefined) throw new ApiError(400, 'invalid_input', 'A text file needs content.');
        if (args.format === 'json') {
          try {
            JSON.parse(args.content);
          } catch {
            throw new ApiError(400, 'invalid_input', 'The content must be valid JSON.');
          }
        }
        bytes = Buffer.from(args.content, 'utf8');
      }
      if (bytes.byteLength > MAX_BYTES) throw new ApiError(400, 'file_too_large', 'Created files can be up to 1 MiB.');
      const name = args.name.endsWith('.' + args.format) ? args.name : args.name + '.' + args.format;
      const file = await files.store(ctx.memberId, {
        name,
        contentType: TYPES[args.format],
        bytes,
        purpose: 'attachment',
        conversationId: ctx.conversation!.id,
        runId: ctx.runId,
        meta: { created_step: ctx.stepId },
      });
      await ctx.attachFile?.(file.id, true);
      return { file_id: file.id, name: file.name, size_bytes: file.size_bytes };
    },
    async undo(_args, output, _before, ctx) {
      const id = (output as { file_id: string }).file_id;
      const [row] = await getDb()
        .select()
        .from(fileRows)
        .where(and(eq(fileRows.id, id), eq(fileRows.ownerId, ctx.memberId)))
        .for('update');
      if (!row || row.status !== 'active' || row.meta.created_step !== ctx.stepId)
        throw conflict('undo_conflict', 'This file changed after it was created.');
      await files.remove(ctx.memberId, id);
    },
    summarize: (_args, _out, locale) => (locale === 'zh' ? '创建了文件' : 'Created a file'),
  });
}
