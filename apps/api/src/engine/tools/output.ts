/** Keep new tool results small; existing transcript prefixes are never rewritten. */
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import type { FilesService } from '../../modules/files/service.js';
import { outsideText } from '../../security/prompt.js';
import { defineTool, type ToolContext } from './define.js';

export const TOOL_OUTPUT_CHARS = 8000;
export const TOOL_OUTPUT_HEAD = 1200;
export const TOOL_OUTPUT_WINDOW = 3500;

export async function storeToolOutput(
  files: FilesService,
  value: unknown,
  ctx: Pick<ToolContext, 'memberId' | 'runId'> & Partial<Pick<ToolContext, 'stepId' | 'outputPrivate'>>,
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
      meta: { tool_output: { private: ctx.outputPrivate ?? true, step_id: ctx.stepId ?? null } },
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
    note: 'The file id is internal; never repeat it to the member. Read more with tool_output_read using the file id and character offset. Follow next_offset until it is null to read to the end. This owner-only file expires after 30 days.',
  };
}

export function toolOutputReadTool(files: FilesService) {
  return defineTool({
    name: 'tool_output_read',
    description:
      'Read a character window from a stored tool result. Use its file id; start at offset 0 and keep reading at next_offset until null. length is the total character count; read_length counts consumed source characters. Windows fit the tool-result limit and may be shorter than requested. Stored public content stays public; private source content stays private.',
    input: z.object({
      file_id: z.string().max(64),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(TOOL_OUTPUT_WINDOW).default(TOOL_OUTPUT_WINDOW),
    }),
    risk: 'read',
    publicAgent: true,
    async privateRead(args, ctx) {
      const row = await files.get(ctx.memberId, args.file_id);
      if (row.purpose !== 'tool_output') throw new ApiError(404, 'not_found', 'Tool output not found.');
      // Only the server writes this metadata. Old or unknown provenance stays private.
      const source = row.meta.tool_output as { private?: boolean } | undefined;
      return source?.private !== false;
    },
    taints: true,
    idempotent: true,
    async execute(args, ctx) {
      const row = await files.get(ctx.memberId, args.file_id);
      if (row.purpose !== 'tool_output') throw new ApiError(404, 'not_found', 'Tool output not found.');
      const { bytes } = await files.bytes(ctx.memberId, row.id);
      const text = Buffer.from(bytes).toString('utf8');
      const offset = Math.min(text.length, args.offset);
      let end = Math.min(text.length, offset + Math.min(args.length, TOOL_OUTPUT_WINDOW));
      const result = () => ({
        file_id: row.id,
        offset,
        length: text.length,
        read_length: end - offset,
        content: outsideText(text.slice(offset, end), TOOL_OUTPUT_WINDOW),
        next_offset: end < text.length ? end : null,
      });
      // JSON escapes also count toward the result limit. Shrink the window, never elide it.
      while (JSON.stringify(result()).length > TOOL_OUTPUT_CHARS) end = offset + Math.floor((end - offset) / 2);
      return result();
    },
    summarize: (_args, _output, locale) => (locale === 'zh' ? '读取了工具输出文件' : 'Read a tool output file'),
  });
}
