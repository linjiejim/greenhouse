/**
 * LLM Model Factory — creates language model instances from configuration.
 *
 * Supports DeepSeek, OpenAI, Kimi, and OpenAI-compatible providers
 * via lazy dynamic imports — only the provider SDK actually used gets loaded.
 *
 * Features:
 * - Registry-based model resolution (logical ID → provider chain)
 * - Automatic fallback across providers on retriable errors
 * - Backward-compatible direct provider configuration
 */

import type { LanguageModel } from 'ai';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Usage } from '@ai-sdk/provider';
import { getAvailableProviders, getModelEntry, findModelIdByProviderModel } from './registry.js';
import { logger } from '@greenhouse/utils/logger';

// ─── Model Config Types ──────────────────────────────────
// Owned by the kernel: every host (api profiles, eval, future runtimes)
// describes models with this shape.

export interface ModelOptions {
  thinking?: boolean; // enable reasoning (e.g. DeepSeek thinking mode)
  reasoning_effort?: 'low' | 'high' | 'max'; // reasoning strength for always-thinking models (Kimi K3)
  temperature?: number; // sampling temperature (default: 0.7)
  max_tokens?: number; // max output tokens (default: 4096)
  [key: string]: unknown; // provider-specific options
}

export interface ModelConfig {
  id?: string; // logical model ID from registry (e.g. "flash", "pro") — takes precedence
  provider: string; // "deepseek", "openai", or "openai-compatible"
  model: string; // model ID
  baseUrl?: string; // override base URL (for openai-compatible)
  apiKey?: string; // env var name to read API key from (default: LLM_API_KEY)
  options?: ModelOptions; // model behavior options
}

/**
 * Exact billing identity for one concrete provider attempt.
 *
 * A logical model can fall through several providers. Budgeting at the
 * logical-model boundary therefore cannot protect the credential that really
 * receives the request. The factory wraps every concrete provider model and
 * invokes this hook immediately before each SDK retry/fallback attempt.
 */
export interface ProviderAttemptDescriptor {
  provider: string;
  modelId: string;
  apiKeyEnv: string;
  baseUrl?: string;
  logicalModelId?: string;
  /** Stable hard-budget scope: credential + adapter + endpoint. */
  scopeId: string;
}

export interface ProviderAttemptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ProviderAttemptLease {
  markProviderIoStarted(): void;
  settle(usage: ProviderAttemptUsage): Promise<void>;
}

export type ProviderAttemptHook = (input: {
  descriptor: ProviderAttemptDescriptor;
  /** Full V3 request, including accumulated tool results and schemas. */
  options: LanguageModelV3CallOptions;
}) => Promise<ProviderAttemptLease>;

export interface CreateModelOptions {
  onProviderAttempt?: ProviderAttemptHook;
}

/** No provider attempt is allowed to inherit an unbounded vendor default. */
export const DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS = 20_000;

// ─── Retriable Error Detection ───────────────────────────

const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRIABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_SOCKET']);

function isRetriableError(err: unknown): boolean {
  if (err instanceof Error) {
    const e = err as any;
    const status = e.statusCode ?? e.status ?? e.responseStatusCode;
    if (typeof status === 'number' && RETRIABLE_STATUS_CODES.has(status)) return true;

    const code = e.code;
    if (typeof code === 'string' && RETRIABLE_ERROR_CODES.has(code)) return true;

    if (e.cause && isRetriableError(e.cause)) return true;
  }
  return false;
}

// ─── Kimi (Kimi Code plan) ───────────────────────────────

/**
 * Default upstream for the `kimi` provider — the Kimi Code subscription's
 * OpenAI-compatible surface (the plan's own endpoint, NOT the pay-as-you-go
 * Kimi Open Platform at api.moonshot.ai/v1, which issues different keys).
 * Exported so the relay resolves the same host as the agent runtime.
 */
export const KIMI_DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';

// ─── MiniMax (coding plan) ───────────────────────────────

/**
 * Default upstream for the `minimax` provider — the CN endpoint
 * (`api.minimaxi.com`). Coding-plan keys (`sk-cp-…`) are rejected by the intl
 * host `api.minimax.io` (401 `invalid api key (2049)`, verified live).
 * Exported so the relay resolves the same host as the agent runtime.
 */
export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1';

// ─── Direct Model Creation ───────────────────────────────

/**
 * Create a language model from explicit provider + model configuration.
 */
