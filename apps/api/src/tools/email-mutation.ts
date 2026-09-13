/**
 * Email Mutation tool — draft, then send, in two steps.
 *
 * `draft` stores the message SERVER-SIDE and returns a short token plus an
 * interactive confirmation card. `send` takes the token and mails what the
 * server stored — never what the send call passes in. That is the property
 * that makes an outbound channel safe to hand a model: a prompt injection can
 * make it draft something terrible, but it cannot change the recipient between
 * the card the user read and the message that leaves.
 *
 * An invalid or expired token is a refusal, full stop. The deleted 0.18.0
 * module fell back to "the user's most recent draft", which handed that
 * property straight back (see spec D3).
 *
 * Denied in unattended contexts: a scheduled run has nobody to confirm, and
 * automation delivery has its own system path (scheduler/notify.ts) that does
 * not go through any model.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { resolveConversationFiles } from '../files/conversation-files.js';
import { consumeDraftToken, createDraftToken } from '../email/security.js';
import { checkRecipientPolicy, parseMailboxRef, mailboxRefError, resolveMailbox, sendMail } from '../email/service.js';
// Leaf module — see the note in email-query.ts.
import { MAX_ATTACHMENT_BYTES, MAX_RECIPIENTS_PER_MESSAGE, MAX_PERSONAL_SENDS_PER_DAY } from '../email/limits.js';
import type { EmailAddress, EmailAttachmentPayload } from '../email/types.js';
import type { EmailToolContext } from './email-query.js';

const addressSchema = z.object({
  address: z.string().describe('Email address.'),
  name: z.string().optional().describe('Display name.'),
});

const emailMutationSchema = z.object({
  action: z.enum(['draft', 'send']).describe('draft first, always; send only after the user agrees.'),
  mailbox: z
    .string()
    .optional()
    .describe('Account id or email address from email_query.list_accounts, or "shared". Required for draft.'),
  to: z.array(addressSchema).optional().describe('Primary recipients.'),
  cc: z.array(addressSchema).optional(),
  bcc: z.array(addressSchema).optional(),
  subject: z.string().optional().describe('Subject line.'),
  body: z.string().optional().describe('Plain-text body. Write the whole message; no placeholders.'),
  attachment_ids: z
    .array(z.string())
    .optional()
    .describe(
      'Ids of files OR images from this conversation, to send along. For an image, pass the id you were given (the `/api/upload/<id>` form is accepted too). Chat only.',
    ),
  reply_to_uid: z
    .number()
    .int()
    .optional()
    .describe('uid of the message being replied to — threads the reply and quotes its subject.'),
  folder: z.string().optional().describe('Folder holding reply_to_uid; defaults to INBOX.'),
  draft_token: z.string().optional().describe('Token returned by draft — required for send.'),
  user_confirmed: z.boolean().optional().describe('true only after the user explicitly agreed to send.'),
});

type EmailMutationInput = z.infer<typeof emailMutationSchema>;

const meta: ToolMeta = {
  id: 'email_mutation',
  name: 'Email Mutation',
  brief: 'Draft an email and send it from the user’s mailbox after they confirm',
  description: `Send email from a mailbox the user has bound. Two steps, always.

\`draft\` sends nothing: it stores the message server-side and returns a \`draft_token\` plus a confirmation card for the user. \`send\` then mails THAT STORED DRAFT — the fields you pass to send are ignored, so changing a message means drafting it again.

Tokens are single-use and expire in 10 minutes. A wrong or stale one is refused rather than guessed at; draft again and re-confirm.

Write the finished message in \`body\`; never send placeholders for the user to fill in.

Limits: ${MAX_RECIPIENTS_PER_MESSAGE} recipients and ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB of attachments per message, ${MAX_PERSONAL_SENDS_PER_DAY} sends per day.

The shared Greenhouse mailbox is administrator-only and may only write to the sender's own address or @example.com — use a personal mailbox to reach anyone else.`,
  category: 'core',
  is_global: true,
  icon: 'Send',
  surface: { proxy: 'write' },
  sort_order: 39,
  presentation: 'artifact', // the draft confirmation renders as an AskUserCard
};

/** Resolve conversation attachments to bytes, refusing anything over budget. */
async function loadAttachments(
  db: DatabaseProvider,
  sessionId: string | undefined,
  ids: string[],
): Promise<{ ok: true; files: EmailAttachmentPayload[] } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: true, files: [] };
  if (!sessionId) {
    return {
      ok: false,
      error: 'Attachments can only be sent from a chat conversation, where the files live.',
    };
  }

  // Session scope IS the authorization here, exactly as in read_attachment: the
  // model supplies the ids, so a copied id must not reach another conversation.
  // Images resolve too — they have no chat_files row (public-read `/api/upload`
  // path), and refusing them told users a picture in plain sight did not exist.
  const resolved = await resolveConversationFiles(db, sessionId, ids);
  if (!resolved.ok) {
    return {
      ok: false,
      error: `No such attachment in this conversation: ${resolved.missing.join(', ')}. Attach only files or images already in this conversation, using the id exactly as it was given to you.`,
    };
  }

  const total = resolved.files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `Attachments total ${(total / 1024 / 1024).toFixed(1)}MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB.`,
    };
  }

  const files: EmailAttachmentPayload[] = [];
  for (const file of resolved.files) {
    const bytes = await file.read();
    if (!bytes) return { ok: false, error: `Attachment ${file.name} could not be read from storage.` };
    files.push({ filename: file.name, content: bytes, content_type: file.content_type });
  }
  return { ok: true, files };
}

