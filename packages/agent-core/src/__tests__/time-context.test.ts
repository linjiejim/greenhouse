/**
 * Time-context injection over multimodal content.
 *
 * String messages have carried timestamp prefixes since v1; the vision path
 * introduces part-array user content, where the timestamp must ride the first
 * text part (or a new leading one) and never corrupt image parts.
 *
 * Stamps come from each message's own `created_at`, never from the clock, so a
 * message renders the same bytes on every later turn (prompt-prefix caching);
 * the live current time is the host's closing turn-context block.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatCurrentTimeLine, injectTimeContext, type EngineContentPart } from '../time-context.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('injectTimeContext', () => {
  it('prefixes every string user message with its own stored timestamp', () => {
    const out = injectTimeContext([
      { role: 'user', content: 'earlier', created_at: '2026-08-01T04:00:00Z' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'latest', created_at: '2026-08-01T05:30:00Z' },
    ]);
    expect(out[0]!.content).toMatch(/^\[2026-08-01 .* 12:00\] earlier$/);
    expect(out[1]!.content).toBe('reply');
    expect(out[2]!.content).toMatch(/^\[2026-08-01 .* 13:30\] latest$/);
  });

  it('renders the same bytes for a message whatever the clock says', () => {
    const transcript = [
      { role: 'user', content: 'hello', created_at: '2026-08-01T04:00:00Z' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'and now?' },
    ];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T04:01:00Z'));
    const first = injectTimeContext(transcript);
    vi.setSystemTime(new Date('2026-08-09T22:00:00Z'));
    const later = injectTimeContext(transcript);
    expect(later).toEqual(first);
    // No stored time → no stamp; the host's closing block carries "now".
    expect(later[2]!.content).toBe('and now?');
  });

  it('prefixes the first text part of multimodal content, leaving images alone', () => {
    const image = new Uint8Array([1, 2, 3]);
    const out = injectTimeContext([
      {
        role: 'user',
        created_at: '2026-08-01T04:00:00Z',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', image, mediaType: 'image/png' },
        ],
      },
    ]);
    const parts = out[0]!.content as EngineContentPart[];
    expect(parts).toHaveLength(2);
    expect((parts[0] as { text: string }).text).toMatch(/^\[2026-08-01 .*\] what is this\?$/);
    expect(parts[1]).toEqual({ type: 'image', image, mediaType: 'image/png' });
  });

  it('prepends a text part for image-only turns instead of dropping the timestamp', () => {
    const out = injectTimeContext([
      {
        role: 'user',
        created_at: '2026-08-01T04:00:00Z',
        content: [{ type: 'image', image: new Uint8Array([1]), mediaType: 'image/png' }],
      },
    ]);
    const parts = out[0]!.content as EngineContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe('text');
    expect((parts[0] as { text: string }).text).toMatch(/^\[2026-08-01 .*\]$/);
    expect(parts[1]!.type).toBe('image');
  });

  it('leaves part-content untouched when there is no timestamp to add', () => {
    const content: EngineContentPart[] = [{ type: 'text', text: 'old turn' }];
    const out = injectTimeContext([
      { role: 'user', content, created_at: 'not-a-date' },
      { role: 'user', content: 'latest' },
    ]);
    expect(out[0]!.content).toBe(content); // same reference — nothing rewritten
  });
});

describe('formatCurrentTimeLine', () => {
  it('formats the given instant in the target timezone', () => {
    expect(formatCurrentTimeLine(new Date('2026-08-01T04:00:00Z'))).toBe('[Current Time: 2026-08-01 Saturday 12:00]');
  });
});
