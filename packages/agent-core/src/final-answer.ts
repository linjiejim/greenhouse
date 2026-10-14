/**
 * The DeepSeek final-answer guarantee: a turn that ran tools but produced no text (the model
 * kept searching, or leaked a DSML call on the forced last step) gets one more generation,
 * with tools off, on the conversation plus a plain-text digest of what the tools returned.
 *
 * The evidence is flattened to text on purpose: replaying the tool messages primes the model
 * to keep calling tools, which is the loop being escaped. Thinking is off for speed. Removing
 * the workaround means deleting this file and dsml-interceptor.ts.
 */

import { streamText, type ModelMessage, type SystemModelMessage } from 'ai';
import { logger } from '@greenhouse/utils/logger';
import { guardedModel, LOOP_TIMEOUT, providerOptionsFor, type LoopModel } from './settings.js';
import { applyTimeContext, type EngineMessage, type TimeContextOption } from './time-context.js';

export interface FinalAnswerInput {
  model: LoopModel;
  instructions: string | SystemModelMessage;
  /** The conversation the primary loop ran on. */
  baseMessages: EngineMessage[];
  /** The primary loop's response messages; their tool results become the digest. */
  gatheredMessages: ModelMessage[];
  timeContext?: TimeContextOption;
}

export type FinalAnswerStream = { stream: AsyncIterable<{ type: string; text?: string }> };
export type FinalAnswerStreamFactory = (input: FinalAnswerInput) => Promise<FinalAnswerStream>;

export const FINAL_ANSWER_MAX_ATTEMPTS = 3;

/** Flatten the tool results of a turn into a plain-text digest. */
function digestToolResults(messages: ModelMessage[]): string {
  const MAX_PER_RESULT = 2000;
  const MAX_TOTAL = 16000;
  const blocks: string[] = [];
  for (const message of messages as Array<{ role: string; content: unknown }>) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type?: string; toolName?: string; output?: unknown }>) {
      if (part?.type !== 'tool-result') continue;
      const raw = (part.output as { value?: unknown })?.value ?? part.output;
      let text: string;
      try {
        text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch {
        text = String(raw);
      }
      blocks.push(`### ${part.toolName ?? 'tool'}\n${text.slice(0, MAX_PER_RESULT)}`);
    }
  }
  return blocks.join('\n\n').slice(0, MAX_TOTAL);
}

async function finalAnswerStream(input: FinalAnswerInput): Promise<FinalAnswerStream> {
  const digest = digestToolResults(input.gatheredMessages);
  const providerOptions = providerOptionsFor(input.model, false);
  return streamText({
    model: guardedModel(input.model),
    instructions: input.instructions,
    messages: [
      ...applyTimeContext(input.baseMessages, input.timeContext),
      {
        role: 'user',
        content:
          `[Information already gathered:]\n\n${digest || '(no results)'}\n\n` +
          '[Tool use is now disabled. Using only the information above, answer my most recent message in plain text. ' +
          'If the information is insufficient, say so briefly. Do not call any tools.]',
      },
    ],
    tools: {},
    toolChoice: 'none',
    timeout: LOOP_TIMEOUT,
    ...(providerOptions ? { providerOptions } : {}),
  });
}

/**
 * One final-answer pass as text-delta parts, retried while a pass yields nothing (a pass can
 * come back empty when even this generation leaks DSML). Empty passes yield nothing, so a retry
 * never duplicates text.
 */
export async function* finalAnswerParts(
  input: FinalAnswerInput,
  createStream: FinalAnswerStreamFactory = finalAnswerStream,
  maxAttempts = FINAL_ANSWER_MAX_ATTEMPTS,
): AsyncGenerator<{ type: 'text-delta'; text: string }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let produced = '';
    try {
      const { stream } = await createStream(input);
      for await (const part of stream) {
        if (part.type === 'text-delta' && part.text) {
          produced += part.text;
          yield { type: 'text-delta', text: part.text };
        }
      }
    } catch (error) {
      logger.warn('[agent-loop] final-answer attempt failed', { attempt, error: String(error) });
    }
    if (produced.trim()) return;
  }
}
