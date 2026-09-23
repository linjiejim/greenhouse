/**
 * Chat vision path — inline attached images for catalog `vision: true` models.
 *
 * A text-only model gets only image IDs (a text hint) and calls analyze_image
 * for a prose description. A natively multimodal model — the default one
 * (`flash`, e.g. DeepSeek V4.1 Flash) unless LLM_VISION=false — sees the
 * pixels instead: this module resolves the `images` metadata on user messages
 * into AI SDK image parts via the shared upload storage, so the provider
 * client ships them as base64 `image_url` entries.
 *
 * Bounded on purpose — base64 payloads are unbounded history growth otherwise:
 * newest messages claim the inline budget first; anything over budget (or that
 * fails to load) falls back to the ID hint, keeping the analyze_image path
 * available rather than silently dropping the attachment.
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { EngineMessage, EngineContentPart } from '@greenhouse/agent-core';
import { sanitizeForPrompt } from '../security/security.js';
import { getUpload } from '../storage/uploads.js';

export interface VisionSourceMessage {
  role: string;
  content: string;
  created_at?: string;
  images?: Array<{ id: string; url: string }> | null;
}

/** Most images inlined into one model payload, newest turns first. */
export const MAX_INLINE_IMAGES = 8;
/** Per-image byte ceiling — larger uploads fall back to the ID hint. */
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
/** Total inlined bytes per payload (base64 inflates ~1.33x on the wire). */
export const MAX_TOTAL_INLINE_BYTES = 24 * 1024 * 1024;

type UploadLoader = (id: string) => Promise<{ buffer: Buffer; contentType: string } | null>;

export interface VisionInlineResult {
  messages: EngineMessage[];
  /** Images shipped as pixels. */
  inlined: number;
  /** Images that fell back to the ID hint (over budget / missing / unreadable). */
  hinted: number;
}

/** Same wording the non-vision path uses, so the model's analyze_image habit transfers. */
function imageIdHint(ids: string[]): string {
  return `\n\n[Attached image ID(s): ${ids.join(', ')}.]`;
}

function sanitizedImageIds(images: VisionSourceMessage['images']): string[] {
  return [...new Set((images ?? []).map((image) => sanitizeForPrompt(image.id).trim().slice(0, 256)).filter(Boolean))];
}

/**
 * Resolve user-message image metadata into multimodal content parts.
 *
 * Applies to every user turn in the (already windowed) payload — follow-up
 * questions about an earlier image must not require re-uploading it. The
 * budget is allocated newest-to-oldest so the turn being answered always wins.
 */
export async function inlineImagesForVision(
  messages: VisionSourceMessage[],
  loadUpload: UploadLoader = getUpload,
): Promise<VisionInlineResult> {
  const result: EngineMessage[] = new Array(messages.length);
  let remainingCount = MAX_INLINE_IMAGES;
  let remainingBytes = MAX_TOTAL_INLINE_BYTES;
  let inlined = 0;
  let hinted = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const imageIds = msg.role === 'user' ? sanitizedImageIds(msg.images) : [];
    if (imageIds.length === 0) {
      result[i] = { ...msg };
      continue;
    }

    const imageParts: EngineContentPart[] = [];
    const hintedIds: string[] = [];
    for (const id of imageIds) {
      if (remainingCount <= 0) {
        hintedIds.push(id);
        continue;
      }
      let stored: Awaited<ReturnType<UploadLoader>> = null;
      try {
        stored = await loadUpload(id);
      } catch (err) {
        logger.warn(`[chat-vision] failed to load image ${id}: ${toErrorMessage(err)}`);
      }
      if (!stored || stored.buffer.length > MAX_INLINE_IMAGE_BYTES || stored.buffer.length > remainingBytes) {
        hintedIds.push(id);
        continue;
      }
      remainingCount -= 1;
      remainingBytes -= stored.buffer.length;
      imageParts.push({ type: 'image', image: stored.buffer, mediaType: stored.contentType });
    }

    inlined += imageParts.length;
    hinted += hintedIds.length;

    const text = msg.content + (hintedIds.length > 0 ? imageIdHint(hintedIds) : '');
    result[i] =
      imageParts.length === 0
        ? { ...msg, content: text }
        : { ...msg, content: [...(text ? [{ type: 'text' as const, text }] : []), ...imageParts] };
  }

  return { messages: result, inlined, hinted };
}
