import { describe, expect, it } from 'vitest';
import { closeTranscript } from '../history.js';

describe('the closing message', () => {
  it('joins a transcript that ends with a user message, so roles alternate', () => {
    const closed = closeTranscript(
      [
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: 'hi', created_at: '2026-10-13T08:00:00Z' },
      ],
      '<turn_context/>\n\nReply.',
    );
    expect(closed).toEqual([
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'hi\n\n<turn_context/>\n\nReply.', created_at: '2026-10-13T08:00:00Z' },
    ]);
  });

  it('stands alone after an assistant message, and carries the images either way', () => {
    const image = { type: 'image' as const, image: new URL('https://example.com/a.png') };
    expect(closeTranscript([{ role: 'assistant', content: 'Done.' }], 'Continue.', [image])).toEqual([
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: [{ type: 'text', text: 'Continue.' }, image] },
    ]);
    expect(closeTranscript([{ role: 'user', content: 'look' }], 'Reply.', [image])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'look\n\nReply.' }, image] },
    ]);
    expect(closeTranscript([], 'Reply.')).toEqual([{ role: 'user', content: 'Reply.' }]);
  });
});
