/**
 * Model Registry — logical model IDs → an ordered chain of OpenAI-compatible
 * providers, derived from environment configuration.
 *
 * The kernel speaks ONE wire protocol: OpenAI-compatible. A deployment points
 * `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` at any OpenAI-compatible endpoint
 * (OpenAI, DeepSeek's OpenAI endpoint, a local Ollama `/v1`, a gateway, …) and
 * every logical id (`default`, `flash`, `pro`) resolves to it.
 *
 * The registry is built lazily (read on each call), not frozen at import time:
 * dotenv loads inside the api entrypoint, after this module is first imported,
 * so an import-time const would capture an empty env.
 */

// ─── Types ───────────────────────────────────────────────

export interface ProviderEntry {
  /** Provider type for createModelFromConfig — always 'openai-compatible' today. */
  provider: string;
  /** Model ID on this provider's platform */
  model: string;
  /** Environment variable name holding the API key */
  apiKeyEnv: string;
  /** Optional base URL override */
  baseUrl?: string;
}

export interface ModelEntry {
  /** Human-readable model name */
  name: string;
  /** Ordered provider chain — first entry is primary, rest are fallbacks */
  providers: ProviderEntry[];
}

// ─── Env-derived registry ────────────────────────────────

/** The model id used everywhere a deployment hasn't configured `LLM_MODEL`. */
const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Build the registry from the current environment.
 *
 * Read lazily on every helper call so env populated after import (dotenv in the
 * api entry) is honored. All ids map to the single OpenAI-compatible upstream;
 * `pro` may diverge via `LLM_MODEL_PRO`.
 */
function buildRegistry(): Record<string, ModelEntry> {
  const baseUrl = process.env.LLM_BASE_URL || undefined;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  const proModel = process.env.LLM_MODEL_PRO || model;

  const entry = (m: string, name: string): ModelEntry => ({
    name,
    providers: [
      {
        provider: 'openai-compatible',
        model: m,
        apiKeyEnv: 'LLM_API_KEY',
        baseUrl,
      },
    ],
  });

  return {
    // Primary id — what hosts use by default.
    default: entry(model, model),
    // Logical aliases kept so existing profile refs (`id: flash` / `id: pro`)
    // still resolve. Both map to the same env model; `pro` can diverge via
    // LLM_MODEL_PRO.
    flash: entry(model, model),
    pro: entry(proModel, proModel),
  };
}

// ─── Helpers ─────────────────────────────────────────────

/** Get a model entry by logical ID. */
export function getModelEntry(id: string): ModelEntry | undefined {
  return buildRegistry()[id];
}

/** Get all logical model IDs. */
export function getModelIds(): string[] {
  return Object.keys(buildRegistry());
}

/**
 * Reverse-lookup a logical model ID by a raw provider model string
 * (e.g. the configured model name → "default"). Frontends send raw model
 * strings as overrides; mapping them back onto a registry entry keeps the
 * provider chain.
 */
export function findModelIdByProviderModel(model: string): string | undefined {
  for (const [id, entry] of Object.entries(buildRegistry())) {
    if (entry.providers.some((p) => p.model === model)) return id;
  }
  return undefined;
}

/**
 * Get available providers for a model (those with API keys configured).
 * Returns entries in priority order.
 */
export function getAvailableProviders(id: string): ProviderEntry[] {
  const entry = buildRegistry()[id];
  if (!entry) return [];
  return entry.providers.filter((p) => !!process.env[p.apiKeyEnv]);
}
