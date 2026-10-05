/**
 * The per-turn step hooks a host (the Bots engine) passes to the chat engine:
 * a step cap that beats the profile's, extra stop conditions OR-ed with it,
 * and a per-step message rewrite that never removes the engine's own forced
 * final answer (`toolChoice: 'none'` on the last step).
 */

import type { ModelMessage, StopCondition, ToolSet } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PrepareStep = (args: { stepNumber: number; messages: ModelMessage[] }) => Record<string, unknown>;
interface CapturedArgs {
  stopWhen: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  prepareStep: PrepareStep;
  toolChoice: unknown;
}

const mocks = vi.hoisted(() => ({
  streamText: vi.fn((_args: unknown) => ({ marker: 'stream-result' })),
  createModel: vi.fn(async () => ({ modelId: 'fake-model' })),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: mocks.streamText };
});

vi.mock('../model.js', () => ({
  createModelFromConfig: mocks.createModel,
  buildProviderOptions: () => undefined,
  applyModelOverride: (config: unknown) => config,
  resolveModelConfig: (config: unknown) => config,
  resolvesToDeepSeek: () => false,
}));

import { createChatStreamAsync, type ChatEngineInput } from '../chat-engine.js';

const history: ModelMessage[] = [{ role: 'user', content: 'look it up' }];

async function start(overrides: Partial<ChatEngineInput> = {}): Promise<CapturedArgs> {
  await createChatStreamAsync({
    profile: { model: { provider: 'openai', model: 'fake-model' }, max_steps: 12, tool_choice: 'auto' },
    messages: [{ role: 'user', content: 'look it up' }],
    tools: {},
    systemPrompt: 'test',
    ...overrides,
  });
  return mocks.streamText.mock.calls.at(-1)![0] as unknown as CapturedArgs;
}

/** AI SDK semantics: an array of stop conditions stops when ANY is met. */
async function stopsAfter(args: CapturedArgs, stepCount: number): Promise<boolean> {
  const conditions = Array.isArray(args.stopWhen) ? args.stopWhen : [args.stopWhen];
  const steps = Array.from({ length: stepCount }, () => ({})) as never;
  const results = await Promise.all(conditions.map((condition) => condition({ steps })));
  return results.some(Boolean);
}

beforeEach(() => {
  mocks.streamText.mockClear();
});

describe('chat engine step hooks', () => {
  it('maxStepsOverride beats the profile max_steps for the cap and the forced final step', async () => {
    const args = await start({ maxStepsOverride: 3 });
    expect(await stopsAfter(args, 2)).toBe(false);
    expect(await stopsAfter(args, 3)).toBe(true);
    expect(args.prepareStep({ stepNumber: 2, messages: history })).toEqual({ toolChoice: 'none' });
    // The profile's own last step (11) is an ordinary step now.
    expect(args.prepareStep({ stepNumber: 11, messages: history })).toEqual({});
  });

  it('without an override the profile max_steps still applies', async () => {
    const args = await start();
    expect(await stopsAfter(args, 11)).toBe(false);
    expect(await stopsAfter(args, 12)).toBe(true);
    expect(args.prepareStep({ stepNumber: 11, messages: history })).toEqual({ toolChoice: 'none' });
  });

  it('the last step keeps toolChoice none alongside the prepareStepMessages rewrite', async () => {
    const rewritten: ModelMessage[] = [{ role: 'user', content: 'stubbed' }];
    const hook = vi.fn(() => rewritten);
    const args = await start({ maxStepsOverride: 4, prepareStepMessages: hook });
    expect(args.prepareStep({ stepNumber: 1, messages: history })).toEqual({ messages: rewritten });
    expect(args.prepareStep({ stepNumber: 3, messages: history })).toEqual({
      toolChoice: 'none',
      messages: rewritten,
    });
    expect(hook).toHaveBeenCalledWith({ stepNumber: 3, messages: history });
  });

  it('a hook returning undefined leaves the prompt unchanged', async () => {
    const hook = vi.fn(() => undefined);
    const args = await start({ maxStepsOverride: 4, prepareStepMessages: hook });
    const mid = args.prepareStep({ stepNumber: 1, messages: history });
    expect(mid).toEqual({});
    expect(mid).not.toHaveProperty('messages');
    const last = args.prepareStep({ stepNumber: 3, messages: history });
    expect(last).toEqual({ toolChoice: 'none' });
    expect(last).not.toHaveProperty('messages');
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('extraStopWhen is OR-ed with the step cap', async () => {
    let handedOff = false;
    const args = await start({ maxStepsOverride: 5, extraStopWhen: [() => handedOff] });
    expect(Array.isArray(args.stopWhen)).toBe(true);
    expect(await stopsAfter(args, 1)).toBe(false);
    handedOff = true;
    expect(await stopsAfter(args, 1)).toBe(true);
    handedOff = false;
    // The cap still ends the turn when the extra condition never fires.
    expect(await stopsAfter(args, 5)).toBe(true);
  });

  it('an empty extraStopWhen leaves the plain step cap', async () => {
    const args = await start({ maxStepsOverride: 2, extraStopWhen: [] });
    expect(Array.isArray(args.stopWhen)).toBe(false);
    expect(await stopsAfter(args, 2)).toBe(true);
  });
});
