/**
 * Provider instances declared in env (docs/product/providers.md §4.2, §4.3). They live only
 * in memory, are read-only in the UI, and serve until an admin saves a binding.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  CAPABILITIES,
  listAdapters,
  type AnyAdapter,
  type Capability,
  type ProviderPreset,
} from '@greenhouse/providers';
import type { ProviderPolicy } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';

export interface EnvInstance {
  id: string;
  capability: Capability;
  kind: string;
  preset: string | null;
  name: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface EnvProviders {
  instances: EnvInstance[];
  defaults: Partial<Record<Capability, Record<string, unknown>>>;
  policies: Partial<Record<Capability, ProviderPolicy>>;
}

/** Instance ids appear in model references (`instance/model`), so they stay simple. */
export const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

type Env = Record<string, string | undefined>;

const value = (env: Env, key: string) => {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
};

const compact = (record: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => !!entry[1]));

/** `<CAP>_PROVIDER` may name an adapter or one of its presets. */
function findAdapter(
  capability: Capability,
  name: string,
): { adapter: AnyAdapter; preset: ProviderPreset | null } | null {
  for (const adapter of listAdapters(capability)) {
    if (adapter.kind === name) return { adapter, preset: null };
    const preset = adapter.presets?.find((entry) => entry.id === name);
    if (preset) return { adapter, preset };
  }
  return null;
}

function llmFromEnv(env: Env): { instance: EnvInstance; defaults: Record<string, unknown> } | null {
  // A bare base URL means an OpenAI-compatible endpoint.
  const name = value(env, 'LLM_PROVIDER') ?? (value(env, 'LLM_BASE_URL') ? 'openai-compatible' : undefined);
  if (!name) return null;
  const found = findAdapter('llm', name);
  if (!found) {
    logger.warn(`[providers] LLM_PROVIDER=${name} is not a known adapter or preset; ignored`);
    return null;
  }
  const { adapter, preset } = found;
  const model = value(env, 'LLM_MODEL') ?? (preset?.config.defaultModel as string | undefined);
  const strong = value(env, 'LLM_MODEL_STRONG');
  const fast = value(env, 'LLM_MODEL_FAST');
  const ids = [...new Set([model, strong, fast].filter((id): id is string => !!id))];
  const id = 'env-llm';
  return {
    instance: {
      id,
      capability: 'llm',
      kind: adapter.kind,
      preset: preset?.id ?? null,
      name: preset?.label ?? adapter.label,
      config: {
        ...compact({ baseUrl: value(env, 'LLM_BASE_URL') ?? (preset?.config.baseUrl as string | undefined) }),
        ...(model ? { defaultModel: model } : {}),
        models: ids.map((modelId) => ({ id: modelId })),
      },
      secrets: compact({ apiKey: value(env, 'LLM_API_KEY') }),
    },
    defaults: compact({
      default: model && `${id}/${model}`,
      strong: strong && `${id}/${strong}`,
      fast: fast && `${id}/${fast}`,
    }),
  };
}

/** STT_*, TTS_*, IMAGE_*: one instance each. */
function simpleFromEnv(env: Env, capability: 'stt' | 'tts' | 'image', prefix: string): EnvInstance | null {
  const name = value(env, `${prefix}_PROVIDER`);
  if (!name) return null;
  const found = findAdapter(capability, name);
  if (!found) {
    logger.warn(`[providers] ${prefix}_PROVIDER=${name} is not a known adapter or preset; ignored`);
    return null;
  }
  const { adapter, preset } = found;
  return {
    id: `env-${capability}`,
    capability,
    kind: adapter.kind,
    preset: preset?.id ?? null,
    name: preset?.label ?? adapter.label,
    config: {
      ...preset?.config,
      ...compact({
        baseUrl: value(env, `${prefix}_BASE_URL`),
        model: value(env, `${prefix}_MODEL`),
        voice: value(env, `${prefix}_VOICE`),
      }),
    },
    secrets: compact({ apiKey: value(env, `${prefix}_API_KEY`) }),
  };
}

const SEARCH_ENV: Record<string, { secret?: string; baseUrl?: string }> = {
  tavily: { secret: 'TAVILY_API_KEY' },
  brave: { secret: 'BRAVE_API_KEY' },
  exa: { secret: 'EXA_API_KEY' },
  jina: { secret: 'JINA_API_KEY' },
  firecrawl: { secret: 'FIRECRAWL_API_KEY' },
  bocha: { secret: 'BOCHA_API_KEY' },
  searxng: { baseUrl: 'SEARXNG_URL' },
};

