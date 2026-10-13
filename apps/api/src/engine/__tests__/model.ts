/** A scripted model for engine tests: each call plays the next script, streaming or not. */

import { MockLanguageModelV4 } from 'ai/test';
import type { ResolvedModel } from '../../providers/service.js';

type Part = Record<string, unknown> & { type: string };

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export const text = (value: string): Part[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  ...value.split(/(?<= )/).map((delta) => ({ type: 'text-delta', id: 't', delta })),
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
];

export const toolCall = (toolName: string, input: unknown, id = 'call_1'): Part[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
];

/** One step that says something and calls a tool, as models usually do before a hand-off. */
export const textThenTool = (value: string, toolName: string, input: unknown, id = 'call_1'): Part[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: value },
  { type: 'text-end', id: 't' },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
];

export interface Script {
  parts: Part[];
  /** Holds the stream open until released (or aborted). */
  gate?: Promise<void>;
}

export function scriptedModel(scripts: Array<Part[] | Script>, options: { title?: string; summary?: string } = {}) {
  const prompts: unknown[] = [];
  /** The tool names offered on each call. */
  const tools: string[][] = [];
  let index = 0;
  const next = (): Script => {
    const script = scripts[Math.min(index++, scripts.length - 1)]!;
    return Array.isArray(script) ? { parts: script } : script;
  };
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const system = JSON.stringify(call.prompt.filter((message) => message.role === 'system'));
      const fixed = system.includes('Write a title for this conversation')
        ? (options.title ?? 'A title')
        : system.includes('You maintain the rolling summary')
          ? (options.summary ?? '{}')
          : null;
      if (fixed !== null) {
        return {
          content: [{ type: 'text', text: fixed }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }
      // Headless turns (background runs) play the same scripts as streaming ones.
      prompts.push(call.prompt);
      tools.push((call.tools ?? []).map((entry) => entry.name));
      const script = next();
      if (script.gate) {
        await Promise.race([
          script.gate,
          new Promise((_, reject) =>
            call.abortSignal?.addEventListener(
              'abort',
              () => reject(call.abortSignal?.reason ?? new Error('aborted')),
              {
                once: true,
              },
            ),
          ),
        ]);
      }
      const textOut = script.parts
        .filter((part) => part.type === 'text-delta')
        .map((part) => String(part.delta))
        .join('');
      const calls = script.parts.filter((part) => part.type === 'tool-call');
      const finish = script.parts.find((part) => part.type === 'finish') as { finishReason: unknown } | undefined;
      return {
        content: [
          ...(textOut ? [{ type: 'text' as const, text: textOut }] : []),
          ...calls.map((part) => ({
            type: 'tool-call' as const,
            toolCallId: String(part.toolCallId),
            toolName: String(part.toolName),
            input: String(part.input),
          })),
        ],
        finishReason: (finish?.finishReason ?? { unified: 'stop', raw: undefined }) as never,
        usage: USAGE,
        warnings: [],
      };
    },
    doStream: async (call) => {
      prompts.push(call.prompt);
      tools.push((call.tools ?? []).map((entry) => entry.name));
      const script = next();
      return {
        stream: new ReadableStream({
          async start(controller) {
            // Aborted before the call: fail at once, as a real request would.
            if (call.abortSignal?.aborted) return controller.error(call.abortSignal.reason ?? new Error('aborted'));
            call.abortSignal?.addEventListener(
              'abort',
              () => {
                try {
                  controller.error(call.abortSignal?.reason ?? new Error('aborted'));
                } catch {
                  // already closed
                }
              },
              { once: true },
            );
            const [head, ...rest] = script.parts;
            controller.enqueue(head as never);
            if (script.gate) await script.gate;
            if (call.abortSignal?.aborted) return;
            for (const part of rest) controller.enqueue(part as never);
            controller.close();
          },
        }),
      };
    },
  });
  const languageModel = async (): Promise<ResolvedModel> => ({
    model,
    ref: 'test/m',
    modelId: 'm',
    deepseek: false,
  });
  return { languageModel, prompts, tools, calls: () => index };
}

export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** The text of the last user message of a recorded prompt. */
export function lastUserText(prompt: unknown): string {
  const messages = prompt as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  const user = [...messages].reverse().find((message) => message.role === 'user');
  return (user?.content ?? []).map((part) => part.text ?? '').join('');
}

export function systemText(prompt: unknown): string {
  const messages = prompt as Array<{ role: string; content: unknown }>;
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n');
}
