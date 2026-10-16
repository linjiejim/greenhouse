import { describe, expect, it } from 'vitest';
import { replyParts, replyText } from '../reply.js';
import { REPLY_STYLE_RULE } from '@greenhouse/utils/prompts';
import { buildInstruction } from '../prompt.js';

describe('reply contract', () => {
  it('requires concise plain-text chat and explicit wake delivery', () => {
    for (const rule of [
      '1–3',
      'Plain text',
      'three parallel',
      'Never use headings',
      'bold for emphasis',
      'inline code',
      'todo',
    ])
      expect(REPLY_STYLE_RULE).toContain(rule);
    expect(buildInstruction({ reason: 'event', note: 'Nothing changed' })).toContain('only send_message');
    expect(buildInstruction({ reason: 'event', note: 'Nothing changed' })).toContain('Stay silent');
  });
  it('keeps member streaming in one reply and suppresses all wake-up text', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'Private' };
      yield { type: 'tool-call' };
      yield { type: 'finish-step' };
      yield { type: 'text-delta', text: 'Answer' };
      yield { type: 'finish-step' };
    }
    const seen = [];
    for await (const p of replyParts(parts(), false)) seen.push(p);
    expect(seen.filter((p) => p.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'Private' },
      { type: 'text-delta', text: 'Answer' },
    ]);
    const wake = [];
    for await (const p of replyParts(parts(), true)) wake.push(p);
    expect(wake.filter((p) => p.type === 'text-delta')).toEqual([]);
    expect(
      replyText([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Private' },
            { type: 'tool-call', toolCallId: 'x', toolName: 'todo', input: {} },
          ],
        },
      ]),
    ).toBe('');
  });
});