/** SEARCH_PROVIDER=tavily,brave: the list is the fallback order. */
function searchFromEnv(env: Env): EnvInstance[] {
  const kinds = (value(env, 'SEARCH_PROVIDER') ?? '')
    .split(',')
    .map((kind) => kind.trim())
    .filter(Boolean);
  return kinds.flatMap((kind): EnvInstance[] => {
    const vars = SEARCH_ENV[kind];
    const found = vars ? findAdapter('search', kind) : null;
    if (!vars || !found) {
      logger.warn(`[providers] SEARCH_PROVIDER entry "${kind}" is not available; ignored`);
      return [];
    }
    return [
      {
        id: `env-search-${kind}`,
        capability: 'search',
        kind: found.adapter.kind,
        preset: null,
        name: found.adapter.label,
        config: compact({ baseUrl: vars.baseUrl && value(env, vars.baseUrl) }),
        secrets: compact({ apiKey: vars.secret && value(env, vars.secret) }),
      },
    ];
  });
}

/**
 * SANDBOX_PROVIDER=docker: the Agent computers run on this machine's Docker engine.
 * SANDBOX_PROVIDER=e2b (or a preset, ppio): each one is a sandbox at an E2B-protocol provider.
 */
function sandboxFromEnv(env: Env): EnvInstance | null {
  const name = value(env, 'SANDBOX_PROVIDER');
  if (!name) return null;
  const found = findAdapter('sandbox', name);
  if (!found) {
    logger.warn(`[providers] SANDBOX_PROVIDER=${name} is not available; ignored`);
    return null;
  }
  const { adapter, preset } = found;
  let config: Record<string, unknown>;
  if (adapter.kind === 'e2b') {
    const timeout = value(env, 'SANDBOX_E2B_TIMEOUT_MINUTES');
    config = {
      ...compact({
        domain: value(env, 'SANDBOX_E2B_DOMAIN'),
        template: value(env, 'SANDBOX_E2B_TEMPLATE'),
        namespace: value(env, 'SANDBOX_E2B_NAMESPACE'),
      }),
      ...(timeout ? { timeoutMinutes: Number(timeout) } : {}),
    };
    if (!config.template) {
      logger.warn(
        `[providers] SANDBOX_PROVIDER=${name} needs SANDBOX_E2B_TEMPLATE (scripts/e2b-template.mts builds it); ignored`,
      );
      return null;
    }
  } else {
    config = compact({
      image: value(env, 'SANDBOX_IMAGE'),
      runtime: value(env, 'SANDBOX_DOCKER_RUNTIME'),
      network: value(env, 'SANDBOX_NETWORK'),
      memory: value(env, 'SANDBOX_MEMORY'),
      cpus: value(env, 'SANDBOX_CPUS'),
    });
  }
  return {
    id: 'env-sandbox',
    capability: 'sandbox',
    kind: adapter.kind,
    preset: preset?.id ?? null,
    name: preset?.label ?? adapter.label,
    config: { ...preset?.config, ...config },
    secrets: compact({ apiKey: value(env, 'SANDBOX_API_KEY') }),
  };
}

function storageFromEnv(env: Env): EnvInstance | null {
  const kind = value(env, 'STORAGE_PROVIDER');
  if (!kind) return null;
  if (kind === 'local') {
    return {
      id: 'env-storage',
      capability: 'storage',
      kind: 'local',
      preset: null,
      name: findAdapter('storage', 'local')?.adapter.label ?? 'local',
      config: { root: value(env, 'STORAGE_ROOT') ?? 'data/files' },
      secrets: {},
    };
  }
  if (kind !== 's3') {
    logger.warn(`[providers] STORAGE_PROVIDER=${kind} is not supported; ignored`);
    return null;
  }
  return {
    id: 'env-storage',
    capability: 'storage',
    kind: 's3',
    preset: null,
    name: findAdapter('storage', 's3')?.adapter.label ?? 's3',
    config: {
      ...compact({ endpoint: value(env, 'STORAGE_ENDPOINT'), bucket: value(env, 'STORAGE_BUCKET') }),
      region: value(env, 'STORAGE_REGION') ?? 'us-east-1',
      prefix: value(env, 'STORAGE_PREFIX') ?? '',
      forcePathStyle: value(env, 'STORAGE_FORCE_PATH_STYLE') !== 'false',
    },
    secrets: compact({
      accessKeyId: value(env, 'STORAGE_ACCESS_KEY_ID'),
      secretAccessKey: value(env, 'STORAGE_SECRET_ACCESS_KEY'),
    }),
  };
}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** YAML is written in snake_case like the API; adapter config is camelCase. */
function camelKeys(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(camelKeys);
  if (!input || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input).map(([key, entry]) => [camel(key), camelKeys(entry)]));
}