async function createModelDirect(
  provider: string,
  model: string,
  apiKey: string,
  baseUrl?: string,
): Promise<LanguageModelV3> {
  switch (provider) {
    case 'deepseek': {
      const { createDeepSeek } = await import('@ai-sdk/deepseek');
      const baseURL = baseUrl || process.env.LLM_BASE_URL || 'https://api.deepseek.com';
      return createDeepSeek({ apiKey, baseURL }).chat(model);
    }

    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey, baseURL: baseUrl || undefined }).chat(model);
    }

    case 'kimi': {
      // Kimi speaks OpenAI chat-completions, but K3 always reasons and returns
      // the thinking text in `reasoning_content` — a field @ai-sdk/openai drops
      // on the floor, which would leave the reasoning panel permanently empty.
      // The vendor-neutral @ai-sdk/openai-compatible parses it, sends
      // `max_tokens` (the field Kimi documents) instead of rewriting it to
      // `max_completion_tokens`, and takes `name`, which becomes the
      // providerOptions namespace — so Kimi's knobs travel under `kimi`.
      //
      // Pinned to the 2.x line on purpose: 3.x moved to LanguageModelV4 while
      // this repo's `ai` + provider stack is still V3.
      // `includeUsage` is not optional for us: without it the client never asks
      // for `stream_options.include_usage`, the stream carries no usage chunk,
      // and every streamed answer would be billed as zero tokens against the
      // per-user quotas.
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      const baseURL = baseUrl || process.env.KIMI_BASE_URL || KIMI_DEFAULT_BASE_URL;
      return createOpenAICompatible({ name: 'kimi', apiKey, baseURL, includeUsage: true }).chatModel(model);
    }

    case 'minimax': {
      // Same client choice as Kimi (see that case): the vendor-neutral
      // openai-compatible package parses `reasoning_content` — which is where
      // M3's thinking lands once we send `reasoning_split: true` via
      // providerOptions (buildProviderOptions) — and `includeUsage` is what
      // makes streamed answers carry a usage chunk instead of billing zero.
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      const baseURL = baseUrl || process.env.MINIMAX_BASE_URL || MINIMAX_DEFAULT_BASE_URL;
      return createOpenAICompatible({ name: 'minimax', apiKey, baseURL, includeUsage: true }).chatModel(model);
    }

    case 'openai-compatible': {
      const baseURL = baseUrl || process.env.LLM_BASE_URL || '';
      if (!baseURL) {
        throw new Error(`Provider "openai-compatible" requires baseUrl in profile or LLM_BASE_URL env`);
      }
      try {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({ apiKey, baseURL }).chat(model);
      } catch (_err) {
        const { createDeepSeek } = await import('@ai-sdk/deepseek');
        return createDeepSeek({ apiKey, baseURL }).chat(model);
      }
    }

    default:
      throw new Error(
        `Unknown model provider: "${provider}". Supported: deepseek, openai, kimi, minimax, openai-compatible`,
      );
  }
}

function providerScopeId(apiKeyEnv: string, provider: string, baseUrl?: string): string {
  return `${apiKeyEnv}:${provider}:${baseUrl ?? 'default'}`;
}

function boundedCallOptions(options: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
  return options.maxOutputTokens === undefined
    ? { ...options, maxOutputTokens: DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS }
    : options;
}

function normalizedAttemptUsage(usage: LanguageModelV3Usage): ProviderAttemptUsage {
  return {
    inputTokens: usage.inputTokens.total,
    outputTokens: usage.outputTokens.total,
    cachedInputTokens: usage.inputTokens.cacheRead,
    cacheWriteTokens: usage.inputTokens.cacheWrite,
    reasoningTokens: usage.outputTokens.reasoning,
  };
}

async function settleProviderAttempt(
  lease: ProviderAttemptLease,
  usage: LanguageModelV3Usage,
  descriptor: ProviderAttemptDescriptor,
): Promise<void> {
  try {
    await lease.settle(normalizedAttemptUsage(usage));
  } catch (error) {
    // User output already exists. Preserve it; the reservation remains and its
    // TTL charges the conservative estimate if accounting is unavailable.
    logger.warn('[LLM] provider-attempt settlement failed', {
      scopeId: descriptor.scopeId,
      model: descriptor.modelId,
      error: String(error),
    });
  }
}

/**
 * Wrap a concrete provider, below the fallback and SDK retry layers.
 * Every real network attempt therefore gets its own atomic admission check.
 */
