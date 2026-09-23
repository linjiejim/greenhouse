/**
 * Model catalog loader — reads `config/models.yaml` and installs it into
 * agent-core's registry at boot.
 *
 * One catalog, two consumers: the chat/agent runtime (profiles reference model
 * ids) and the outbound relay at /api/llm. Keys stay in env — the config only
 * names the variable, so nothing secret is committed or served.
 *
 * Fail-fast on a malformed file: booting with a silently-empty catalog would
 * surface much later as "no provider available" on a user's first message.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { setModelRegistry, getAvailableProviders, type ModelEntry, type ProviderEntry } from '@greenhouse/agent-core';
import { logger } from '@greenhouse/utils/logger';

const CONFIG_PATH = resolve(import.meta.dirname, 'models.yaml');

export interface RelayCatalogConfig {
  /** Model id served when a relay key declares no subset. */
  default: string;
  /** Model ids external clients may request. */
  public: string[];
}

export interface ChatCatalogConfig {
  /** Model ids a user may switch between in Chat, in picker order. */
  selectable: string[];
}

export interface ModelCatalog {
  models: Record<string, ModelEntry>;
  chat: ChatCatalogConfig;
  relay: RelayCatalogConfig;
}

let catalog: ModelCatalog | null = null;

/**
 * `model` / `base_url` may be given literally or via `model_env` / `base_url_env`
 * (the NAME of an env var read at boot). The env indirection is what lets the
 * default catalog serve any OpenAI-compatible endpoint from LLM_MODEL /
 * LLM_BASE_URL without editing this file. A provider whose `model_env` is unset
 * is dropped (returns null) so the model simply has one fewer provider.
 */
