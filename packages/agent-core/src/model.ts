/**
 * LLM Model Factory — creates language model instances from configuration.
 *
 * The kernel speaks ONE wire protocol: OpenAI-compatible (`openai` and
 * `openai-compatible`, both backed by `@ai-sdk/openai`). DeepSeek, local Ollama,
 * gateways, etc. are all reachable through their OpenAI-compatible endpoints.
 * Native provider protocols (Anthropic, Google, …) are intentionally not bundled
 * but the provider switch keeps a clear extension seam to re-add them.
 *
 * Features:
 * - Registry-based model resolution (logical ID → provider chain)
 * - Automatic fallback across providers on retriable errors
 * - Backward-compatible direct provider configuration
 */

import type { LanguageModel } from 'ai';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { getAvailableProviders, getModelEntry, findModelIdByProviderModel } from './registry.js';
import { logger } from '@greenhouse/utils/logger';

// ─── Model Config Types ──────────────────────────────────
// Owned by the kernel: every host (api profiles, eval, future runtimes)
// describes models with this shape.

export interface ModelOptions {
  thinking?: boolean; // enable reasoning mode (if the model supports it)
  temperature?: number; // sampling temperature (default: 0.7)
  max_tokens?: number; // max output tokens (default: 4096)
  [key: string]: unknown; // provider-specific options
}

export interface ModelChoice {
  id: string; // logical model ID from registry (e.g. "flash", "pro")
  label: string; // display label for UI pickers (e.g. "快思考")
  description?: string;
}

export interface ModelConfig {
  id?: string; // logical model ID from registry (e.g. "default", "flash", "pro") — takes precedence
  provider: string; // e.g. "openai", "openai-compatible"
  model: string; // model ID
  baseUrl?: string; // override base URL (for openai-compatible)
  apiKey?: string; // env var name to read API key from (default: LLM_API_KEY)
  options?: ModelOptions; // model behavior options
  // Models the user may switch to for this profile. Absent/empty = model is
  // pinned to the profile config and client overrides are ignored.
  choices?: ModelChoice[];
}

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
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey, baseURL: baseUrl || undefined }).chat(model);
    }

    case 'openai-compatible': {
      const baseURL = baseUrl || process.env.LLM_BASE_URL || '';
      if (!baseURL) {
        throw new Error(`Provider "openai-compatible" requires baseUrl in profile or LLM_BASE_URL env`);
      }
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey, baseURL }).chat(model);
    }

    // To add a native provider (anthropic, google, …): install its @ai-sdk/* SDK
    // and add a case here.

    default:
      throw new Error(`Unknown model provider: "${provider}". Supported: openai, openai-compatible`);
  }
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
export async function createModelFromConfig(config: ModelConfig): Promise<LanguageModel> {
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
      models.push(model);
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
  return createModelDirect(config.provider, config.model, apiKey, config.baseUrl);
}

/**
 * Apply a frontend/API model override to a profile's ModelConfig.
 *
 * createModelFromConfig resolves by `config.id` when set, so an override must
 * rewrite `id` — only changing `model` leaves the toggle silently ineffective
 * (all profiles use the registry path). Raw provider model strings are mapped
 * back to their registry entry to keep the fallback chain; unknown strings
 * switch to the direct provider+model path. provider/model are synced to the
 * resolved primary so usage accounting sees the model that actually runs.
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
 * Validate a client-requested model override against the profile's declared
 * choices. The profile is authoritative: when it declares no `choices`, its
 * model is pinned and every override is ignored (returns undefined → profile
 * default applies). Legacy clients sending raw provider model names are mapped
 * back to the registry ID before matching. Invalid overrides fall back silently
 * rather than failing the request.
 */
export function resolveModelChoice(config: ModelConfig, override?: string | null): string | undefined {
  if (!override) return undefined;
  const choices = config.choices;
  if (!choices?.length) return undefined;
  const candidate = getModelEntry(override) ? override : (findModelIdByProviderModel(override) ?? override);
  return choices.some((c) => c.id === candidate) ? candidate : undefined;
}

/**
 * Build provider-specific options (AI SDK `providerOptions`) from model config.
 *
 * No-op now that the kernel is OpenAI-compatible only — there are no
 * provider-specific options to inject. Kept as a seam so callers stay unchanged
 * and a future native provider can re-populate it.
 */
export function buildProviderOptions(_config: ModelConfig): any {
  return undefined;
}
