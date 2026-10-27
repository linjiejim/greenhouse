/**
 * `greenhouse.config.ts` — the typed, code-level configuration of one deployment.
 *
 * Configuration lives in three layers, each with one job:
 *
 *   `.env`                  secrets and infrastructure — DATABASE_URL, API keys, ports.
 *   Runtime Config (DB)     knobs admins change from the browser — LLM credentials,
 *                           product name, branding. Wins over env, applies live.
 *   `greenhouse.config.ts`  structure that only changes with a rebuild — which
 *                           extensions are on, where content packs live, how the
 *                           clients treat server stations.
 *
 * This module is dependency-free (types + `defineConfig`) so clients can import
 * the same shapes. The zod schema that validates a
 * config file at boot lives in `./config-schema` (server side only).
 */

/** One Greenhouse server as seen by a client (the universal client). */
export interface StationConfig {
  /** Stable id, lowercase letters / digits / dashes. */
  id: string;
  /** Display name shown in the station switcher. */
  name: string;
  /** Origin of the instance, e.g. `https://greenhouse.example.com` (no path). */
  url: string;
}

/**
 * How a client build treats server stations.
 *
 * - `multi` (OSS default): users add and switch stations freely; `defaults` are
 *   offered on first launch.
 * - `single`: the build is locked to exactly one station — no add / remove / switch
 *   UI, `defaults[0]` is the station. This is how a company build pins its own
 *   deployment.
 */
export interface ClientStationsConfig {
  mode: 'multi' | 'single';
  defaults: StationConfig[];
}

/** Which compiled extensions are active in this deployment. */
export interface ExtensionsConfig {
  /**
   * `'all'` enables every plugin compiled into this build (`plugins` above); an id list
   * enables only those. The
   * `GREENHOUSE_EXTENSIONS` env var (comma list or `all`) overrides this at boot so
   * one image can be trimmed per deployment.
   */
  enabled: 'all' | string[];
}

/**
 * Content packs: directories with first-party content that is synced or imported
 * at boot / by the CLI. Paths are absolute or relative to the repository root.
 */
export interface PacksConfig {
  /** Extra skill-pack roots scanned like `skillhub/` (each `<root>/<group>/<name>/SKILL.md`). */
  skills: string[];
  /** Extra directories of agent profile manifests (`*.yaml`), merged after `apps/api/src/profiles`. */
  profiles: string[];
  /** Dataset directory used by `pnpm seed` instead of `data/examples`. */
  seeds?: string;
}

export interface GreenhouseConfig {
  /** Plugin package names or paths relative to the repository root, in registration order. */
  plugins: string[];
  conversations: { sharing: boolean };
  extensions: ExtensionsConfig;
  packs: PacksConfig;
  clients: { stations: ClientStationsConfig };
}

/** What a `greenhouse.config.ts` file may export — every section optional. */
export interface GreenhouseConfigInput {
  plugins?: string[];
  conversations?: { sharing?: boolean };
  extensions?: Partial<ExtensionsConfig>;
  packs?: Partial<PacksConfig>;
  clients?: { stations?: Partial<ClientStationsConfig> };
}

export const DEFAULT_GREENHOUSE_CONFIG: GreenhouseConfig = {
  plugins: [],
  conversations: { sharing: true },
  extensions: { enabled: 'all' },
  packs: { skills: [], profiles: [] },
  clients: { stations: { mode: 'multi', defaults: [] } },
};

/** Identity helper that gives `greenhouse.config.ts` its types without a runtime dependency. */
export function defineConfig(config: GreenhouseConfigInput): GreenhouseConfigInput {
  if (
    config.plugins !== undefined &&
    (!Array.isArray(config.plugins) || config.plugins.some((entry) => typeof entry !== 'string' || !entry.trim()))
  ) {
    throw new Error('plugins must be an array of non-empty package names or relative paths');
  }
  return config;
}

/** Shallow-merge a config file's input over the defaults (no validation — see `./config-schema`). */
export function mergeGreenhouseConfig(input: GreenhouseConfigInput | undefined): GreenhouseConfig {
  return {
    plugins: input?.plugins ?? [],
    conversations: { ...DEFAULT_GREENHOUSE_CONFIG.conversations, ...input?.conversations },
    extensions: { ...DEFAULT_GREENHOUSE_CONFIG.extensions, ...(input?.extensions ?? {}) },
    packs: { ...DEFAULT_GREENHOUSE_CONFIG.packs, ...(input?.packs ?? {}) },
    clients: {
      stations: { ...DEFAULT_GREENHOUSE_CONFIG.clients.stations, ...(input?.clients?.stations ?? {}) },
    },
  };
}

/** True when `id` is switched on by an `extensions.enabled` value. */
export function isExtensionEnabled(enabled: ExtensionsConfig['enabled'], id: string): boolean {
  return enabled === 'all' || enabled.includes(id);
}

/**
 * Parse the `GREENHOUSE_EXTENSIONS` env override: `all`, an empty string (none), or
 * a comma-separated id list. `undefined` means "not set".
 */
export function parseExtensionsEnv(value: string | undefined): ExtensionsConfig['enabled'] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === 'all' || trimmed === '*') return 'all';
  if (trimmed === '') return [];
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Assembly-time override; an explicitly empty value compiles a core without packages. */
export function parsePluginsEnv(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}
