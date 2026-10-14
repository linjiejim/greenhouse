import { z } from 'zod';
import type { FilesService } from '../../modules/files/service.js';
import { fileText } from '../../modules/files/text.js';
import { isAudio, type VoiceService } from '../../modules/voice/service.js';
import { defineTool } from './define.js';

const MAX_CHARS = 50_000;

/**
 * Reads a file attached in this conversation: text and PDF directly; audio through the
 * speech-to-text service (once: the transcript stays with the file); images reach vision models
 * inline.
 */
export function readAttachmentTool(files: FilesService, voice: VoiceService) {
  return defineTool({
    name: 'read_attachment',
    description:
      'Read the text of a file attached in this conversation (its id appears with the message, like fil_…). Works for text, Markdown, CSV, JSON and PDF, and for audio, which it transcribes.',
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
      if (isAudio(row.contentType)) {
        // A public Agent's turn and a run someone else started never use a member's own key.
        const transcript = await voice.transcribeFile(
          {
            memberId: ctx.memberId,
            agentId: ctx.agent.id,
            runId: ctx.runId,
            ...(ctx.conversation ? { conversationId: ctx.conversation.id } : {}),
            personal: ctx.agent.ownerId === ctx.memberId,
          },
          row,
          bytes,
        );
        if (!transcript) {
          return { name: row.name, note: 'This is audio, and no speech-to-text service is set up to transcribe it.' };
        }
        return {
          name: row.name,
          transcript: transcript.text,
          ...(transcript.duration_seconds !== null ? { duration_seconds: transcript.duration_seconds } : {}),
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
      const done = output as { name?: string; transcript?: string } | undefined;
      const name = done?.name ?? '';
      if (done?.transcript !== undefined)
        return locale === 'zh' ? `转写了附件 ${name}` : `Transcribed the attachment ${name}`;
      return locale === 'zh' ? `读了附件 ${name}` : `Read the attachment ${name}`;
    },
  });
}
