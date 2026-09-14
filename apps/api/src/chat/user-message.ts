/**
 * Sanitising a user turn without eating its attachments.
 *
 * The browser appends an ```attachments fence AFTER the user's prose, and the
 * whole string used to go through `sanitizeForPrompt()` in one piece — whose
 * first defence is an 8000-character truncation. So a long message silently
 * lost its own fence: the file ids never reached the model, `read_attachment`
 * had nothing to be called with, and the agent would answer as if no file had
 * been sent. Nothing errored; the attachment simply stopped existing.
 *
 * The model-input fix splits the two before sanitising. Prose is truncated at
 * the model boundary — that ceiling is a real defence against context-window
 * abuse — while the database keeps the exact user-authored message. The fence
 * is not passed to the model verbatim either: it is
 * parsed, validated, re-projected onto the three fields the contract defines
 * and re-serialised, so anything a client tried to smuggle through an extra
 * key or a hostile filename is dropped rather than sanitised in place.
 *
 * Deliberately NOT fixed inside `sanitizeForPrompt`: it is the shared floor for
 * every prompt-bound string in the API, and giving it a "but not this part"
 * mode would weaken every other caller to serve one.
 */

import { splitAttachments, type ChatAttachmentItem } from '@greenhouse/types/rich-output';
import { sanitizeForPrompt } from '../security/security.js';

/**
 * Filenames are display text bound for the prompt. 255 is the same ceiling the
 * drive upload policy applies, and the practical filesystem limit.
 */
const MAX_ATTACHMENT_NAME = 255;

/** How many chips may ride along is already the shared contract's call. */
function toSafeChip(item: ChatAttachmentItem): ChatAttachmentItem {
  const name = sanitizeForPrompt(item.name).slice(0, MAX_ATTACHMENT_NAME).trim();
  return {
    // Exactly one handle kind is set — the parser guarantees it, and rebuilding
    // from the guaranteed one keeps that invariant true on the way out.
    ...(item.id ? { id: item.id } : { key: item.key }),
    // An empty name would fail revalidation and render as raw JSON, so the
    // sanitiser having eaten the whole filename must not cost us the chip.
    name: name || 'file',
    ...(item.size_bytes !== undefined ? { size_bytes: item.size_bytes } : {}),
  };
}

/**
 * Prepare an inbound user message for the model.
 *
 * Persistence must use the original message. This function is deliberately a
 * prompt-bound projection: it sanitises prose and rebuilds the attachment
 * fence without changing the permanent transcript.
 */
export function sanitizeUserMessageForPrompt(content: string): string {
  const { text, attachments } = splitAttachments(content);
  const safeText = sanitizeForPrompt(text);
  if (attachments.length === 0) return safeText;
  const chips = attachments.map(toSafeChip);
  return `${safeText}\n\n\`\`\`attachments\n${JSON.stringify(chips)}\n\`\`\``;
}

/** Project exact persisted/request messages onto the prompt-safe model view. */
export function sanitizeChatMessagesForPrompt<T extends { role: string; content: string }>(messages: T[]): T[] {
  return messages.map((message) =>
    message.role === 'user' ? { ...message, content: sanitizeUserMessageForPrompt(message.content) } : message,
  );
}
