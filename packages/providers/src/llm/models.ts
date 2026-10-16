/**
 * Model wrappers shared by every LLM adapter: a hard output cap, a per-attempt hook for
 * budgets and usage, and fallback across instances on retriable errors.
 */

import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Usage } from '@ai-sdk/provider';

/** No attempt may inherit an unbounded vendor default. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 20_000;

export interface AttemptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface AttemptLease {
  /** The request is about to leave; from here the call is billable even if it fails. */
  started(): void;
  settle(usage: AttemptUsage): Promise<void>;
}

/** Called before each real request (every retry and fallback attempt gets its own lease). */
export type AttemptHook = (input: { instanceId: string; modelId: string }) => Promise<AttemptLease | null>;

const usageOf = (usage: LanguageModelV4Usage): AttemptUsage => ({
  inputTokens: usage.inputTokens.total,
  outputTokens: usage.outputTokens.total,
  cachedInputTokens: usage.inputTokens.cacheRead,
  reasoningTokens: usage.outputTokens.reasoning,
});

const bounded = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions =>
  options.maxOutputTokens === undefined ? { ...options, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS } : options;

export function withAttempts(model: LanguageModelV4, instanceId: string, hook?: AttemptHook): LanguageModelV4 {
  const settle = async (lease: AttemptLease | null, usage: LanguageModelV4Usage) => {
    // The answer already exists; a failed settlement must not lose it.
    await lease?.settle(usageOf(usage)).catch(() => undefined);
  };
  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const lease = hook ? await hook({ instanceId, modelId: model.modelId }) : null;
      lease?.started();
      const result = await model.doGenerate(bounded(options));
      await settle(lease, result.usage);
      return result;
    },
    async doStream(options) {
      const lease = hook ? await hook({ instanceId, modelId: model.modelId }) : null;
      lease?.started();
      const result = await model.doStream(bounded(options));
      if (!lease) return result;
      let settled = false;
      const stream = result.stream.pipeThrough(
        new TransformStream({
          async transform(part, controller) {
            if (part.type === 'finish' && !settled) {
              settled = true;
              await settle(lease, part.usage);
            }
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream };
    },
  };
}

const RETRIABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRIABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_SOCKET']);

export function isRetriable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as Error & { statusCode?: number; status?: number; code?: string; cause?: unknown };
  const status = e.statusCode ?? e.status;
  if (typeof status === 'number' && RETRIABLE_STATUS.has(status)) return true;
  if (typeof e.code === 'string' && RETRIABLE_CODES.has(e.code)) return true;
  return e.cause !== undefined && isRetriable(e.cause);
}

/** Tries each model in order; moves on only for 408, 429, 5xx and network errors. */
export function withFallback(models: LanguageModelV4[]): LanguageModelV4 {
  if (models.length === 0) throw new Error('withFallback needs at least one model');
  if (models.length === 1) return models[0]!;
  const primary = models[0]!;
  const attempt = async <T>(run: (model: LanguageModelV4) => PromiseLike<T>): Promise<T> => {
    let last: unknown;
    for (const model of models) {
      try {
        return await run(model);
      } catch (error) {
        last = error;
        if (!isRetriable(error)) throw error;
      }
    }
    throw last;
  };
  return {
    specificationVersion: 'v4',
    provider: `fallback(${models.map((model) => model.provider).join(',')})`,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,
    doGenerate: (options) => attempt((model) => model.doGenerate(options)),
    doStream: (options) => attempt((model) => model.doStream(options)),
  };
}

/**
 * Is this model really DeepSeek, whatever the instance calls itself? The DeepSeek client is
 * what carries its thinking switch to the wire and parses reasoning_content. Vendor-prefixed
 * ids on gateways (deepseek-ai/…) stay on the generic client.
 */
export function isDeepSeekFamily(model: string, baseUrl?: string): boolean {
  if (/^deepseek-[^/]+$/i.test(model)) return true;
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'deepseek.com' || host.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}
