/**
 * Read Attachment tool — lets the chat agent actually open what the user
 * dropped into the conversation.
 *
 * This is the other half of "attachments are a capability, not a routing
 * signal" (convergence spec D1): the agent TRIES here, and when it cannot —
 * an archive, something too big to be worth streaming through a context window
 * — it says so plainly, and that refusal is what prompts it to draft a
 * `mission_dispatch` instead. Nothing about the file's type decides where the
 * work happens; only whether this tool could do the job.
 *
 * The refusal has to name a route the deployment really has, though, so where
 * it points depends on WHY extraction failed — see `fallbackHint`. A scan is
 * unreadable in the sandbox too.
 *
 * Extraction is deliberately lazy rather than eager-at-upload (D5): eager
 * extraction does work nobody asked for on videos and archives, and forces an
 * arbitrary "how many characters do we keep" decision at the wrong moment.
 *
 * The bytes→text step lives in `files/extract-text.ts`, shared with
 * `crm_query.read_file`. Only the routing advice is written here, because where
 * to go instead is a property of this surface, not of the file.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { getObjectAtKey, isValidUploadId } from '../storage/uploads.js';
import {
  DEFAULT_MAX_CHARS,
  HARD_MAX_CHARS,
  MAX_READABLE_BYTES,
  extractText,
  type ExtractFailureReason,
} from '../files/extract-text.js';
import { normalizeFileRef } from '../files/conversation-files.js';
import { defineTool, type ToolMeta } from './define.js';

/**
 * Where the work goes when the sandbox genuinely could do better than this
 * host — a huge CSV, an archive, a format nothing here parses. Which depends on
 * whether this conversation actually has a sandbox to send it to:
 * `mission_dispatch` is behind the `cloud-agent` feature flag, so pointing at it
 * unconditionally told users without that flag to use a tool the model could not
 * see; the model then had a refusal and no way forward. An honest dead end beats
 * a false exit.
 */
function sandboxHint(canDispatchMission: boolean): string {
  return canDispatchMission
    ? 'Dispatch a mission with this file attached to work on it in the sandbox.'
    : 'There is no sandbox available here — tell the user what failed and what would let you continue (for example the same data exported as CSV).';
}

/**
 * The same rule one level down: a scan and a locked file are dead ends
 * everywhere on this deployment, not only here. The sandbox image ships poppler
 * and ImageMagick but **no OCR engine** (see the agent-runtime Dockerfile and
 * cloud-agent spec D12), and nothing there can supply a password it was never
 * given — so `pdftoppm` renders pages nobody can then read. Sending those two to
 * a mission spends a container, a workspace slot and several minutes to arrive
 * at this same refusal, which is exactly the false exit `sandboxHint` exists to
 * avoid. What does work is a file that has text, or the pages as images, which
 * `analyze_image` (and vision-capable chat models) can read directly.
 */
function fallbackHint(reason: ExtractFailureReason, canDispatchMission: boolean): string {
  if (reason === 'no_text_layer') {
    return 'No OCR is available here or in the sandbox, so a mission cannot read it either. Tell the user the file is a scan, and ask for a version that carries real text — the original document, a text export, or the pages sent as images, which analyze_image can read.';
  }
  if (reason === 'encrypted') {
    return 'A mission cannot open it either — the sandbox has no password for it. Ask the user for a copy without password protection.';
  }
  return sandboxHint(canDispatchMission);
}

const meta: ToolMeta = {
  id: 'read_attachment',
  name: 'Read Attachment',
  brief: 'Read a file the user attached to this conversation',
  description: `Read the text of a file the user attached to THIS conversation.

Use it whenever the user's question refers to something they attached — do not guess at a file's contents, and do not ask them to paste the text.

Readable here: plain text, Markdown, CSV/TSV, JSON, XML/HTML, source code, Excel workbooks (.xlsx, converted to CSV per sheet), Word documents (.docx), and PDFs with a text layer.

NOT readable here: scanned or password-protected PDFs, legacy .doc/.xls, images, audio/video, archives, and anything over 10 MB. For those the tool returns an explicit error naming the reason, and says where the work can go instead — follow what the error says rather than assuming a sandbox exists. Never claim you read a file this tool refused.

Large files come back with \`truncated: true\`; raise \`max_chars\` only if you need more.`,
  category: 'core',
  is_global: true,
  builtin: true,
  icon: 'Paperclip',
  sort_order: 35,
};

const inputSchema = z.object({
  file_id: z.string().min(1).describe('The attachment id, as shown on the file chip in the conversation.'),
  max_chars: z
    .number()
    .int()
    .min(500)
    .max(HARD_MAX_CHARS)
    .optional()
    .describe(`Characters to return (default ${DEFAULT_MAX_CHARS}).`),
});

export interface ReadAttachmentContext {
  userId: string;
  sessionId: string;
  /** Whether `mission_dispatch` is in this caller's tool set — see `fallbackHint`. */
  canDispatchMission: boolean;
}

export function createReadAttachmentTool(db: DatabaseProvider, ctx: ReadAttachmentContext) {
  return tool({
    description: meta.description,
    inputSchema,
    execute: async (input: z.infer<typeof inputSchema>) => {
      try {
        // Session scope IS the authorization: the model supplies the id, so a
        // hallucinated or copied id must not reach another conversation's file.
        const [file] = await db.chatFiles.listBySessionAndIds(ctx.sessionId, [input.file_id]);
        if (!file) {
          // An image id resolves nowhere here by design — images have no
          // chat_files row, and there is no text in them to read anyway. Saying
          // "no such attachment" sent the model hunting for a better id instead
          // of using the tool that can actually see pictures.
          const imageId = normalizeFileRef(input.file_id);
          if (isValidUploadId(imageId) && (await db.sessions.sessionReferencesImage(ctx.sessionId, imageId))) {
            return {
              error: `"${input.file_id}" is an image, which has no text to read. Use analyze_image to look at it (or just describe it, if it is already visible to you).`,
            };
          }
          return { error: 'no such attachment in this conversation' };
        }

        if (file.size > MAX_READABLE_BYTES) {
          return {
            error: `${file.name} is ${Math.round(file.size / 1024 / 1024)} MB — too large to read here. ${sandboxHint(ctx.canDispatchMission)}`,
          };
        }

        const object = await getObjectAtKey(file.storage_key);
        if (!object) return { error: 'attachment content is missing from storage' };

        const extracted = await extractText(object.buffer, file.name, file.content_type);
        if (!extracted.ok)
          return { error: `${extracted.message} ${fallbackHint(extracted.reason, ctx.canDispatchMission)}` };

        const limit = input.max_chars ?? DEFAULT_MAX_CHARS;
        return {
          name: file.name,
          content_type: file.content_type,
          size: file.size,
          truncated: extracted.text.length > limit,
          text: extracted.text.slice(0, limit),
        };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const readAttachmentTool = defineTool({ meta, kind: 'lazy' });
