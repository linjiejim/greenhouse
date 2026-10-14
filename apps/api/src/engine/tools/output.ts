/** Keep new tool results small; existing transcript prefixes are never rewritten. */
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import type { FilesService } from '../../modules/files/service.js';
import { outsideText } from '../../security/prompt.js';
import { defineTool, type ToolContext } from './define.js';

export const TOOL_OUTPUT_CHARS = 8000;
export const TOOL_OUTPUT_HEAD = 1200;

export async function storeToolOutput(
  files: FilesService,
  value: unknown,
  ctx: Pick<ToolContext, 'memberId' | 'runId'>,
) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text || text.length <= TOOL_OUTPUT_CHARS) return value;
  let file;
  try {
    file = await files.store(ctx.memberId, {
      purpose: 'tool_output',
      name: 'tool-output.txt',
      contentType: 'text/plain',
      bytes: Buffer.from(text),
      runId: ctx.runId,
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });
  } catch (error) {
    return {
      head: text.slice(0, TOOL_OUTPUT_HEAD),
      length: text.length,
      storage_error: error instanceof ApiError ? error.code : 'storage_unavailable',
      note: 'The tool finished successfully, but its full output could not be stored. Only this head is available. Do not repeat a write just to obtain its output.',
    };
  }

  return {
    file: { id: file.id, name: file.name },
    head: text.slice(0, TOOL_OUTPUT_HEAD),
    length: text.length,
    note: 'Read more with tool_output_read using the file id and character offset. This private file expires after 30 days.',
  };
}

export function toolOutputReadTool(files: FilesService) {
  return defineTool({
    name: 'tool_output_read',
    description:
      'Read a character range from your private stored tool output. Use the file id returned by a long tool result.',
    input: z.object({
      file_id: z.string().max(64),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(6000).default(4000),
    }),
    risk: 'read',
    publicAgent: true,
    private: true,
    taints: true,
    idempotent: true,
    async execute(args, ctx) {
      const row = await files.get(ctx.memberId, args.file_id);
      if (row.purpose !== 'tool_output') throw new ApiError(404, 'not_found', 'Tool output not found.');
      const { bytes } = await files.bytes(ctx.memberId, row.id);
      const text = Buffer.from(bytes).toString('utf8');
      const end = Math.min(text.length, args.offset + args.length);
      return {
        file_id: row.id,
        offset: args.offset,
        length: text.length,
        content: outsideText(text.slice(args.offset, end), 6000),
        next_offset: end < text.length ? end : null,
      };
    },
    summarize: (_args, _output, locale) => (locale === 'zh' ? '读取了工具输出文件' : 'Read a tool output file'),
  });
}
