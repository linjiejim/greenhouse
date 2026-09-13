/**
 * chat-vision — inlining attached images for catalog `vision: true` models.
 *
 * Contract under test: newest turns claim the inline budget first; anything
 * over budget or unloadable falls back to the same ID hint the non-vision
 * path uses (so analyze_image stays reachable) instead of silently vanishing.
 */

import { describe, it, expect } from 'vitest';
import {
  inlineImagesForVision,
  MAX_INLINE_IMAGES,
  MAX_INLINE_IMAGE_BYTES,
  type VisionSourceMessage,
} from '../chat-vision.js';
import type { EngineContentPart } from '@greenhouse/agent-core';

const PNG = { buffer: Buffer.from('89504e47deadbeef', 'hex'), contentType: 'image/png' };

function userMsg(content: string, ids: string[] = []): VisionSourceMessage {
  return { role: 'user', content, images: ids.map((id) => ({ id, url: `/api/upload/${id}` })) };
}

function parts(msg: { content: unknown }): EngineContentPart[] {
  return msg.content as EngineContentPart[];
}

describe('inlineImagesForVision', () => {
  it('turns a user message with images into text + image parts', async () => {
    const { messages, inlined, hinted } = await inlineImagesForVision(
      [userMsg('看看这张图', ['img-1'])],
      async () => PNG,
    );

    expect(inlined).toBe(1);
    expect(hinted).toBe(0);
    const content = parts(messages[0]!);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: '看看这张图' });
    expect(content[1]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    expect((content[1] as unknown as { image: Buffer }).image.equals(PNG.buffer)).toBe(true);
  });

  it('emits image-only content for a text-less turn (no empty text part)', async () => {
    const { messages } = await inlineImagesForVision([userMsg('', ['img-1'])], async () => PNG);
    expect(parts(messages[0]!)).toHaveLength(1);
    expect(parts(messages[0]!)[0]!.type).toBe('image');
  });

  it('passes through non-user messages and imageless turns untouched', async () => {
    const input: VisionSourceMessage[] = [
      { role: 'assistant', content: 'earlier answer', created_at: '2026-08-11T00:00:00Z' },
      userMsg('no images here'),
    ];
    const { messages, inlined } = await inlineImagesForVision(input, async () => PNG);
    expect(inlined).toBe(0);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'earlier answer',
      created_at: '2026-08-11T00:00:00Z',
    });
    expect(messages[1]!.content).toBe('no images here');
  });

  it('inlines history images too — follow-ups about an earlier image need no re-upload', async () => {
    const { messages, inlined } = await inlineImagesForVision(
      [userMsg('first image', ['img-old']), { role: 'assistant', content: 'ok' }, userMsg('and this one', ['img-new'])],
      async () => PNG,
    );
    expect(inlined).toBe(2);
    expect(parts(messages[0]!)).toHaveLength(2);
    expect(parts(messages[2]!)).toHaveLength(2);
  });

  it('allocates the budget newest-first; older overflow falls back to the ID hint', async () => {
    const oldIds = Array.from({ length: MAX_INLINE_IMAGES }, (_, i) => `old-${i}`);
    const { messages, inlined, hinted } = await inlineImagesForVision(
      [userMsg('older turn', oldIds), userMsg('newest turn', ['new-1'])],
      async () => PNG,
    );

    expect(inlined).toBe(MAX_INLINE_IMAGES);
    expect(hinted).toBe(1);
    // The newest turn always gets its image…
    expect(parts(messages[1]!).filter((p) => p.type === 'image')).toHaveLength(1);
    // …and the oldest one that lost the race keeps a hint instead of nothing.
    const older = messages[0]!;
    const olderParts = parts(older);
    expect(olderParts.filter((p) => p.type === 'image')).toHaveLength(MAX_INLINE_IMAGES - 1);
    const text = (olderParts[0] as { text: string }).text;
    expect(text).toContain('Attached image ID(s):');
    expect(text).toContain(`old-${MAX_INLINE_IMAGES - 1}`);
  });

  it('hints instead of inlining when the upload is missing, oversized, or throws', async () => {
    const big = { buffer: Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1), contentType: 'image/png' };
    const loaders: Record<string, () => Promise<typeof PNG | null>> = {
      missing: async () => null,
      huge: async () => big,
      broken: async () => {
        throw new Error('COS down');
      },
    };
    const { messages, inlined, hinted } = await inlineImagesForVision(
      [userMsg('三张都有问题', ['missing', 'huge', 'broken'])],
      (id) => loaders[id]!(),
    );

    expect(inlined).toBe(0);
    expect(hinted).toBe(3);
    expect(messages[0]!.content).toBe('三张都有问题\n\n[Attached image ID(s): missing, huge, broken.]');
  });

  it('dedupes repeated ids within a message', async () => {
    const { inlined } = await inlineImagesForVision([userMsg('dup', ['img-1', 'img-1'])], async () => PNG);
    expect(inlined).toBe(1);
  });
});