function wrapProviderAttempt(
  model: LanguageModelV3,
  descriptor: ProviderAttemptDescriptor,
  hook?: ProviderAttemptHook,
): LanguageModelV3 {
  return {
    specificationVersion: 'v3' as const,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,

    async doGenerate(options: LanguageModelV3CallOptions) {
      const bounded = boundedCallOptions(options);
      const lease = hook ? await hook({ descriptor, options: bounded }) : null;
      lease?.markProviderIoStarted();
      const result = await model.doGenerate(bounded);
      if (lease) await settleProviderAttempt(lease, result.usage, descriptor);
      return result;
    },

    async doStream(options: LanguageModelV3CallOptions) {
      const bounded = boundedCallOptions(options);
      const lease = hook ? await hook({ descriptor, options: bounded }) : null;
      lease?.markProviderIoStarted();
      const result = await model.doStream(bounded);
      if (!lease) return result;

      let settled = false;
      const stream = result.stream.pipeThrough(
        new TransformStream({
          async transform(part, controller) {
            if (part.type === 'finish' && !settled) {
              settled = true;
              await settleProviderAttempt(lease, part.usage, descriptor);
            }
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream };
    },
  };
}

// ─── Fallback Language Model ─────────────────────────────

/**
 * A LanguageModelV3 wrapper that tries multiple providers in order.
 * Falls back to the next provider on retriable errors (429, 5xx, network).
 */
function createFallbackModel(models: LanguageModelV3[], providerNames: string[]): LanguageModelV3 {
  const primary = models[0];

  return {
    specificationVersion: 'v3' as const,
    provider: `fallback(${providerNames.join(',')})`,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,

    async doGenerate(options: LanguageModelV3CallOptions) {
      for (let i = 0; i < models.length; i++) {
        try {
          return await models[i].doGenerate(options);
        } catch (err) {
          if (!isRetriableError(err) || i === models.length - 1) throw err;
          logger.warn(
            `[LLM] ⚠️ ${providerNames[i]} failed (${(err as Error).message?.slice(0, 80)}), trying ${providerNames[i + 1]}...`,
          );
        }
      }
      throw new Error('All providers failed');
    },

    async doStream(options: LanguageModelV3CallOptions) {
      for (let i = 0; i < models.length; i++) {
        try {
          return await models[i].doStream(options);
        } catch (err) {
          if (!isRetriableError(err) || i === models.length - 1) throw err;
          logger.warn(
            `[LLM] ⚠️ ${providerNames[i]} stream failed (${(err as Error).message?.slice(0, 80)}), trying ${providerNames[i + 1]}...`,
          );
        }
      }
      throw new Error('All providers failed');
    },
  };
}

// ─── Public API ──────────────────────────────────────────

/**
 * Create a language model instance from a ModelConfig.
 *
 * If `config.id` is set, resolves via the model registry and creates
 * a fallback model with all available providers.
 * Otherwise, falls back to the legacy direct `provider + model` path.
 */
export async function createModelFromConfig(
  config: ModelConfig,
  options: CreateModelOptions = {},
): Promise<LanguageModel> {
  // ── New path: registry-based resolution ──
  if (config.id) {
    const available = getAvailableProviders(config.id);
    if (available.length === 0) {
      throw new Error(
        `No available providers for model "${config.id}". Check that at least one API key env var is set.`,
      );
    }

    const models: LanguageModelV3[] = [];
    const names: string[] = [];

    for (const entry of available) {
      const apiKey = process.env[entry.apiKeyEnv] ?? '';
      const model = await createModelDirect(entry.provider, entry.model, apiKey, entry.baseUrl);
      models.push(
        wrapProviderAttempt(
          model,
          {
            provider: entry.provider,
            modelId: entry.model,
            apiKeyEnv: entry.apiKeyEnv,
            ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
            logicalModelId: config.id,
            scopeId: providerScopeId(entry.apiKeyEnv, entry.provider, entry.baseUrl),
          },
          options.onProviderAttempt,
        ),
      );
      names.push(`${entry.provider}/${entry.model}`);
    }

    if (models.length === 1) {
      logger.info(`[LLM] Model "${config.id}" resolved to ${names[0]} (no fallback)`);
      return models[0];
    }

    logger.info(`[LLM] Model "${config.id}" resolved with fallback chain: ${names.join(' → ')}`);
    return createFallbackModel(models, names);
  }

  // ── Legacy path: direct provider configuration ──
  const apiKeyEnvVar = config.apiKey || 'LLM_API_KEY';
  const apiKey = process.env[apiKeyEnvVar] ?? '';
  const model = await createModelDirect(config.provider, config.model, apiKey, config.baseUrl);
  return wrapProviderAttempt(
    model,
    {
      provider: config.provider,
      modelId: config.model,
      apiKeyEnv: apiKeyEnvVar,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      scopeId: providerScopeId(apiKeyEnvVar, config.provider, config.baseUrl),
    },
    options.onProviderAttempt,
  );
}

/**
 * Apply a frontend/API model override to a profile's ModelConfig.
 *
 * createModelFromConfig resolves by `config.id` when set, so an override must
 * rewrite `id` — only changing `model` leaves the toggle silently ineffective
 * (all profiles use the registry path). Raw provider model strings (e.g.
 * "deepseek-v4-pro") are mapped back to their registry entry to keep the
 * fallback chain; unknown strings switch to the direct provider+model path.
 * provider/model are synced to the resolved primary so DSML interception and
 * usage accounting see the model that actually runs.
 */
export function applyModelOverride(config: ModelConfig, override: string): ModelConfig {
  const registryId = getModelEntry(override) ? override : findModelIdByProviderModel(override);
  if (registryId) {
    const primary = getModelEntry(registryId)!.providers[0];
    return { ...config, id: registryId, provider: primary.provider, model: primary.model };
  }
  return { ...config, id: undefined, model: override };
}

/**
 * Does this model config resolve to a DeepSeek model?
 *
 * DSML tool-call leaks are a DeepSeek-model trait, so the DSML interceptor must
 * wrap whenever the model that actually runs is DeepSeek. Registry-id profiles
 * (the default, e.g. `id: flash`) don't carry `provider` on the config, so a
 * bare `config.provider === 'deepseek'` check silently misses them — that gap
 * leaked raw DSML markup into answers. Look through the registry entry to the
 * underlying provider chain (env-independent: gate on the model family, not on
 * which API key happens to be configured).
 */
export function resolvesToDeepSeek(config: ModelConfig): boolean {
  const providers = config.id
    ? (getModelEntry(config.id)?.providers ?? [])
    : config.provider
      ? [{ provider: config.provider, model: config.model ?? '' }]
      : [];
  return providers.some((p) => p.provider === 'deepseek' || p.model.includes('deepseek'));
}

/**
 * Materialize the options a model config actually runs with.
 *
 * Two legitimate layers, and the order matters:
 *   1. the MODEL's own behavior, from the catalog (`models.yaml` → registry) —
 *      this is what makes "the same assistant on a stronger model" a model
 *      choice rather than a second agent;
 *   2. the AGENT's task tuning on top, for profiles that genuinely need it
 *      (eval-judge grades at temperature 0.2 whatever the model's default is).
 *
 * Kimi is the exception that has to be enforced, not documented: it pins
 * sampling server-side and answers `400 invalid temperature: only 1 is allowed
 * for this model` to anything else. The relay already strips these on the way
 * out (buildUpstreamBody); this is the same rule on the chat path, so switching
 * a conversation to K3 can never smuggle the previous model's temperature.
 */
const KIMI_PINNED_SAMPLING = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'] as const;

export function resolveModelConfig(config: ModelConfig): ModelConfig {
  const entry = config.id ? getModelEntry(config.id) : undefined;
  if (!entry) return config;

  const options: ModelOptions = { ...entry.options, ...config.options };
  if (entry.providers[0]?.provider === 'kimi') {
    for (const key of KIMI_PINNED_SAMPLING) delete options[key];
  }
  return { ...config, options };
}

/**
 * Build provider-specific options from model config.
 * Returns a type compatible with AI SDK's ProviderOptions.
 */
export function buildProviderOptions(config: ModelConfig): any {
  // Registry configs inherit the primary provider; direct configs use their
  // declared provider.
  const effectiveProvider = config.id ? getModelEntry(config.id)?.providers[0]?.provider : config.provider;

  // Kimi K3 reasons unconditionally (turning thinking off downgrades the
  // request to an older model upstream), so there is no `thinking` switch —
  // only how hard it thinks. Lands on the wire as `reasoning_effort`.
  if (effectiveProvider === 'kimi') {
    const effort = config.options?.reasoning_effort;
    return effort ? { kimi: { reasoningEffort: effort } } : undefined;
  }

  // MiniMax M3: `reasoning_split` moves thinking out of `<think>` tags in
  // `content` into the separate `reasoning_content` field the client parses —
  // it controls WHERE thinking is returned, not whether it happens. The
  // openai-compatible client merges unknown namespace keys into the request
  // body verbatim, so these land on the wire as-is. Thinking defaults to on
  // upstream; only an explicit `thinking: false` sends the disable switch.
  if (effectiveProvider === 'minimax') {
    return {
      minimax: {
        reasoning_split: true,
        ...(config.options?.thinking === false ? { thinking: { type: 'disabled' } } : {}),
      },
    };
  }

  if (!config.options?.thinking) return undefined;

  // Only DeepSeek currently has a thinking option.
  return effectiveProvider === 'deepseek' ? { deepseek: { thinking: { type: 'enabled' } } } : undefined;
}
