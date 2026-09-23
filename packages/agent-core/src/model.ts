/**
 * LLM Model Factory — creates language model instances from configuration.
 *
 * Supports DeepSeek, OpenAI, and OpenAI-compatible providers
 * via lazy dynamic imports — only the provider SDK actually used gets loaded.
 * An `openai-compatible` entry that points at DeepSeek is built with the
 * DeepSeek client (isDeepSeekFamily), so thinking on/off and reasoning
 * parsing work whichever provider name the catalog used.
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

// ─── DeepSeek family detection ───────────────────────────

/**
 * Is this (model, endpoint) pair really DeepSeek, whatever the catalog calls
 * the provider?
 *
 * The built-in `flash` / `pro` ids are declared `openai-compatible` so one
 * `LLM_BASE_URL` + `LLM_MODEL` pair works against any endpoint. When that pair
 * points at DeepSeek, the generic @ai-sdk/openai client is the wrong tool: it
 * forwards only `providerOptions.openai`, so `providerOptions.deepseek.thinking`
 * never reaches the wire — V4 then thinks by default, the title generator's
 * 60-token budget went entirely to reasoning, and every title fell back to
 * the user's own words — and it drops `reasoning_content`, leaving the
 * reasoning panel empty. Route by model family / host instead, so the DeepSeek
 * client (itself OpenAI-compatible) is used wherever DeepSeek actually answers.
 *
 * Matches official model ids (`deepseek-chat`, `deepseek-v4-flash`, …) and
 * the official host. Vendor-prefixed ids on third-party gateways
 * (`deepseek-ai/DeepSeek-V4` on SiliconFlow) deliberately stay on the generic
 * client: those gateways do not speak DeepSeek's `thinking` field.
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

    case 'openai-compatible': {
      const baseURL = baseUrl || process.env.LLM_BASE_URL || '';
      if (!baseURL) {
        throw new Error(`Provider "openai-compatible" requires baseUrl in profile or LLM_BASE_URL env`);
      }
      // DeepSeek behind the generic provider id: the DeepSeek client is what
      // carries `providerOptions.deepseek` (thinking on/off) to the wire and
      // parses `reasoning_content`. See isDeepSeekFamily.
      if (isDeepSeekFamily(model, baseURL)) {
        const { createDeepSeek } = await import('@ai-sdk/deepseek');
        return createDeepSeek({ apiKey, baseURL }).chat(model);
      }
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey, baseURL }).chat(model);
    }

    default:
      throw new Error(`Unknown model provider: "${provider}". Supported: deepseek, openai, openai-compatible`);
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
 */
export function resolveModelConfig(config: ModelConfig): ModelConfig {
  const entry = config.id ? getModelEntry(config.id) : undefined;
  if (!entry) return config;

  const options: ModelOptions = { ...entry.options, ...config.options };
  return { ...config, options };
}

/**
 * Build provider-specific options from model config.
 * Returns a type compatible with AI SDK's ProviderOptions.
 */
export function buildProviderOptions(config: ModelConfig): any {
  // Registry configs inherit the primary provider; direct configs use their
  // declared provider. A generic `openai-compatible` entry that really points
  // at DeepSeek gets DeepSeek's knobs — the factory builds it with the DeepSeek
  // client for the same reason (isDeepSeekFamily), so the two stay in step.
  const primary = config.id
    ? getModelEntry(config.id)?.providers[0]
    : { provider: config.provider, model: config.model, baseUrl: config.baseUrl };
  let effectiveProvider = primary?.provider;
  if (
    effectiveProvider === 'openai-compatible' &&
    primary &&
    isDeepSeekFamily(primary.model, primary.baseUrl || process.env.LLM_BASE_URL)
  ) {
    effectiveProvider = 'deepseek';
  }

  // Only DeepSeek has a thinking switch. V4 thinks by default, so both values
  // go on the wire explicitly: the catalog's `thinking` option is then the
  // truth, not a hint the endpoint may or may not share.
  if (effectiveProvider !== 'deepseek') return undefined;
  if (config.options?.thinking === true) return { deepseek: { thinking: { type: 'enabled' } } };
  if (config.options?.thinking === false) return { deepseek: { thinking: { type: 'disabled' } } };
  return undefined;
}
