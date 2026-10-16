import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { boundedMessages, finalAnswer, MAX_STEP_CHARS } from '../steps.js';

const call = (id: string): ModelMessage => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'Let me look.' },
    { type: 'tool-call', toolCallId: id, toolName: 'web_fetch', input: { url: 'https://example.com' } },
  ],
});

const result = (id: string, value: unknown): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: 'web_fetch', output: { type: 'json', value } as never }],
});

describe('model steps', () => {
  it('keep a small step as it is', () => {
    const step = [call('c1'), result('c1', { content: 'short' })];
    expect(boundedMessages(step)).toBe(step);
  });

  it('cut long tool results first, keeping every call and result whole', () => {
    const step = [call('c1'), result('c1', { content: 'x'.repeat(60_000) })];
    const bounded = boundedMessages(step);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MAX_STEP_CHARS + 200);
    expect(bounded[0]).toEqual(step[0]);
    const part = (
      bounded[1]!.content as Array<{ type: string; toolCallId: string; output: { type: string; value: string } }>
    )[0]!;
    expect(part).toMatchObject({ type: 'tool-result', toolCallId: 'c1', output: { type: 'text' } });
    expect(part.output.value).toMatch(/…\[cut: \d+ more characters\]$/);
  });

  it('know when the last recorded step was the answer', () => {
    expect(finalAnswer([[call('c1'), result('c1', {})]])).toBeNull();
    expect(
      finalAnswer([
        [call('c1'), result('c1', {})],
        [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
      ]),
    ).toBe('Done.');
    expect(finalAnswer([])).toBeNull();
  });
});