function formatRecipients(list: EmailAddress[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

export function createEmailMutationTool(db: DatabaseProvider, ctx: EmailToolContext) {
  return tool({
    description: meta.description,
    inputSchema: emailMutationSchema,
    execute: async (input: EmailMutationInput) => {
      try {
        if (input.action === 'draft') {
          const ref = parseMailboxRef(input.mailbox);
          if (ref === null) return { action: 'draft', error: mailboxRefError(input.mailbox) };
          if (!input.to?.length) return { action: 'draft', error: 'to is required.' };
          if (!input.subject?.trim() && input.reply_to_uid === undefined) {
            return { action: 'draft', error: 'subject is required.' };
          }
          if (!input.body?.trim()) return { action: 'draft', error: 'body is required.' };

          const resolved = await resolveMailbox(db, { userId: ctx.userId, userRole: ctx.userRole }, ref);
          if (!resolved.ok) return { action: 'draft', error: resolved.error };
          const mailbox = resolved.mailbox;

          // Same policy the send path enforces, run here so the user is never
          // shown a card for a message that will be refused after they confirm.
          const violation = await checkRecipientPolicy(
            db,
            mailbox,
            { to: input.to, cc: input.cc, bcc: input.bcc },
            ctx.userId,
          );
          if (violation) return { action: 'draft', error: violation };

          // Verify the attachments resolve NOW, for the same reason.
          const attachments = await loadAttachments(db, ctx.sessionId, input.attachment_ids ?? []);
          if (!attachments.ok) return { action: 'draft', error: attachments.error };

          let subject = input.subject?.trim() ?? '';
          let inReplyTo: string | undefined;
          let references: string[] | undefined;
          if (input.reply_to_uid !== undefined) {
            const original = await mailbox.client.getMessage(input.folder ?? 'INBOX', input.reply_to_uid);
            inReplyTo = original.message_id;
            references = [...(original.references ?? []), ...(original.message_id ? [original.message_id] : [])];
            if (!subject) {
              subject = original.subject.toLowerCase().startsWith('re:') ? original.subject : `Re: ${original.subject}`;
            }
          }

          // The canonical ref from resolution, not the one the model wrote: the
          // send path re-parses this string, and only 'shared' / an account id
          // round-trip through it.
          const token = createDraftToken(ctx.userId, String(mailbox.ref), {
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject,
            bodyText: input.body,
            inReplyTo,
            references,
            attachmentIds: input.attachment_ids,
          });

          const recipientLine = formatRecipients(input.to);
          const attachmentLine = attachments.files.length
            ? `\nAttachments: ${attachments.files.map((f) => f.filename).join(', ')}`
            : '';

          return {
            type: 'ask_user',
            status: 'pending',
            action: 'draft',
            draft_token: token,
            title: 'Send this email?',
            description: `From: ${mailbox.address}\nTo: ${recipientLine}${input.cc?.length ? `\nCc: ${formatRecipients(input.cc)}` : ''}\nSubject: ${subject}${attachmentLine}\n\n${input.body}`,
            questions: [
              {
                id: 'confirm',
                label: `Send from ${mailbox.address}?`,
                type: 'single_choice',
                required: true,
                options: [
                  { value: `send ${token}`, label: 'Send' },
                  { value: 'cancel', label: 'Cancel' },
                ],
              },
            ],
          };
        }

        // ── send ──
        if (!input.draft_token) return { action: 'send', error: 'draft_token is required.' };
        if (input.user_confirmed !== true) {
          return { action: 'send', error: 'user_confirmed must be true — ask the user before sending.' };
        }

        const draft = consumeDraftToken(input.draft_token, ctx.userId);
        if (!draft) {
          return {
            action: 'send',
            error: 'That draft token is invalid, already used or expired. Draft the message again and re-confirm.',
          };
        }

        const ref = parseMailboxRef(draft.accountRef);
        if (ref === null) return { action: 'send', error: 'The draft references an unknown mailbox.' };
        const resolved = await resolveMailbox(db, { userId: ctx.userId, userRole: ctx.userRole }, ref);
        if (!resolved.ok) return { action: 'send', error: resolved.error };

        const attachments = await loadAttachments(db, ctx.sessionId, draft.attachmentIds ?? []);
        if (!attachments.ok) return { action: 'send', error: attachments.error };

        const result = await sendMail(
          db,
          resolved.mailbox,
          {
            to: draft.to,
            cc: draft.cc,
            bcc: draft.bcc,
            subject: draft.subject,
            body_text: draft.bodyText,
            body_html: draft.bodyHtml,
            in_reply_to: draft.inReplyTo,
            references: draft.references,
            attachments: attachments.files,
          },
          { userId: ctx.userId, origin: 'chat', sessionId: ctx.sessionId ?? null },
        );
        if (!result.ok) return { action: 'send', error: result.error };

        return {
          action: 'send',
          status: 'sent',
          from: resolved.mailbox.address,
          to: draft.to.map((a) => a.address),
          subject: draft.subject,
          message_id: result.messageId,
        };
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}

export const emailMutationTool = defineTool({ meta, kind: 'lazy' });
