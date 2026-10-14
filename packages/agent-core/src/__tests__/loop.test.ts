/**
 * The loop on a real AI SDK call (MockLanguageModelV4): the safeguards every turn gets,
 * streaming or headless.
 */

import { jsonSchema, tool, type ModelMessage, type StopCondition, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { collect, createCollector } from '../collect.js';
import { prepareLoop, runLoop, streamLoop, withFinalAnswer, type LoopInput, type LoopStepEnd } from '../loop.js';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type StreamPart = { type: string; [key: string]: unknown };

const USAGE = {
  inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function step(content: GenerateResult['content'], finish: 'stop' | 'tool-calls'): GenerateResult {
  return { content, finishReason: { unified: finish, raw: undefined }, usage: USAGE, warnings: [] } as GenerateResult;
}

/** A model that plays `steps` in order (the last one repeats). */
function scripted(steps: GenerateResult[]) {
  const calls: Array<Parameters<MockLanguageModelV4['doGenerate']>[0]> = [];
  let index = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      return steps[Math.min(index++, steps.length - 1)]!;
    },
  });
  return { model, calls };
}

/** A streaming model that plays one step per call. */
function streaming(stepsParts: StreamPart[][]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const parts = stepsParts[Math.min(index++, stepsParts.length - 1)]!;
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part as never);
            controller.close();
          },
        }),
      };
    },
  });
}

const finishPart = (reason: 'stop' | 'tool-calls') => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage: USAGE,
});

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

function input(model: unknown, overrides: Partial<LoopInput> = {}): LoopInput {
  return {
    model: { model: model as never, modelId: 'fake' },
    instructions: 'system',
    messages: [{ role: 'user', content: 'what is the fact?' }],
    maxSteps: 4,
    ...overrides,
  };
}

function lastUserText(prompt: Array<{ role: string; content: unknown }>): string {
  const user = [...prompt].reverse().find((m) => m.role === 'user')!;
  return (user.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('');
}

describe('runLoop', () => {
  it('repairs malformed tool-call JSON instead of dropping the call', async () => {
    const seen: unknown[] = [];
    const { model } = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"alpha",}' }], 'tool-calls'),
      step([{ type: 'text', text: 'done' }], 'stop'),
    ]);
    const result = await runLoop(input(model, { tools: lookupTool(seen) }));
    expect(seen).toEqual([{ query: 'alpha' }]);
    expect(result.text).toBe('done');
  });

  it('stamps the time on the last user message unless the host opts out', async () => {
    const stamped = scripted([step([{ type: 'text', text: 'ok' }], 'stop')]);
    await runLoop(input(stamped.model));
    expect(lastUserText(stamped.calls[0]!.prompt as never)).toMatch(
      /^\[Current Time: \d{4}-\d{2}-\d{2} \w+ \d{2}:\d{2}\] /,
    );
    const plain = scripted([step([{ type: 'text', text: 'ok' }], 'stop')]);
    await runLoop(input(plain.model, { timeContext: false }));
    expect(lastUserText(plain.calls[0]!.prompt as never)).toBe('what is the fact?');
  });

  it('forces a text-only last step', async () => {
    const { model, calls } = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"a"}' }], 'tool-calls'),
    ]);
    await runLoop(input(model, { tools: lookupTool([]), maxSteps: 2 }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.toolChoice).toEqual({ type: 'auto' });
    expect(calls[1]!.toolChoice).toEqual({ type: 'none' });
  });

  it('reports each finished step with the tools it ran, what it added and its usage', async () => {
    const { model } = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"a"}' }], 'tool-calls'),
      step([{ type: 'text', text: 'done' }], 'stop'),
    ]);
    const steps: LoopStepEnd[] = [];
    await runLoop(input(model, { tools: lookupTool([]), onStepEnd: (info) => void steps.push(info) }));
    expect(steps.map((info) => [info.stepNumber, info.toolNames])).toEqual([
      [1, ['lookup']],
      [2, []],
    ]);
    expect(steps[0]!.messages.map((message) => message.role)).toEqual(['assistant', 'tool']);
    expect(steps[1]!.messages).toEqual([expect.objectContaining({ role: 'assistant' })]);
    expect(steps[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 20 });
  });

  it('continues from the steps an earlier attempt recorded, as they were', async () => {
    const first = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"a"}' }], 'tool-calls'),
      step([], 'stop'),
    ]);
    const recorded: ModelMessage[] = [];
    await runLoop(
      input(first.model, { tools: lookupTool([]), onStepEnd: (info) => void recorded.push(...info.messages) }),
    );
    const looked: string[] = [];
    const second = scripted([step([{ type: 'text', text: 'Found it.' }], 'stop')]);
    const result = await runLoop(input(second.model, { tools: lookupTool(looked), resume: recorded }));
    expect(result.text).toBe('Found it.');
    expect(looked).toEqual([]);
    expect(second.calls[0]!.prompt.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });

  it('DeepSeek: tools ran but no text came back, so the final-answer pass answers', async () => {
    const { model } = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"beta"}' }], 'tool-calls'),
      step([], 'stop'),
    ]);
    const inputs: unknown[] = [];
    const result = await runLoop(
      input(model, { tools: lookupTool([]), model: { model, modelId: 'deepseek-chat', deepseek: true } }),
      {
        finalAnswerStream: async (fallback) => {
          inputs.push(fallback);
          return {
            stream: (async function* () {
              yield { type: 'text-delta', text: 'Recovered answer' };
            })(),
          };
        },
      },
    );
    expect(result.text).toBe('Recovered answer');
    expect(result.finalAnswerRecovered).toBe(true);
    const gathered = (inputs[0] as { gatheredMessages: Array<{ role: string }> }).gatheredMessages;
    expect(gathered.some((m) => m.role === 'tool')).toBe(true);
  });

  it('other models never enter the final-answer pass', async () => {
    const { model } = scripted([
      step([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"beta"}' }], 'tool-calls'),
      step([], 'stop'),
    ]);
    const factory = vi.fn();
    const result = await runLoop(input(model, { tools: lookupTool([]) }), { finalAnswerStream: factory });
    expect(factory).not.toHaveBeenCalled();
    expect(result.finalAnswerRecovered).toBe(false);
  });
});