function parseProvider(raw: unknown, modelId: string, index: number): ProviderEntry | null {
  const p = raw as Record<string, unknown> | undefined;
  const provider = p?.provider;
  const apiKeyEnv = p?.api_key_env;
  const modelEnv = typeof p?.model_env === 'string' ? p.model_env : undefined;
  const model = typeof p?.model === 'string' ? p.model : modelEnv ? process.env[modelEnv]?.trim() : undefined;
  if (typeof provider !== 'string' || typeof apiKeyEnv !== 'string' || (typeof p?.model !== 'string' && !modelEnv)) {
    throw new Error(
      `models.yaml: models.${modelId}.providers[${index}] needs provider, api_key_env and model (or model_env)`,
    );
  }
  if (!model) return null;
  const baseUrlEnv = typeof p?.base_url_env === 'string' ? p.base_url_env : undefined;
  const baseUrl =
    typeof p?.base_url === 'string' ? p.base_url : baseUrlEnv ? process.env[baseUrlEnv]?.trim() : undefined;
  return {
    provider,
    model,
    apiKeyEnv,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

const ENV_TRUE = new Set(['true', '1', 'yes', 'on']);
const ENV_FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * `vision` may be overridden per deployment by the env var `vision_env` names:
 * the default model follows LLM_MODEL, so only the operator knows whether the
 * model behind it reads images. An unrecognized value keeps the declared
 * default rather than throwing — this also runs when an admin saves Runtime
 * Config, and a typo there must not take the catalog (and the next boot) down.
 */
function resolveVision(modelId: string, declared: boolean | undefined, visionEnv: string | undefined) {
  const raw = visionEnv ? process.env[visionEnv]?.trim().toLowerCase() : undefined;
  if (!raw) return declared;
  if (ENV_TRUE.has(raw)) return true;
  if (ENV_FALSE.has(raw)) return false;
  logger.warn(`[models] ${visionEnv}="${raw}" is not true/false — models.${modelId}.vision stays ${Boolean(declared)}`);
  return declared;
}

export function parseModelCatalog(source: string): ModelCatalog {
  const doc = parseYaml(source) as Record<string, unknown> | null;
  const rawModels = doc?.models as Record<string, unknown> | undefined;
  if (!rawModels || Object.keys(rawModels).length === 0) {
    throw new Error('models.yaml: `models` must declare at least one model');
  }

  const models: Record<string, ModelEntry> = {};
  for (const [id, value] of Object.entries(rawModels)) {
    const entry = value as Record<string, unknown> | undefined;
    const providers = entry?.providers;
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error(`models.yaml: models.${id}.providers must be a non-empty list`);
    }

    // Context-window declaration — feeds the per-model chat history budget
    // (resolveHistoryBudget). Validated here so a typo fails at boot, not as a
    // provider context-length error on someone's long session.
    const contextWindow = entry?.context_window;
    if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || (contextWindow as number) <= 0)) {
      throw new Error(`models.yaml: models.${id}.context_window must be a positive integer (tokens)`);
    }
    const compactionThreshold = entry?.compaction_threshold;
    if (compactionThreshold !== undefined) {
      if (typeof compactionThreshold !== 'number' || !(compactionThreshold > 0) || compactionThreshold > 0.9) {
        // >0.9 leaves no headroom for system prompt, tools, reasoning + output.
        throw new Error(`models.yaml: models.${id}.compaction_threshold must be a number in (0, 0.9]`);
      }
      if (contextWindow === undefined) {
        throw new Error(`models.yaml: models.${id}.compaction_threshold requires context_window`);
      }
    }

    // Vision capability — hosts inline image attachments only for models that
    // declare it. Anything but a literal true is treated as text-only.
    const declaredVision = entry?.vision;
    if (declaredVision !== undefined && typeof declaredVision !== 'boolean') {
      throw new Error(`models.yaml: models.${id}.vision must be a boolean`);
    }
    const visionEnv = entry?.vision_env;
    if (visionEnv !== undefined && typeof visionEnv !== 'string') {
      throw new Error(`models.yaml: models.${id}.vision_env must name an env var`);
    }
    const vision = resolveVision(id, declaredVision, visionEnv);

    models[id] = {
      name: typeof entry?.name === 'string' ? entry.name : id,
      // Options belong to the model — every consumer inherits them.
      ...(entry?.options && typeof entry.options === 'object'
        ? { options: entry.options as ModelEntry['options'] }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow: contextWindow as number } : {}),
      ...(compactionThreshold !== undefined ? { compactionThreshold } : {}),
      ...(vision !== undefined ? { vision } : {}),
      providers: providers.map((p, i) => parseProvider(p, id, i)).filter((p): p is ProviderEntry => p !== null),
    };
  }

  const rawChat = doc?.chat as Record<string, unknown> | undefined;
  const chat: ChatCatalogConfig = {
    selectable: (Array.isArray(rawChat?.selectable) ? (rawChat.selectable as unknown[]) : []).map(String),
  };
  for (const id of chat.selectable) {
    if (!models[id]) throw new Error(`models.yaml: chat.selectable references unknown model "${id}"`);
  }

  const rawRelay = doc?.relay as Record<string, unknown> | undefined;
  const relay: RelayCatalogConfig = {
    default: typeof rawRelay?.default === 'string' ? rawRelay.default : Object.keys(models)[0]!,
    public: (Array.isArray(rawRelay?.public) ? (rawRelay.public as unknown[]) : Object.keys(models)).map(String),
  };
  for (const id of [relay.default, ...relay.public]) {
    if (!models[id]) throw new Error(`models.yaml: relay references unknown model "${id}"`);
  }

  return { models, chat, relay };
}

/** Load + install the catalog. Idempotent; call once from main(). */
export function initModelCatalog(): ModelCatalog {
  if (catalog) return catalog;
  return reloadModelCatalog();
}

/**
 * Re-read the catalog file and re-install it. Needed after the workspace
 * settings overlay changes an env var a provider resolves through
 * `model_env` / `base_url_env` (LLM_MODEL, LLM_BASE_URL, …).
 */
export function reloadModelCatalog(): ModelCatalog {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`model catalog not found at ${CONFIG_PATH}`);
  }
  catalog = parseModelCatalog(readFileSync(CONFIG_PATH, 'utf-8'));
  setModelRegistry(catalog.models);
  logger.info(`[models] catalog loaded: ${Object.keys(catalog.models).join(', ')}`);
  return catalog;
}

export function getModelCatalog(): ModelCatalog {
  return catalog ?? initModelCatalog();
}

/**
 * Models the Chat picker may offer: declared selectable AND actually reachable
 * (at least one provider whose api_key_env is set). The reachability half used
 * to live in `isProfileRunnable` — a deployment without DEEPSEEK_API_KEY simply
 * never shows `deepseek-flash`, rather than offering it and failing on the
 * first message.
 */
export function listChatModels(): Array<{ id: string; name: string }> {
  const cat = getModelCatalog();
  return cat.chat.selectable
    .filter((id) => getAvailableProviders(id).length > 0)
    .map((id) => ({ id, name: cat.models[id]!.name }));
}

/** Whether a user-supplied model id may be used for a chat turn. */
export function isChatModelAllowed(id: string): boolean {
  return listChatModels().some((m) => m.id === id);
}
