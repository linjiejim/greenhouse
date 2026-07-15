/**
 * BEHAVIOR TEST — withFinalAnswerGuarantee (chat-engine.ts).
 *
 * The guarantee must be a byte-identical passthrough whenever the primary
 * stream produced text (or never ran a tool), and must splice exactly one
 * tools-off "answer now" pass — built from a plain-text digest of the gathered
 * tool results — before `finish` when a run ends with tools but no text.
 *
 * The model factory is mocked so the continuation pass runs against
 * `MockLanguageModelV3` through the real `streamText`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

vi.mock('../model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model.js')>();
  return { ...actual, createModelFromConfig: vi.fn() };
});
vi.mock('@greenhouse/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createModelFromConfig } from '../model.js';
import { withFinalAnswerGuarantee } from '../chat-engine.js';

const mockedCreateModel = vi.mocked(createModelFromConfig);

// ─── Fixtures ────────────────────────────────────────────

const ctx = {
  profile: { model: { provider: 'openai-compatible', model: 'test-model' } },
  systemPrompt: 'You are a helpful assistant.',
  baseMessages: [{ role: 'user', content: 'What is the refund window?' }],
};

const ANSWER = 'Refunds are accepted within 30 days of purchase.';

/** Tool-result messages as they appear in `(await streamResult.response).messages`. */
const toolMessages = [
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolName: 'knowledge_query',
        output: { value: 'Policy doc: refunds accepted within 30 days of purchase.' },
      },
    ],
  },
];

/** Minimal fake of the AI SDK StreamTextResult surface the wrapper touches. */
function fakePrimary(parts: unknown[], responseMessages: unknown[] = toolMessages): any {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    response: Promise.resolve({ messages: responseMessages }),
  };
}

/** Provider-level (V3) chunks for one continuation pass; empty text = empty pass. */
function passChunks(text: string): unknown[] {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  if (!text)
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'finish', finishReason: 'stop', usage },
    ];
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage },
  ];
}

function mockModelWithPasses(...passes: string[]): MockLanguageModelV3 {
  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream(passChunks(passes[Math.min(call++, passes.length - 1)]) as any),
    }),
  });
  mockedCreateModel.mockResolvedValue(model as any);
  return model;
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const part of gen) out.push(part);
  return out;
}

const FINISH = { type: 'finish', finishReason: 'stop', totalUsage: {} };

beforeEach(() => {
  mockedCreateModel.mockReset();
});

// ─── Tests ───────────────────────────────────────────────

describe('withFinalAnswerGuarantee', () => {
  it('passes a stream that produced text through unchanged (finish last, no model call)', async () => {
    const parts = [
      { type: 'text-delta', id: 'a', text: 'Hello' },
      { type: 'tool-result', toolCallId: 'c1', toolName: 'knowledge_query', output: {} },
      FINISH,
    ];
    const out = await collect(withFinalAnswerGuarantee(fakePrimary(parts), ctx));

    expect(out).toEqual(parts);
    expect(mockedCreateModel).not.toHaveBeenCalled();
  });

  it('does not fall back when no tool ran (nothing gathered to answer from)', async () => {
    const out = await collect(withFinalAnswerGuarantee(fakePrimary([FINISH]), ctx));

    expect(out).toEqual([FINISH]);
    expect(mockedCreateModel).not.toHaveBeenCalled();
  });

  it('splices a final answer before finish when tools ran but no text was produced', async () => {
    const model = mockModelWithPasses(ANSWER);
    const parts = [{ type: 'tool-result', toolCallId: 'c1', toolName: 'knowledge_query', output: {} }, FINISH];

    const out = await collect(withFinalAnswerGuarantee(fakePrimary(parts), ctx));

    expect(out[0]).toEqual(parts[0]);
    expect(out[out.length - 1]).toEqual(FINISH);
    const spliced = out.filter((p) => p.type === 'text-delta');
    expect(spliced.length).toBeGreaterThan(0);
    expect(spliced.map((p) => p.text).join('')).toBe(ANSWER);

    // The continuation prompt carries the plain-text digest, the answer-now
    // instruction, and the original conversation — not structured tool history.
    expect(model.doStreamCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).toContain('knowledge_query');
    expect(prompt).toContain('refunds accepted within 30 days');
    expect(prompt).toContain('Tool use is now disabled');
    expect(prompt).toContain('What is the refund window?');
  });

  it('retries an empty continuation pass and splices the retry text exactly once', async () => {
    const model = mockModelWithPasses('', ANSWER);
    const parts = [{ type: 'tool-result', toolCallId: 'c1', toolName: 'knowledge_query', output: {} }, FINISH];

    const out = await collect(withFinalAnswerGuarantee(fakePrimary(parts), ctx));

    expect(model.doStreamCalls).toHaveLength(2);
    expect(
      out
        .filter((p) => p.type === 'text-delta')
        .map((p) => p.text)
        .join(''),
    ).toBe(ANSWER);
    expect(out[out.length - 1]).toEqual(FINISH);
  });

  it('gives up after three failed attempts but still emits finish', async () => {
    mockedCreateModel.mockRejectedValue(new Error('model unavailable'));
    const parts = [{ type: 'tool-result', toolCallId: 'c1', toolName: 'knowledge_query', output: {} }, FINISH];

    const out = await collect(withFinalAnswerGuarantee(fakePrimary(parts), ctx));

    expect(mockedCreateModel).toHaveBeenCalledTimes(3);
    expect(out).toEqual(parts);
  });
});
