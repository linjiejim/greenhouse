/**
 * The closing turn-context block: per-turn content rides the END of the newest
 * user message so the system prompt and every earlier message keep their bytes.
 */

import { describe, expect, it } from 'vitest';
import type { EngineMessage } from '@greenhouse/agent-core';
import { TURN_CONTEXT_HEADER, appendImageIdHints, appendTurnContext, buildTurnContextBlock } from './turn-context.js';

const NOW = new Date('2026-10-23T02:00:00Z');

describe('buildTurnContextBlock', () => {
  it('always carries the current time under a header that says the user did not write it', () => {
    const block = buildTurnContextBlock({ now: NOW });
    expect(block.startsWith(`\n\n---\n${TURN_CONTEXT_HEADER}\n[Current Time: 2026-10-23 Friday 10:00]`)).toBe(true);
    expect(block).not.toContain('## Attached Images');
  });

  it('collects the attached-images note and the connectors block', () => {
    const block = buildTurnContextBlock({ now: NOW, visionInlinedImages: 2, connectorsBlock: '\n\nCONNECTORS-7' });
    expect(block).toContain('## Attached Images');
    expect(block.endsWith('CONNECTORS-7')).toBe(true);
  });
});

describe('appendTurnContext', () => {
  const history: EngineMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
  ];

  it('appends to the newest user message only, without mutating the input', () => {
    const out = appendTurnContext(history, '\n\nBLOCK');
    expect(out.map((m) => m.content)).toEqual(['first', 'reply', 'second\n\nBLOCK']);
    expect(history[2]!.content).toBe('second');
    expect(out[0]).toBe(history[0]); // earlier messages are untouched references
  });

  it('adds a trailing text part to multimodal content, after the images', () => {
    const image = new Uint8Array([1]);
    const out = appendTurnContext(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', image },
          ],
        },
      ],
      '\n\nBLOCK',
    );
    expect(out[0]!.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', image },
      { type: 'text', text: 'BLOCK' },
    ]);
  });

  it('leaves a transcript without a user message alone', () => {
    const only: EngineMessage[] = [{ role: 'assistant', content: 'hi' }];
    expect(appendTurnContext(only, '\n\nBLOCK')).toBe(only);
  });
});

describe('appendImageIdHints', () => {
  it('hints every user message that carries images, so older turns keep their bytes', () => {
    const out = appendImageIdHints([
      { role: 'user', content: 'look', images: [{ id: 'a.png' }, { id: 'a.png' }] },
      { role: 'assistant', content: 'ok', images: [{ id: 'never.png' }] },
      { role: 'user', content: 'and this', images: [{ id: 'b.png' }] },
      { role: 'user', content: 'plain', images: [] },
    ]);
    expect(out.map((m) => m.content)).toEqual([
      'look\n\n[Attached image ID(s): a.png.]',
      'ok',
      'and this\n\n[Attached image ID(s): b.png.]',
      'plain',
    ]);
  });
});
