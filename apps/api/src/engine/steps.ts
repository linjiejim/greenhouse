/**
 * Model steps: what each step of a run added to the model's context (its message, then the
 * results of the tools it called), recorded as a `run_steps` row of kind `model` as the step
 * ends. A retried background run continues from them instead of starting over, and a turn will
 * resume the same way (M3.6). A step keeps about 20 000 characters, like the other step rows:
 * long tool results are cut first, then long texts; the structure always stays whole.
 */

import type { ModelMessage } from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import type { LoopStepEnd } from '@greenhouse/agent-core';
import { getDb, newId, runSteps } from '@greenhouse/db';
import { callKey } from './tools/assemble.js';

export const MAX_STEP_CHARS = 20_000;
/** A cut piece keeps at least this much. */
const MIN_PIECE_CHARS = 500;

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n…[cut: ${text.length - max} more characters]`;

type Part = Record<string, unknown> & { type: string };

/** The text of a tool result as the model read it. */
function outputText(output: Record<string, unknown>): string {
  return typeof output.value === 'string' ? output.value : JSON.stringify(output.value ?? null);
}

/** The step's messages within MAX_STEP_CHARS, cutting the longest pieces: tool results, then texts. */
export function boundedMessages(messages: ModelMessage[], max = MAX_STEP_CHARS): ModelMessage[] {
  const size = (value: unknown) => JSON.stringify(value).length;
  const total = size(messages);
  if (total <= max) return messages;
  const parts = messages.flatMap((message) => (Array.isArray(message.content) ? (message.content as Part[]) : []));
  const results = parts.filter((part) => part.type === 'tool-result');
  const texts = parts.filter((part) => part.type === 'text');
  const resultsSize = results.reduce((sum, part) => sum + outputText(part.output as Record<string, unknown>).length, 0);
  const textsSize = texts.reduce((sum, part) => sum + String(part.text).length, 0);
  // What the tool results may keep after everything else, shared equally.
  const resultShare = results.length
    ? Math.max(MIN_PIECE_CHARS, Math.floor((max - (total - resultsSize)) / results.length))
    : 0;
  const keptResults = results.reduce(
    (sum, part) => sum + Math.min(resultShare, outputText(part.output as Record<string, unknown>).length),
    0,
  );
  const textShare = texts.length
    ? Math.max(MIN_PIECE_CHARS, Math.floor((max - (total - resultsSize - textsSize) - keptResults) / texts.length))
    : 0;
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = (message.content as Part[]).map((part) => {
      if (part.type === 'tool-result') {
        const output = part.output as Record<string, unknown>;
        const text = outputText(output);
        if (text.length <= resultShare) return part;
        const errored = output.type === 'error-text' || output.type === 'error-json';
        return { ...part, output: { type: errored ? 'error-text' : 'text', value: cut(text, resultShare) } };
      }
      if (part.type === 'text' && String(part.text).length > textShare) {
        return { ...part, text: cut(String(part.text), textShare) };
      }
      return part;
    });
    return { ...message, content } as ModelMessage;
  });
}

/** Records one finished step of a run; `index` counts the run's steps across its attempts, from 1. */
export async function recordModelStep(input: {
  runId: string;
  attempt: number;
  index: number;
  step: LoopStepEnd;
}): Promise<void> {
  const { step } = input;
  await getDb()
    .insert(runSteps)
    .values({
      id: newId('runStep'),
      runId: input.runId,
      key: `model:${input.index}`,
      attempt: input.attempt,
      kind: 'model',
      status: 'succeeded',
      input: { step: input.index, tools: step.toolNames },
      output: { messages: boundedMessages(step.messages) },
      tokens: {
        input: step.usage.inputTokens ?? 0,
        output: step.usage.outputTokens ?? 0,
        cached: step.usage.cachedInputTokens ?? 0,
      },
      startedAt: sql`now()`,
      finishedAt: sql`now()`,
    })
    .onConflictDoNothing();
}

/**
 * The messages of every step a run recorded, in order: what a retry continues from. `last` is the
 * highest step number; the next attempt numbers its steps after it (a step whose record failed
 * leaves a gap, never a clash).
 */
export async function recordedSteps(runId: string): Promise<{ steps: ModelMessage[][]; last: number }> {
  const step = sql<number>`(${runSteps.input}->>'step')::int`;
  const rows = await getDb()
    .select({ step, output: runSteps.output })
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), eq(runSteps.kind, 'model')))
    .orderBy(step, runSteps.attempt);
  const calls = await getDb()
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), eq(runSteps.kind, 'tool')));
  const results = new Map(calls.filter((call) => call.idempotencyKey).map((call) => [call.idempotencyKey!, call]));
  const refresh = (messages: ModelMessage[]): ModelMessage[] => {
    const byId = new Map<string, (typeof calls)[number]>();
    for (const message of messages)
      if (Array.isArray(message.content))
        for (const part of message.content) {
          if (part.type === 'tool-call') {
            const call = results.get(callKey(part.toolName, part.input));
            if (call) byId.set(part.toolCallId, call);
          }
        }
    return messages.map((message) =>
      !Array.isArray(message.content)
        ? message
        : ({
            ...message,
            content: message.content.map((part) => {
              if (part.type !== 'tool-result') return part;
              const call = byId.get(part.toolCallId);
              if (!call?.requestId || !['succeeded', 'failed', 'skipped', 'uncertain'].includes(call.status))
                return part;
              return {
                ...part,
                output: {
                  type: 'json',
                  value:
                    call.status === 'succeeded'
                      ? call.output
                      : {
                          status: call.status,
                          error: call.error,
                          note: 'The member decided this call. Do not repeat a declined action.',
                        },
                },
              };
            }),
          } as ModelMessage),
    );
  };
  return {
    steps: rows.map((row) =>
      refresh(((row.output as { messages?: ModelMessage[] } | null)?.messages ?? []) as ModelMessage[]),
    ),
    last: rows.reduce((highest, row) => Math.max(highest, Number(row.step)), 0),
  };
}

/** The answer a run already wrote, when its last recorded step was that answer (no tool calls). */
export function finalAnswer(steps: ModelMessage[][]): string | null {
  const last = steps[steps.length - 1];
  if (last?.length !== 1 || last[0]!.role !== 'assistant') return null;
  const content = last[0]!.content;
  if (typeof content === 'string') return content;
  if (content.some((part) => part.type === 'tool-call')) return null;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('');
}
