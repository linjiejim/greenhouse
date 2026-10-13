import { z } from 'zod';
import type { FilesService } from '../../modules/files/service.js';
import { fileText } from '../../modules/files/text.js';
import { defineTool } from './define.js';

const MAX_CHARS = 50_000;

/** Reads a file attached in this conversation: text and PDF directly; images reach vision models inline. */
export function readAttachmentTool(files: FilesService) {
  return defineTool({
    name: 'read_attachment',
    description:
      'Read the text of a file attached in this conversation (its id appears with the message, like fil_…). Works for text, Markdown, CSV, JSON and PDF.',
    input: z.object({ file_id: z.string().min(1).max(64) }),
    risk: 'read',
    private: true,
    surfaces: ['turn'],
    publicAgent: true,
    async execute(args, ctx) {
      const { row, bytes } = await files.bytes(ctx.memberId, args.file_id);
      if (row.conversationId !== ctx.conversation?.id) {
        throw new Error('That file is not attached in this conversation.');
      }
      if (row.contentType.startsWith('image/')) {
        return {
          name: row.name,
          note: 'This is an image. A model that can see images gets it with the message itself.',
        };
      }
      const text = await fileText(row, bytes);
      if (text === null) {
        return { name: row.name, note: `This kind of file (${row.contentType}) cannot be read as text here.` };
      }
      const truncated = text.length > MAX_CHARS;
      return {
        name: row.name,
        content: truncated ? text.slice(0, MAX_CHARS) : text,
        ...(truncated ? { truncated: true } : {}),
      };
    },
    summarize: (_args, output, locale) => {
      const name = (output as { name?: string } | undefined)?.name ?? '';
      return locale === 'zh' ? `读了附件 ${name}` : `Read the attachment ${name}`;
    },
  });
}
