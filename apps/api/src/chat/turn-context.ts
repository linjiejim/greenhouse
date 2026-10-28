/**
 * Cache-first chat prompt: what changes per turn goes at the END.
 *
 * DeepSeek and the OpenAI-compatible providers cache prompt prefixes
 * automatically, so every byte that differs from the previous request throws
 * away the cache from that point on. The system prompt therefore holds only
 * what is stable for a session (profile prompt, user notes, memory index, tool
 * guidance, response language, the rolling digest), and everything that varies
 * per turn — the current time, the attached-images note, the reachable
 * connectors — rides a closing block appended to the newest
 * user message, for the model only. The block is never persisted, so on the
 * next turn that message renders without it: the shared prefix still reaches
 * the end of the user's own text.
 *
 * Image ID hints are different: they are part of each message's own content and
 * are attached to every user message that carries images, so a message renders
 * the same bytes on every turn instead of losing its hint once it is no longer
 * the newest.
 */

import { formatCurrentTimeLine, type EngineMessage } from '@greenhouse/agent-core';
import { sanitizeForPrompt } from '../security/security.js';

/** First line of the closing block — tells the model who wrote what follows. */
export const TURN_CONTEXT_HEADER =
  '[Turn context — added by Greenhouse for this message only; it was not written by the user]';

export interface TurnContextInput {
  /** Defaults to the wall clock; injectable for tests. */
  now?: Date;
  /** Images the vision path inlined as pixels this turn. */
  visionInlinedImages?: number;
  /** The connectors mcp_call can reach this turn (tools/mcp-call.ts buildConnectorsContext). */
  connectorsBlock?: string;
}

/** The per-turn closing block appended to the newest user message. */
export function buildTurnContextBlock(input: TurnContextInput): string {
  let block = `\n\n---\n${TURN_CONTEXT_HEADER}\n${formatCurrentTimeLine(input.now ?? new Date())}`;

  // Vision models see attached images directly, but analyze_image's own
  // description commands "call this for each attached image" — verified
  // live: without this note the model invents a placeholder URL
  // (https://placeholder.local/…) to satisfy the tool, burns a step on a
  // guaranteed failure, then answers from the pixels anyway.
  if ((input.visionInlinedImages ?? 0) > 0) {
    block +=
      `\n\n## Attached Images\n` +
      `The user's attached images are embedded in this conversation — you can see them directly. ` +
      `Do NOT call analyze_image for images you can already see, and never invent an image ID or URL. ` +
      `analyze_image is only for a public HTTPS image URL, or an image ID explicitly listed in the message text.`;
  }

  if (input.connectorsBlock) block += input.connectorsBlock;

  return block;
}

/**
 * Append the closing block to the newest user message (a copy — the input is
 * not mutated). Multimodal content gets it as a trailing text part so image
 * parts stay where they are. A transcript without a user message is returned
 * unchanged.
 */
export function appendTurnContext(messages: EngineMessage[], block: string): EngineMessage[] {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0 || !block) return messages;

  return messages.map((message, index) => {
    if (index !== lastUser) return message;
    if (typeof message.content === 'string') return { ...message, content: message.content + block };
    return { ...message, content: [...message.content, { type: 'text' as const, text: block.trimStart() }] };
  });
}

/** Same wording as the vision path's fallback, so the model's analyze_image habit transfers. */
function imageIdHint(ids: string[]): string {
  return `\n\n[Attached image ID(s): ${ids.join(', ')}.]`;
}

/**
 * Text-only models receive upload IDs rather than image bytes. Every user
 * message that carries images gets its own ID hint (not just the newest), so
 * the message renders identically on later turns and follow-up questions about
 * an earlier image still have its ID. Resolved from the effective transcript
 * (including persisted history), so regeneration with no new body message
 * keeps an image-only turn's visual context.
 */
export function appendImageIdHints<T extends { role: string; content: string; images?: Array<{ id: string }> | null }>(
  messages: T[],
): T[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.images?.length) return message;
    const ids = [
      ...new Set(message.images.map((image) => sanitizeForPrompt(image.id).trim().slice(0, 256)).filter(Boolean)),
    ];
    return ids.length > 0 ? { ...message, content: message.content + imageIdHint(ids) } : message;
  });
}