describe('prepareLoop', () => {
  const history: ModelMessage[] = [{ role: 'user', content: 'look it up' }];
  const stopsAfter = async (stopWhen: unknown, count: number) => {
    const conditions = (Array.isArray(stopWhen) ? stopWhen : [stopWhen]) as StopCondition<ToolSet>[];
    const steps = Array.from({ length: count }, () => ({})) as never;
    return (await Promise.all(conditions.map((condition) => condition({ steps })))).some(Boolean);
  };

  it('wraps DeepSeek with the DSML interceptor and sets its thinking switch; others are untouched', () => {
    const { model } = scripted([step([{ type: 'text', text: 'ok' }], 'stop')]);
    const plain = prepareLoop(input(model));
    expect(plain.settings.model).toBe(model);
    expect(plain.settings.providerOptions).toBeUndefined();
    const deepseek = prepareLoop(
      input(model, { model: { model, modelId: 'deepseek-chat', deepseek: true, thinking: false } }),
    );
    expect(deepseek.settings.model).not.toBe(model);
    expect(deepseek.settings.providerOptions).toEqual({ deepseek: { thinking: { type: 'disabled' } } });
  });

  it('caps the steps, keeps the text-only last step with a message rewrite, and ORs extra stop conditions', async () => {
    const rewritten: ModelMessage[] = [{ role: 'user', content: 'stubbed' }];
    let handedOff = false;
    const { settings } = prepareLoop(
      input(null, { maxSteps: 4, prepareStepMessages: () => rewritten, stopWhen: [() => handedOff] }),
    );
    const prepare = settings.prepareStep as (args: { stepNumber: number; messages: ModelMessage[] }) => unknown;
    expect(prepare({ stepNumber: 1, messages: history })).toEqual({ messages: rewritten });
    expect(prepare({ stepNumber: 3, messages: history })).toEqual({ toolChoice: 'none', messages: rewritten });
    expect(await stopsAfter(settings.stopWhen, 1)).toBe(false);
    handedOff = true;
    expect(await stopsAfter(settings.stopWhen, 1)).toBe(true);
    handedOff = false;
    expect(await stopsAfter(settings.stopWhen, 4)).toBe(true);
  });
});

describe('streamLoop', () => {
  it('collects text, tool calls with timing, and the finish', async () => {
    const model = streaming([
      [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"a"}' },
        finishPart('tool-calls'),
      ],
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'The fact ' },
        { type: 'text-delta', id: 't1', delta: 'is known.' },
        { type: 'text-end', id: 't1' },
        finishPart('stop'),
      ],
    ]);
    const turn = input(model, { tools: lookupTool([]) });
    const { result } = streamLoop(turn);
    const collector = createCollector();
    for await (const part of withFinalAnswer(result, turn)) collect(part, collector);
    expect(collector.text).toBe('The fact is known.');
    expect(collector.calls).toEqual([
      expect.objectContaining({
        tool: 'lookup',
        input: { query: 'a' },
        status: 'done',
        output: { fact: 'answer for a' },
      }),
    ]);
    expect(collector.finished).toBe(true);
  });

  it('DeepSeek: splices a final answer into a stream that ran tools but wrote nothing', async () => {
    const model = streaming([
      [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"a"}' },
        finishPart('tool-calls'),
      ],
      [{ type: 'stream-start', warnings: [] }, finishPart('stop')],
    ]);
    const turn = input(model, { tools: lookupTool([]), model: { model, modelId: 'deepseek-chat', deepseek: true } });
    const { result } = streamLoop(turn);
    const collector = createCollector();
    const parts: string[] = [];
    for await (const part of withFinalAnswer(result, turn, async () => ({
      stream: (async function* () {
        yield { type: 'text-delta', text: 'Spliced' };
      })(),
    }))) {
      parts.push(part.type);
      collect(part, collector);
    }
    expect(collector.text).toBe('Spliced');
    // The finish comes after the spliced answer.
    expect(parts.at(-1)).toBe('finish');
  });
  it('DeepSeek: keeps an externally paused step from answering with its old context', async () => {
    const model = streaming([
      [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"query":"a"}' },
        finishPart('tool-calls'),
      ],
    ]);
    const turn = input(model, {
      tools: lookupTool([]),
      model: { model, modelId: 'deepseek-chat', deepseek: true },
      stopWhen: [() => true],
    });
    const { result } = streamLoop(turn);
    const recover = vi.fn(async () => ({
      stream: (async function* () {
        yield { type: 'text-delta', text: 'Old context' };
      })(),
    }));
    let paused = false;
    const collector = createCollector();
    for await (const part of withFinalAnswer(result, turn, recover, () => !paused)) {
      if (part.type === 'finish-step') paused = true;
      collect(part, collector);
    }
    expect(recover).not.toHaveBeenCalled();
    expect(collector.text).toBe('');
    expect(collector.finished).toBe(true);
  });
});
