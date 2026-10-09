/**
 * A scripted model for Bots engine tests: each Bot (recognised by its name in
 * the system prompt) plays a queue of turns; each turn is a list of steps
 * (text and/or tool calls). Runs the REAL `streamText` loop through
 * MockLanguageModelV3, so tools execute and stop conditions fire.
 *
 * The `streamText` wiring below REPRODUCES the shared loop assembly
 * (`prepareAgentLoop` in packages/agent-core/src/agent-loop.ts) — step cap from `maxStepsOverride`
 * else the profile, extra stop conditions OR-ed with the cap, and on the last
 * step `toolChoice: 'none'` together with the rewritten messages — it does not
 * run it. Keep the two in step; the production wiring has its own test in
 * agent-core.
 */

import { simulateReadableStream, stepCountIs, streamText, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { ChatEngineInput } from '@greenhouse/agent-core';
import type { BotsEngineDeps } from '../deps.js';

export interface ScriptStep {
  text?: string;
  toolCalls?: Array<{ toolName: string; input: Record<string, unknown> }>;
  /** Throw from the provider instead of answering. */
  fail?: string;
}

export type BotScript = Record<string, ScriptStep[][]>;

export interface CapturedTurn {
  bot: string;
  input: ChatEngineInput;
}

let callCounter = 0;

function chunksFor(step: ScriptStep) {
  const chunks: unknown[] = [{ type: 'stream-start', warnings: [] }];
  if (step.text) {
    chunks.push(
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: step.text },
      { type: 'text-end', id: 't' },
    );
  }
  for (const call of step.toolCalls ?? []) {
    callCounter += 1;
    chunks.push({
      type: 'tool-call',
      toolCallId: `call-${callCounter}`,
      toolName: call.toolName,
      input: JSON.stringify(call.input),
    });
  }
  chunks.push({
    type: 'finish',
    finishReason: { unified: step.toolCalls?.length ? 'tool-calls' : 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 1000, noCache: 800, cacheRead: 200, cacheWrite: 0 },
      outputTokens: { total: 50, text: 50, reasoning: 0 },
    },
  });
  return chunks;
}

/** Build engine deps that play `script`; `captured` records every turn's engine input. */
export function scriptedDeps(script: BotScript, captured: CapturedTurn[] = []): Partial<BotsEngineDeps> {
  const queues = new Map(Object.entries(script).map(([bot, turns]) => [bot, [...turns]]));
  return {
    resolveProfile: async () =>
      ({
        id: 'sprouty',
        name: 'Sprouty',
        description: '',
        access: { level: 'internal', rich_output: true },
        model: { id: 'scripted-mock', provider: 'openai-compatible', model: 'scripted-mock' },
        tools: [],
        system_prompt: '',
        max_steps: 30,
        tool_choice: 'auto',
      }) as never,
    createStream: async (input) => {
      const bot = /You are \*\*(.+?)\*\*/.exec(input.systemPrompt)?.[1] ?? '?';
      captured.push({ bot, input });
      const steps = queues.get(bot)?.shift() ?? [{ text: `(${bot} has no script)` }];
      let index = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => {
          const step = steps[Math.min(index, steps.length - 1)]!;
          index += 1;
          if (step.fail) throw new Error(step.fail);
          return { stream: simulateReadableStream({ chunks: chunksFor(step) as never[] }) };
        },
      });
      // The scripted profile's max_steps (30), as production falls back to it.
      const maxSteps = input.maxStepsOverride ?? 30;
      const streamResult = streamText({
        model,
        system: input.systemPrompt,
        messages: input.messages as never,
        tools: input.tools as ToolSet,
        stopWhen: [stepCountIs(maxSteps), ...(input.extraStopWhen ?? [])],
        maxRetries: 0,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        prepareStep: ({ stepNumber, messages }) => {
          const rewritten = input.prepareStepMessages?.({ stepNumber, messages });
          if (stepNumber === maxSteps - 1)
            return { toolChoice: 'none' as const, ...(rewritten ? { messages: rewritten } : {}) };
          return rewritten ? { messages: rewritten } : {};
        },
      });
      return {
        streamResult: streamResult as never,
        dsmlRecoveries: [],
        startTime: Date.now(),
        modelId: 'scripted-mock',
      };
    },
  };
}
