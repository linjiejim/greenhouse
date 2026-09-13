import { describe, expect, it } from 'vitest';
import type { StreamTextResult, ToolSet } from 'ai';
import { buildEngineResult, createCollectors, processStreamPart, withFinalAnswerGuarantee } from './chat-engine.js';

function fakeStream(
  parts: readonly Record<string, unknown>[],
  usage: Record<string, number>,
  overrides: Record<string, unknown> = {},
): StreamTextResult<ToolSet, never> {
  return {
    fullStream: {
      async *[Symbol.asyncIterator]() {
        for (const part of parts) yield part;
      },
    },
    totalUsage: Promise.resolve(usage),
    text: Promise.resolve(''),
    reasoningText: Promise.resolve(undefined),
    finishReason: Promise.resolve('tool-calls'),
    response: Promise.resolve({ messages: [] }),
    ...overrides,
  } as unknown as StreamTextResult<ToolSet, never>;
}

describe('DeepSeek final-answer usage accounting', () => {
  it('adds every fallback attempt to the primary total used by host settlement', async () => {
    const primary = fakeStream(
      [
        { type: 'tool-result', toolCallId: 'tool-1', toolName: 'knowledge_query', output: { found: 1 } },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 10, outputTokens: 5 } },
      ],
      { inputTokens: 10, outputTokens: 5, cachedInputTokens: 1, reasoningTokens: 0 },
    );
    const fallbacks = [
      fakeStream([], { inputTokens: 7, outputTokens: 2, cachedInputTokens: 2, reasoningTokens: 1 }),
      fakeStream([{ type: 'text-delta', text: 'Final answer' }], {
        inputTokens: 11,
        outputTokens: 4,
        cachedInputTokens: 3,
        reasoningTokens: 2,
      }),
    ];
    let fallbackIndex = 0;
    const collectors = createCollectors();

    for await (const part of withFinalAnswerGuarantee(primary, {
      profile: { model: { provider: 'deepseek', model: 'deepseek-test' } },
      systemPrompt: 'system',
      baseMessages: [{ role: 'user', content: 'question' }],
      finalAnswerStreamFactory: async () => fallbacks[fallbackIndex++]!,
    })) {
      processStreamPart(part, collectors);
    }

    const result = await buildEngineResult(primary, collectors, [], Date.now());

    expect(fallbackIndex).toBe(2);
    expect(result.text).toBe('Final answer');
    expect(result.usage).toEqual({
      inputTokens: 28,
      outputTokens: 11,
      cachedInputTokens: 6,
      reasoningTokens: 3,
    });
  });
});
