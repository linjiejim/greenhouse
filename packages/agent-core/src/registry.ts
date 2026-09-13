/**
 * Model Registry — centralized logical model definitions with ordered provider chains.
 *
 * Maps logical model IDs (e.g. "flash", "pro") to an ordered list of providers.
 * The first available provider (with a configured API key) is used as primary;
 * remaining available providers serve as fallbacks.
 *
 * The catalog itself is DATA, not code: the API loads `apps/api/src/config/models.yaml`
 * at boot and installs it via `setModelRegistry()`. The env-derived registry below
 * is the fallback used by tests and by any consumer that boots without the config
 * file. Provider secrets never live here — only the name of the env var holding them.
 */

// ─── Types ───────────────────────────────────────────────

import type { ModelOptions } from './model.js';

export interface ProviderEntry {
  /** Provider type for createModelFromConfig (e.g. "deepseek", "openai-compatible") */
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
  /**
   * Sampling / reasoning behavior belonging to THE MODEL — every consumer gets
   * it. Kept here rather than on each agent because it describes the engine
   * (K3 must never receive a temperature; pro reasons), not the assistant.
   */
  options?: ModelOptions;
  /**
   * Max context window in tokens. Declare the MINIMUM across the provider
   * chain — a fallback provider serving a smaller window than the primary
   * would otherwise overflow exactly when the primary is down.
   */
  contextWindow?: number;
  /**
   * Fraction of `contextWindow` at which history compaction triggers
   * (today: the drop-oldest pre-send window; later: fold-summarization).
   * Defaults to DEFAULT_COMPACTION_THRESHOLD (0.5) when unset.
   */
  compactionThreshold?: number;
  /**
   * The model natively accepts image input parts. Hosts use this to inline
   * attached images into the payload instead of routing them through a vision
   * tool. Fail closed: undeclared means text-only.
   */
  vision?: boolean;
  /** Ordered provider chain — first entry is primary, rest are fallbacks */
  providers: ProviderEntry[];
}

// ─── Registry ────────────────────────────────────────────

/** The model id used everywhere a deployment hasn't configured `LLM_MODEL`. */
const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Build the built-in fallback catalog from the environment. Every logical id
 * resolves to the single OpenAI-compatible upstream named by `LLM_BASE_URL` /
 * `LLM_API_KEY` / `LLM_MODEL`; `pro` may diverge via `LLM_MODEL_PRO`. The API
 * installs the richer `models.yaml` catalog over this at boot; tests and any
 * consumer that boots without the config file get this one.
 *
 * Read lazily (not frozen at import time): dotenv loads inside the api
 * entrypoint, after this module is first imported.
 */
export function buildDefaultRegistry(): Record<string, ModelEntry> {
  const baseUrl = process.env.LLM_BASE_URL || undefined;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  const proModel = process.env.LLM_MODEL_PRO || model;
  const entry = (m: string, name: string): ModelEntry => ({
    name,
    contextWindow: 128_000,
    providers: [{ provider: 'openai-compatible', model: m, apiKeyEnv: 'LLM_API_KEY', baseUrl }],
  });
  return {
    flash: entry(model, 'Default model'),
    pro: entry(proModel, 'Stronger model'),
  };
}

/** Import-time snapshot of the built-in catalog — the reset value tests use. */
export const DEFAULT_MODEL_REGISTRY: Record<string, ModelEntry> = buildDefaultRegistry();

let activeRegistry: Record<string, ModelEntry> | null = null;

/** Install the catalog loaded from config. Called once at API boot. */
export function setModelRegistry(registry: Record<string, ModelEntry>): void {
  if (Object.keys(registry).length === 0) throw new Error('model registry cannot be empty');
  activeRegistry = registry;
}

/** The catalog in effect — config-provided if installed, built-in otherwise. */
export function getModelRegistry(): Record<string, ModelEntry> {
  return activeRegistry ?? buildDefaultRegistry();
}

// ─── Helpers ─────────────────────────────────────────────

/** Get a model entry by logical ID. */
export function getModelEntry(id: string): ModelEntry | undefined {
  return getModelRegistry()[id];
}

/**
 * Reverse-lookup a logical model ID by a raw provider model string
 * (e.g. "deepseek-v4-pro" → "pro"). Frontends send raw model strings as
 * overrides; mapping them back onto a registry entry keeps the fallback chain.
 */
export function findModelIdByProviderModel(model: string): string | undefined {
  for (const [id, entry] of Object.entries(getModelRegistry())) {
    if (entry.providers.some((p) => p.model === model)) return id;
  }
  return undefined;
}

/**
 * Get available providers for a model (those with API keys configured).
 * Returns entries in priority order.
 */
export function getAvailableProviders(id: string): ProviderEntry[] {
  const entry = getModelRegistry()[id];
  if (!entry) return [];
  return entry.providers.filter((p) => !!process.env[p.apiKeyEnv]);
}

/**
 * Whether a catalog model natively accepts image input. Unknown ids and
 * entries without the declaration are text-only — the safe default is the
 * existing analyze_image path, never an image payload the model can't read.
 */
export function modelSupportsVision(id: string | undefined): boolean {
  return Boolean(id && getModelRegistry()[id]?.vision);
}