interface FileInstance {
  id?: unknown;
  kind?: unknown;
  preset?: unknown;
  name?: unknown;
  api_key_env?: unknown;
  secrets_env?: Record<string, string>;
  [key: string]: unknown;
}

/** PROVIDERS_FILE: several instances per capability; secrets name env vars and are never written in it. */
function fromFile(env: Env, path: string): EnvProviders {
  const parsed = (parseYaml(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>;
  const instances: EnvInstance[] = [];
  for (const [section, list] of Object.entries(parsed)) {
    if (section === 'defaults' || section === 'policy') continue;
    const capability = section as Capability;
    if (!CAPABILITIES.includes(capability) || !Array.isArray(list)) {
      logger.warn(`[providers] ${path}: "${section}" is not a capability; ignored`);
      continue;
    }
    for (const entry of list as FileInstance[]) {
      const { id, kind, preset: presetId, name, api_key_env, secrets_env, ...config } = entry;
      if (typeof id !== 'string' || !INSTANCE_ID.test(id) || instances.some((other) => other.id === id)) {
        logger.warn(
          `[providers] ${path}: ${capability} instance id ${JSON.stringify(id)} is invalid or repeated; ignored`,
        );
        continue;
      }
      const found = typeof kind === 'string' ? findAdapter(capability, kind) : null;
      if (!found) {
        logger.warn(`[providers] ${path}: ${capability} instance ${id} has an unknown kind; ignored`);
        continue;
      }
      const preset =
        (typeof presetId === 'string' ? found.adapter.presets?.find((p) => p.id === presetId) : undefined) ??
        found.preset ??
        undefined;
      const secrets: Record<string, string> = {};
      if (typeof api_key_env === 'string' && value(env, api_key_env)) secrets.apiKey = value(env, api_key_env)!;
      for (const [field, variable] of Object.entries(secrets_env ?? {})) {
        if (value(env, variable)) secrets[camel(field)] = value(env, variable)!;
      }
      instances.push({
        id,
        capability,
        kind: found.adapter.kind,
        preset: preset?.id ?? null,
        name: typeof name === 'string' ? name : (preset?.label ?? id),
        config: { ...preset?.config, ...(camelKeys(config) as Record<string, unknown>) },
        secrets,
      });
    }
  }
  const policies: EnvProviders['policies'] = {};
  for (const [capability, policy] of Object.entries((parsed.policy ?? {}) as Record<string, Record<string, unknown>>)) {
    policies[capability as Capability] = {
      allowPersonal: policy.allow_personal === true,
      personalCountsTowardBudget: policy.personal_counts_toward_budget === true,
    };
  }
  return { instances, defaults: (parsed.defaults ?? {}) as EnvProviders['defaults'], policies };
}

export function providersFromEnv(env: Env): EnvProviders {
  const file = value(env, 'PROVIDERS_FILE');
  if (file) return fromFile(env, file);
  const instances: EnvInstance[] = [];
  const defaults: EnvProviders['defaults'] = {};
  const llm = llmFromEnv(env);
  if (llm) {
    instances.push(llm.instance);
    defaults.llm = llm.defaults;
  }
  for (const [capability, prefix] of [
    ['stt', 'STT'],
    ['tts', 'TTS'],
    ['image', 'IMAGE'],
  ] as const) {
    const instance = simpleFromEnv(env, capability, prefix);
    if (instance) instances.push(instance);
  }
  instances.push(...searchFromEnv(env));
  const storage = storageFromEnv(env);
  if (storage) instances.push(storage);
  const sandbox = sandboxFromEnv(env);
  if (sandbox) instances.push(sandbox);
  if (value(env, 'VIDEO_PROVIDER'))
    logger.warn('[providers] VIDEO_PROVIDER is not available in this build yet; ignored');
  return { instances, defaults, policies: {} };
}
