/**
 * In-turn tool-result masking — the kernel mechanics both chat and Bots use.
 * Pins: nothing changes under the budget; past it the OLDEST results are
 * masked down to the retain share (the newest never); masks only grow, so the
 * prefix is stable between batches whichever message history the SDK hands
 * back (v6 resent the originals, v7 carries the rewritten ones forward); the
 * stub keeps what the call asked for so the model can fetch it again.
 */

import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  chatMaskStub,
  createToolResultMasker,
  resolveInTurnToolBudget,
  CHAT_IN_TURN_TOOL_TOKEN_BUDGET,
} from '../tool-result-masker.js';

/** One assistant tool call + its result, the result ~`tokens` tokens of ASCII. */
function exchange(id: string, toolName: string, input: Record<string, unknown>, tokens: number): ModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value: 'x'.repeat(tokens * 4) } },
      ],
    },
  ] as ModelMessage[];
}

function resultText(messages: ModelMessage[], id: string): string {
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content as Array<{ toolCallId: string; output: { value: string } }>) {
      if (part.toolCallId === id) return part.output.value;
    }
  }
  throw new Error(`no result ${id}`);
}

const user: ModelMessage = { role: 'user', content: 'research this' };

describe('createToolResultMasker', () => {
  it('leaves a turn under its budget untouched', () => {
    const mask = createToolResultMasker({ budgetTokens: 1000, stub: chatMaskStub });
    const messages = [user, ...exchange('a', 'knowledge_query', { doc_id: 'd1' }, 400)];
    expect(mask({ stepNumber: 1, messages })).toBeUndefined();
  });

  it('past the budget masks the oldest down to the retain share — never the newest', () => {
    const batches: unknown[] = [];
    const mask = createToolResultMasker({
      budgetTokens: 1000,
      retainTokens: 600,
      stub: chatMaskStub,
      onBatch: (b) => batches.push(b),
    });
    const messages = [
      user,
      ...exchange('a', 'knowledge_query', { action: 'get', doc_id: 'guide/a' }, 300),
      ...exchange('b', 'external_search', { query: 'pricing 2026' }, 300),
      ...exchange('c', 'knowledge_query', { action: 'get', doc_id: 'guide/c' }, 300),
      ...exchange('d', 'read_attachment', { file_id: 'f9' }, 300),
    ];

    const out = mask({ stepNumber: 4, messages })!;

    // 1200 live > 1000: keep the newest two (600 ≤ retain), mask a and b.
    expect(resultText(out, 'a')).toBe(
      '[knowledge_query result omitted to keep this turn within its context budget; it was called with {"action":"get","doc_id":"guide/a"} — call the tool again if you still need it]',
    );
    expect(resultText(out, 'b')).toContain('{"query":"pricing 2026"}');
    expect(resultText(out, 'c')).toHaveLength(1200);
    expect(resultText(out, 'd')).toHaveLength(1200);
    expect(batches).toEqual([{ stepNumber: 4, masked: 2, liveTokensBefore: 1200, liveTokensAfter: 600 }]);
    // Every call/result pair survives — only payloads shrink.
    expect(out).toHaveLength(messages.length);
  });

  it('a single result larger than the budget is kept — the current call always reaches the model', () => {
    const mask = createToolResultMasker({ budgetTokens: 100, stub: chatMaskStub });
    expect(mask({ stepNumber: 1, messages: [user, ...exchange('a', 'x', {}, 5000)] })).toBeUndefined();
  });

  it('masks only grow: the next step re-applies them without a new batch, whatever history it is handed', () => {
    const batches: unknown[] = [];
    const mask = createToolResultMasker({
      budgetTokens: 1000,
      retainTokens: 600,
      stub: chatMaskStub,
      onBatch: (b) => batches.push(b),
    });
    const base = [
      user,
      ...exchange('a', 't', {}, 300),
      ...exchange('b', 't', {}, 300),
      ...exchange('c', 't', {}, 300),
      ...exchange('d', 't', {}, 300),
    ];
    const first = mask({ stepNumber: 4, messages: base })!;

    // v6: the SDK resends the ORIGINAL messages plus the new step.
    const v6 = mask({ stepNumber: 5, messages: [...base, ...exchange('e', 't', {}, 50)] })!;
    // v7: the SDK carries the REWRITTEN messages forward plus the new step.
    const v7 = mask({ stepNumber: 5, messages: [...first, ...exchange('e', 't', {}, 50)] })!;

    for (const out of [v6, v7]) {
      expect(resultText(out, 'a')).toBe(resultText(first, 'a'));
      expect(resultText(out, 'c')).toHaveLength(1200);
    }
    expect(batches).toHaveLength(1); // 650 live after the batch: under budget, no new batch
  });

  it('with pinRefetched, an exact repeat of a masked call is kept — no fetch-A-mask-B ping-pong', () => {
    const refetches: string[] = [];
    const mask = createToolResultMasker({
      budgetTokens: 1000,
      retainTokens: 500,
      stub: chatMaskStub,
      pinRefetched: true,
      onRefetch: ({ toolName }) => refetches.push(toolName),
    });
    // Two ~600-token reports: each new one alone exceeds the retain share.
    let messages: ModelMessage[] = [
      user,
      ...exchange('a', 'fetch_report', { n: 1 }, 600),
      ...exchange('b', 'fetch_report', { n: 4 }, 600),
    ];
    let out = mask({ stepNumber: 2, messages })!;
    expect(resultText(out, 'a')).toContain('omitted');

    // The model needs report 1 back and asks again.
    messages = [...messages, ...exchange('c', 'fetch_report', { n: 1 }, 600)];
    out = mask({ stepNumber: 3, messages }) ?? messages;
    expect(refetches).toEqual(['fetch_report']);
    // The re-fetch is pinned, and the newest unpinned result stays as always:
    // both reports now sit side by side (a little over budget) and the loop
    // converges instead of trading one for the other.
    expect(resultText(out, 'c')).toHaveLength(2400);
    expect(resultText(out, 'b')).toHaveLength(2400);
    expect(resultText(out, 'a')).toContain('omitted');

    // A further unrelated read pushes the unpinned one out — never the pin.
    messages = [...messages, ...exchange('d', 'fetch_report', { n: 2 }, 600)];
    out = mask({ stepNumber: 4, messages })!;
    expect(resultText(out, 'c')).toHaveLength(2400);
    expect(resultText(out, 'b')).toContain('omitted');
    expect(resultText(out, 'd')).toHaveLength(2400);
  });

  it('without pinRefetched (Bots), a repeated input is a new observation and still gets masked', () => {
    const mask = createToolResultMasker({ budgetTokens: 1000, stub: () => '[stub]' });
    let messages: ModelMessage[] = [user];
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      messages = [...messages, ...exchange(id, 'browser', { action: 'snapshot' }, 400)];
      messages = mask({ stepNumber: 1, messages }) ?? messages;
    }
    const whole = ['a', 'b', 'c', 'd', 'e'].filter((id) => resultText(messages, id) !== '[stub]');
    expect(whole).toEqual(['e']);
  });

  it('respects isMaskable (Bots mask only superseded page observations)', () => {
    const mask = createToolResultMasker({
      budgetTokens: 100,
      isMaskable: (name) => name === 'browser',
      stub: () => '[stub]',
    });
    const out = mask({
      stepNumber: 3,
      messages: [
        user,
        ...exchange('a', 'browser', {}, 80),
        ...exchange('b', 'knowledge_query', {}, 80),
        ...exchange('c', 'browser', {}, 80),
      ],
    })!;
    expect(resultText(out, 'a')).toBe('[stub]');
    expect(resultText(out, 'b')).toHaveLength(320);
    expect(resultText(out, 'c')).toHaveLength(320);
  });
});

describe('resolveInTurnToolBudget', () => {
  it('is 32k, or a quarter of a smaller window', () => {
    expect(resolveInTurnToolBudget(undefined)).toBe(CHAT_IN_TURN_TOOL_TOKEN_BUDGET);
    expect(resolveInTurnToolBudget(1_000_000)).toBe(32_000);
    expect(resolveInTurnToolBudget(64_000)).toBe(16_000);
  });

  it('lends the history budget a short conversation left unused — never less than the base', () => {
    expect(resolveInTurnToolBudget(128_000, 60_000)).toBe(92_000);
    expect(resolveInTurnToolBudget(128_000, 0)).toBe(32_000);
    // A history window whose estimate overshot its budget lends nothing.
    expect(resolveInTurnToolBudget(128_000, -500)).toBe(32_000);
  });
});
