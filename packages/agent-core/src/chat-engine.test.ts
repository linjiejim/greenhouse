import { describe, expect, it } from 'vitest';
import {
  buildEngineResult,
  createCollectors,
  processStreamPart,
  withFinalAnswerGuarantee,
  type AgentStreamResult,
} from './chat-engine.js';

function fakeStream(
  parts: readonly Record<string, unknown>[],
  usage: Record<string, number>,
  overrides: Record<string, unknown> = {},
): AgentStreamResult {
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        for (const part of parts) yield part;
      },
    },
    usage: Promise.resolve(usage),
    text: Promise.resolve(''),
    finalStep: Promise.resolve({ reasoningText: undefined }),
    finishReason: Promise.resolve('tool-calls'),
    responseMessages: Promise.resolve([]),
    ...overrides,
  } as unknown as AgentStreamResult;
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
