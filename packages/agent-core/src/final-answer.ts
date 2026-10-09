/**
 * Final-answer guarantee — the DeepSeek-only "never end a turn with no answer"
 * fallback, shared by the streaming host (withFinalAnswerGuarantee in
 * chat-engine.ts) and the headless one (runAgentLoop in agent-loop.ts).
 *
 * The agent loop occasionally exhausts `max_steps` calling tools without ever
 * emitting an assistant answer (the model keeps searching, or leaks a DSML tool
 * call on the forced final step). When a host detects that (no text produced
 * but tools did run), it runs ONE more generation — the original conversation
 * plus a PLAIN-TEXT digest of the tool results already gathered, tools disabled
 * — so the consumer never gets an empty assistant turn.
 *
 * The gathered evidence is flattened to plain text rather than replayed as
 * structured tool-call/tool-result messages on purpose: replaying that history
 * primes the model to keep calling tools (and leak DSML), which is exactly the
 * loop we're escaping. Thinking is disabled for speed; `toolChoice: 'none'`
 * keeps the DSML interceptor from recovering any residual leak.
 *
 * Everything here is gated on `resolvesToDeepSeek`, so the whole workaround is
 * removable in one place once DeepSeek fixes their parser: delete
 * dsml-interceptor.ts + this file, then revert each host's one-line swap.
 */

import { streamText, wrapLanguageModel } from 'ai';
import type { StreamTextResult, ToolSet, ModelMessage } from 'ai';
import { createDsmlInterceptor } from './dsml-interceptor.js';
import {
  createModelFromConfig,
  buildProviderOptions,
  resolveModelConfig,
  resolvesToDeepSeek,
  type ModelConfig,
  type ProviderAttemptHook,
} from './model.js';
import { applyTimeContext, CHAT_STREAM_TIMEOUT, type EngineProfile, type TimeContextOption } from './loop-shared.js';
import type { EngineMessage } from './time-context.js';
import { logger } from '@greenhouse/utils/logger';

export interface FinalAnswerInput {
  profile: EngineProfile;
  systemPrompt: string;
  /** The original conversation the primary loop ran on. */
  baseMessages: EngineMessage[];
  /** The primary loop's response messages — its tool results become the digest. */
  gatheredMessages: ModelMessage[];
  providerAttemptHook?: ProviderAttemptHook;
  /** Same time-context choice as the primary loop (see AgentLoopInput.timeContext). */
  timeContext?: TimeContextOption;
}

export type FinalAnswerStreamFactory = (input: FinalAnswerInput) => Promise<StreamTextResult<ToolSet, never>>;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
}

export function addUsage(target: UsageTotals, usage: unknown): void {
  if (!usage || typeof usage !== 'object') return;
  const value = usage as Record<string, unknown>;
  const add = (key: keyof UsageTotals) => {
    const amount = value[key];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) target[key] += amount;
  };
  add('inputTokens');
  add('outputTokens');
  add('cachedInputTokens');
  add('reasoningTokens');
}

/** Flatten the prior turn's tool-result messages into a plain-text evidence digest. */
function digestToolResults(priorTurn: ModelMessage[]): string {
  const MAX_PER_RESULT = 2000;
  const MAX_TOTAL = 16000;
  const blocks: string[] = [];
  for (const m of priorTurn as Array<{ role: string; content: unknown }>) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type?: string; toolName?: string; output?: unknown }>) {
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

async function createFinalAnswerStreamAsync(input: FinalAnswerInput): Promise<StreamTextResult<ToolSet, never>> {
  const { profile, systemPrompt, baseMessages, gatheredMessages, providerAttemptHook } = input;

  const modelConfig = resolveModelConfig({
    ...profile.model,
    options: { ...profile.model.options, thinking: false },
  });
  const rawModel = await createModelFromConfig(
    modelConfig,
    providerAttemptHook ? { onProviderAttempt: providerAttemptHook } : {},
  );
  const model = resolvesToDeepSeek(modelConfig)
    ? wrapLanguageModel({
        model: rawModel as Parameters<typeof wrapLanguageModel>[0]['model'],
        middleware: createDsmlInterceptor(),
      })
    : rawModel;

  const digest = digestToolResults(gatheredMessages);
  const messages: ModelMessage[] = [
    ...applyTimeContext(baseMessages, input.timeContext),
    {
      role: 'user',
      content:
        `[Information already gathered from the knowledge base:]\n\n${digest || '(no results)'}\n\n` +
        `[Tool use is now disabled. Using only the information above, answer my most recent question in plain text. ` +
        `If the information is insufficient, say so briefly. Do not call any tools.]`,
    },
  ];

  const providerOptions = buildProviderOptions(modelConfig);
  const maxOutputTokens = modelConfig.options?.max_tokens;

  return streamText({
    model,
    system: systemPrompt,
    messages,
    tools: {},
    toolChoice: 'none',
    timeout: CHAT_STREAM_TIMEOUT,
    ...(providerOptions ? { providerOptions } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  });
}

export const FINAL_ANSWER_MAX_ATTEMPTS = 3;

/**
 * One final-answer pass, emitted as synthetic fullStream `text-delta` parts and
 * retried up to `maxAttempts` if a pass yields nothing. A pass can come back
 * empty when the model leaks DSML even here (the interceptor strips it); leaks
 * are intermittent per generation so a retry almost always lands a clean answer.
 * Empty passes yield nothing, so retrying never duplicates content.
 */
export async function* finalAnswerParts(
  input: FinalAnswerInput,
  onUsage: (usage: unknown) => void,
  maxAttempts = FINAL_ANSWER_MAX_ATTEMPTS,
  createStream: FinalAnswerStreamFactory = createFinalAnswerStreamAsync,
): AsyncGenerator<{ type: 'text-delta'; text: string }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let produced = '';
    let fallbackStream: StreamTextResult<ToolSet, never> | undefined;
    try {
      fallbackStream = await createStream(input);
      for await (const part of fallbackStream.fullStream) {
        if (part.type === 'text-delta' && part.text) {
          produced += part.text;
          yield { type: 'text-delta', text: part.text };
        }
      }
    } catch (err) {
      logger.warn('[agent-loop] final-answer attempt failed', { attempt, err: String(err) });
    } finally {
      if (fallbackStream) {
        const usage = await Promise.resolve(fallbackStream.totalUsage).catch(() => null);
        onUsage(usage);
      }
    }
    if (produced.trim()) return;
  }
}

/** Whether this model can enter the DeepSeek-only fallback path. */
export function requiresFinalAnswerGuarantee(modelConfig: ModelConfig): boolean {
  return resolvesToDeepSeek(modelConfig);
}
