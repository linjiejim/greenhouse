/**
 * The headless host of the shared loop assembly — runAgentLoop() drives the
 * REAL generateText loop (through MockLanguageModelV3) on the same settings
 * chat streams with. These pin the safeguards the headless path used to lack:
 * tool-call JSON repair, catalog sampling options, time context (with the
 * scheduler's opt-out) and the DeepSeek final-answer guarantee.
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  deepseek: false,
  options: {} as Record<string, unknown>,
  model: null as unknown,
}));

vi.mock('../model.js', () => ({
  createModelFromConfig: async () => state.model,
  buildProviderOptions: () => undefined,
  applyModelOverride: (config: unknown) => config,
  // Stand-in for the catalog: fold `state.options` under the profile's own.
  resolveModelConfig: (config: { options?: Record<string, unknown> }) => ({
    ...config,
    options: { ...state.options, ...config.options },
  }),
  resolvesToDeepSeek: () => state.deepseek,
}));

import { prepareAgentLoop, runAgentLoop, type AgentLoopInput } from '../agent-loop.js';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;

const USAGE = {
  inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function step(content: GenerateResult['content'], finish: 'stop' | 'tool-calls'): GenerateResult {
  return { content, finishReason: { unified: finish, raw: undefined }, usage: USAGE, warnings: [] } as GenerateResult;
}

/** A model that plays `steps` in order (the last one repeats). */
function scripted(steps: GenerateResult[]) {
  const calls: Array<Parameters<MockLanguageModelV3['doGenerate']>[0]> = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options);
      const next = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      return next;
    },
  });
  return { model, calls };
}

function lookupTool(seen: unknown[]): ToolSet {
  return {
    lookup: tool({
      description: 'look a fact up',
      inputSchema: jsonSchema<{ query: string }>({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async (input) => {
        seen.push(input);
        return { fact: `answer for ${input.query}` };
      },
    }),
  };
}

function input(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    profile: { model: { provider: 'openai', model: 'fake' }, max_steps: 4 },
    messages: [{ role: 'user', content: 'what is the fact?' }],
    tools: {},
    systemPrompt: 'system',
    ...overrides,
  };
}

function lastUserText(prompt: Array<{ role: string; content: unknown }>): string {
  const user = [...prompt].reverse().find((m) => m.role === 'user')!;
  const parts = user.content as Array<{ type: string; text?: string }>;
  return parts.map((p) => p.text ?? '').join('');
}

beforeEach(() => {
  state.deepseek = false;
  state.options = {};
  state.model = null;
});

describe('runAgentLoop — the headless host of the shared assembly', () => {
  it('repairs malformed tool-call JSON instead of dropping the call (chat already did)', async () => {
    const seen: unknown[] = [];
    const { model } = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"alpha",}' }], 'tool-calls'),
      step([{ type: 'text', text: 'done' }], 'stop'),
    ]);
    state.model = model;

    const result = await runAgentLoop(input({ tools: lookupTool(seen) }));

    expect(seen).toEqual([{ query: 'alpha' }]);
    expect(result.text).toBe('done');
    expect(result.steps).toHaveLength(2);
  });

  it('stamps the current time on the last user message, and leaves it alone when the host opts out', async () => {
    const stamped = scripted([step([{ type: 'text', text: 'ok' }], 'stop')]);
    state.model = stamped.model;
    await runAgentLoop(input());
    expect(lastUserText(stamped.calls[0]!.prompt as never)).toMatch(
      /^\[Current Time: \d{4}-\d{2}-\d{2} \w+ \d{2}:\d{2}\] /,
    );

    const plain = scripted([step([{ type: 'text', text: 'ok' }], 'stop')]);
    state.model = plain.model;
    await runAgentLoop(input({ timeContext: false }));
    expect(lastUserText(plain.calls[0]!.prompt as never)).toBe('what is the fact?');
  });

  it('runs on the catalog sampling options the headless path used to skip', async () => {
    const { model, calls } = scripted([step([{ type: 'text', text: 'ok' }], 'stop')]);
    state.model = model;
    state.options = { temperature: 0.3, max_tokens: 1234 };

    await runAgentLoop(input());

    expect(calls[0]!.temperature).toBe(0.3);
    expect(calls[0]!.maxOutputTokens).toBe(1234);
  });

  it('forces a text-only last step', async () => {
    const seen: unknown[] = [];
    const { model, calls } = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"a"}' }], 'tool-calls'),
    ]);
    state.model = model;

    await runAgentLoop(input({ tools: lookupTool(seen), maxStepsOverride: 2 }));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.toolChoice).toEqual({ type: 'auto' });
    expect(calls[1]!.toolChoice).toEqual({ type: 'none' });
  });

  it('DeepSeek: tools ran but no text came back → the final-answer fallback answers, and its usage counts', async () => {
    state.deepseek = true;
    const seen: unknown[] = [];
    const { model } = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"beta"}' }], 'tool-calls'),
      step([], 'stop'),
    ]);
    state.model = model;
    const factoryInputs: unknown[] = [];

    const result = await runAgentLoop(input({ tools: lookupTool(seen) }), {
      finalAnswerStreamFactory: async (fallbackInput) => {
        factoryInputs.push(fallbackInput);
        return {
          fullStream: (async function* () {
            yield { type: 'text-delta', text: 'Recovered answer' };
          })(),
          totalUsage: Promise.resolve({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 0 }),
        } as never;
      },
    });

    expect(result.text).toBe('Recovered answer');
    expect(result.finalAnswerRecovered).toBe(true);
    // Two primary steps (100 + 100 in, 10 + 10 out) plus the fallback pass.
    expect(result.usage.inputTokens).toBe(207);
    expect(result.usage.outputTokens).toBe(23);
    // The fallback digests what the loop actually gathered.
    const gathered = (factoryInputs[0] as { gatheredMessages: Array<{ role: string }> }).gatheredMessages;
    expect(gathered.some((m) => m.role === 'tool')).toBe(true);
  });

  it('non-DeepSeek models never enter the fallback', async () => {
    const seen: unknown[] = [];
    const { model } = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"beta"}' }], 'tool-calls'),
      step([], 'stop'),
    ]);
    state.model = model;
    const factory = vi.fn();

    const result = await runAgentLoop(input({ tools: lookupTool(seen) }), { finalAnswerStreamFactory: factory });

    expect(factory).not.toHaveBeenCalled();
    expect(result.text).toBe('');
    expect(result.finalAnswerRecovered).toBe(false);
  });
});

describe('prepareAgentLoop — one assembly for both hosts', () => {
  it('wraps DeepSeek models with the DSML interceptor and leaves others untouched', async () => {
    const { model } = scripted([step([{ type: 'text', text: 'ok' }], 'stop')]);
    state.model = model;

    const plain = await prepareAgentLoop(input());
    expect(plain.settings.model).toBe(model);

    state.deepseek = true;
    const wrapped = await prepareAgentLoop(input());
    expect(wrapped.settings.model).not.toBe(model);
  });

  it('a provider-options override replaces the derived ones (the runner seam), otherwise none are sent', async () => {
    state.model = scripted([step([{ type: 'text', text: 'ok' }], 'stop')]).model;
    expect((await prepareAgentLoop(input())).settings.providerOptions).toBeUndefined();
    const override = { deepseek: { thinking: { type: 'disabled' } } };
    expect((await prepareAgentLoop(input({ providerOptionsOverride: override }))).settings.providerOptions).toBe(
      override,
    );
  });
});
