import { extractText, getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import type { FilesService } from '../../modules/files/service.js';
import { defineTool } from './define.js';

const MAX_CHARS = 50_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|javascript|x-sh|sql))/;

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
      let text: string;
      if (row.contentType === 'application/pdf') {
        const pdf = await getDocumentProxy(bytes);
        const extracted = await extractText(pdf, { mergePages: true });
        text = Array.isArray(extracted.text) ? extracted.text.join('\n\n') : extracted.text;
      } else if (TEXT_TYPES.test(row.contentType) || /\.(md|txt|csv|tsv|json|ya?ml|xml|log)$/i.test(row.name)) {
        text = new TextDecoder().decode(bytes);
      } else if (row.contentType.startsWith('image/')) {
        return {
          name: row.name,
          note: 'This is an image. A model that can see images gets it with the message itself.',
        };
      } else {
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
