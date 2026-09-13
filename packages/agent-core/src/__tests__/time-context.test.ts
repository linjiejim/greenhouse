/**
 * Time-context injection over multimodal content.
 *
 * String messages have carried timestamp prefixes since v1; the vision path
 * introduces part-array user content, where the timestamp must ride the first
 * text part (or a new leading one) and never corrupt image parts.
 */

import { describe, it, expect } from 'vitest';
import { injectTimeContext, type EngineContentPart } from '../time-context.js';

describe('injectTimeContext', () => {
  it('prefixes string user messages (last gets Current Time)', () => {
    const out = injectTimeContext([
      { role: 'user', content: 'earlier', created_at: '2026-08-01T04:00:00Z' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'latest' },
    ]);
    expect(out[0]!.content).toMatch(/^\[2026-08-01 .* 12:00\] earlier$/);
    expect(out[1]!.content).toBe('reply');
    expect(out[2]!.content).toMatch(/^\[Current Time: .*\] latest$/);
  });

  it('prefixes the first text part of multimodal content, leaving images alone', () => {
    const image = new Uint8Array([1, 2, 3]);
    const out = injectTimeContext([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', image, mediaType: 'image/png' },
        ],
      },
    ]);
    const parts = out[0]!.content as EngineContentPart[];
    expect(parts).toHaveLength(2);
    expect((parts[0] as { text: string }).text).toMatch(/^\[Current Time: .*\] what is this\?$/);
    expect(parts[1]).toEqual({ type: 'image', image, mediaType: 'image/png' });
  });

  it('prepends a text part for image-only turns instead of dropping the timestamp', () => {
    const out = injectTimeContext([
      { role: 'user', content: [{ type: 'image', image: new Uint8Array([1]), mediaType: 'image/png' }] },
    ]);
    const parts = out[0]!.content as EngineContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe('text');
    expect((parts[0] as { text: string }).text).toMatch(/^\[Current Time: .*\]$/);
    expect(parts[1]!.type).toBe('image');
  });

  it('leaves historical part-content untouched when there is no timestamp to add', () => {
    const content: EngineContentPart[] = [{ type: 'text', text: 'old turn' }];
    const out = injectTimeContext([
      { role: 'user', content, created_at: 'not-a-date' },
      { role: 'user', content: 'latest' },
    ]);
    expect(out[0]!.content).toBe(content); // same reference — nothing rewritten
  });
});
