/**
 * Bot computer configuration — where computers run is `.env` infrastructure
 * (BOTS_COMPUTER_*: the Docker host, or a hosted sandbox provider with
 * BOTS_COMPUTER_DRIVER=e2b), the two live knobs are workspace settings
 * (`bots.computer_idle_minutes`, `bots.computer_max_running`), and two things
 * are the member's own: the browser language follows their account locale
 * (BOTS_COMPUTER_LANG overrides it for everyone) and the timezone is the one
 * their browser reported (`bot_computers.timezone`, else BOTS_COMPUTER_TZ).
 *
 * Docker: hardened is the default — gVisor (`runsc`) and a dedicated bridge with IPv6
 * and inter-container traffic off. The only way out is the local escape hatch
 * BOTS_COMPUTER_ALLOW_UNHARDENED=1, accepted only with NODE_ENV development or
 * test (mirrors cloud-agent/config.ts) — the same image then runs under runc on
 * a per-namespace bridge the API creates itself.
 *
 * E2B (BOTS_COMPUTER_DRIVER=e2b): each computer is a sandbox at an
 * E2B-protocol provider — E2B (default domain) or PPIO in China
 * (BOTS_COMPUTER_E2B_DOMAIN=cn-beijing-1.sandbox.ppio.com) — with the key in
 * BOTS_COMPUTER_E2B_API_KEY. A microVM per computer is the boundary, so there
 * is no unhardened mode and no Docker network; BOTS_COMPUTER_MEMORY /
 * BOTS_COMPUTER_CPUS size the template (whole vCPUs, an even MiB count).
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §6.1, §6.3 (+ review R3, R12).
 */

import { createHash } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';
import { getWorkspaceValue } from '../../settings/workspace-config.js';
import { IDLE_MINUTES_RANGE, MAX_RUNNING_RANGE } from './limits.js';

export const DEFAULT_COMPUTER_IMAGE = 'greenhouse/bot-computer:latest';

/** Docker network names a hardened computer may never join. */
const FORBIDDEN_HARDENED_NETWORKS = new Set(['bridge', 'host', 'none', 'default']);
/** Never valid, even in development: host networking exposes the host, none has no internet. */
const FORBIDDEN_NETWORKS = new Set(['host', 'none']);

export type ComputerConfigErrorReason =
  | 'unhardened_not_allowed'
  | 'runtime_not_hardened'
  | 'network_invalid'
  | 'config_invalid';

/** A BOTS_COMPUTER_* value that makes the computer unsafe or unusable; the runtime reports it as unavailable. */
export class ComputerConfigError extends Error {
  constructor(
    readonly reason: ComputerConfigErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'ComputerConfigError';
  }
}

export type ComputerDriver = 'docker' | 'e2b';

/** The hosted provider (BOTS_COMPUTER_DRIVER=e2b). */
export interface E2bConfig {
  apiKey: string;
  /** null = the SDK's default (e2b.app). */
  domain: string | null;
  /** The template's size (the provider fixes it per template, not per sandbox). */
  cpuCount: number;
  memoryMB: number;
}

export interface BotsComputerConfig {
  driver: ComputerDriver;
  /** Set exactly when `driver` is e2b. */
  e2b: E2bConfig | null;
  image: string;
  /** `docker run --runtime` — always passed explicitly (runsc unless unhardened). */
  runtime: string;
  /** False only under the development escape hatch. */
  hardened: boolean;
  network: string;
  /** True when `network` is the development default this API creates at boot. */
  networkManaged: boolean;
  /** `--memory` = `--memory-swap` (no swap: a thrashing browser is worse than a restarted one). */
  memory: string;
  memoryBytes: number;
  cpus: string;
  /** Optional egress proxy for the browser (`--proxy-server`) and the Bot's shell. */
  proxy: string | null;
  /** Keeps worktrees and blue/green slots apart on one Docker daemon; in names and labels. */
  namespace: string;
  /** The deployment default; a member's own (`bot_computers.timezone`) wins. */
  timezone: string;
  /** BOTS_COMPUTER_LANG — the operator's override of every member's browser language; null = per member. */
  lang: string | null;
  /**
   * How long running background jobs (gh-jobs) keep an otherwise idle computer
   * awake, counted from its last activity; 0 = never.
   */
  jobMaxHours: number;
  /** Mission's network, refused for computers (it allows the API port). */
  missionNetwork: string;
}

/** Range of BOTS_COMPUTER_JOB_MAX_HOURS (a week at most: a forgotten job must not hold a slot for ever). */
export const JOB_MAX_HOURS_RANGE = { min: 0, max: 168, fallback: 8 } as const;

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/**
 * On when BOTS_COMPUTER_ENABLED says so — or, when it says nothing, as soon as a sandbox
 * provider key is set (env, or Administration → Runtime Config → Bots): entering the key is
 * how an administrator turns hosted computers on. An explicit BOTS_COMPUTER_ENABLED=0 wins.
 */
export function isBotsComputerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.BOTS_COMPUTER_ENABLED?.trim();
  if (explicit) return flag(explicit);
  return Boolean(env.BOTS_COMPUTER_E2B_API_KEY?.trim());
}

/**
 * Default namespace: a short hash of the database identity (host:port/db). Two
 * blue/green slots share one database and therefore one namespace (they must
 * see the same computers); two worktrees with their own databases never
 * collide on a shared daemon.
 */
export function namespaceFromDatabaseUrl(databaseUrl: string | undefined): string {
  let identity = databaseUrl ?? 'greenhouse';
  try {
    if (databaseUrl) {
      const url = new URL(databaseUrl);
      identity = `${url.hostname}:${url.port || '5432'}${url.pathname}`;
    }
  } catch {
    /* not a URL — hash the raw value */
  }
  return createHash('sha256').update(identity).digest('hex').slice(0, 8);
}

const MEMORY_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

/** Parse a docker memory value (`512m`, `2g`, `1.5g`); null when malformed. */
export function parseMemoryBytes(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg])?$/i.exec(value.trim());
  if (!match) return null;
  const unit = MEMORY_UNITS[(match[2] ?? 'b').toLowerCase()]!;
  const bytes = Math.floor(Number(match[1]) * unit);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

function parseProxy(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ComputerConfigError('config_invalid', 'BOTS_COMPUTER_PROXY must be a proxy URL such as http://host:port');
  }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol)) {
    throw new ComputerConfigError('config_invalid', 'BOTS_COMPUTER_PROXY must use http, https, socks4 or socks5');
  }
  // Chromium's --proxy-server takes scheme://host:port; credentials there are ignored.
  if (url.username || url.password) {
    throw new ComputerConfigError('config_invalid', 'BOTS_COMPUTER_PROXY must not carry credentials');
  }
  return `${url.protocol}//${url.host}`;
}

function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** BOTS_COMPUTER_E2B_* (the sizes come from BOTS_COMPUTER_MEMORY / _CPUS). */
function loadE2bConfig(env: NodeJS.ProcessEnv, memoryBytes: number, cpus: string): E2bConfig {
  const apiKey = env.BOTS_COMPUTER_E2B_API_KEY?.trim() ?? '';
  if (!apiKey) {
    throw new ComputerConfigError(
      'config_invalid',
      'BOTS_COMPUTER_DRIVER=e2b needs BOTS_COMPUTER_E2B_API_KEY (the sandbox provider key)',
    );
  }
  const domain = env.BOTS_COMPUTER_E2B_DOMAIN?.trim().toLowerCase() || null;
  if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new ComputerConfigError(
      'config_invalid',
      'BOTS_COMPUTER_E2B_DOMAIN must be a domain such as cn-beijing-1.sandbox.ppio.com',
    );
  }
  // Providers take whole vCPUs (1–8) and an even number of MiB.
  const cpuCount = Math.min(8, Math.max(1, Math.ceil(Number(cpus))));
  const mib = Math.ceil(memoryBytes / 1024 ** 2);
  return { apiKey, domain, cpuCount, memoryMB: mib % 2 === 0 ? mib : mib + 1 };
}

/** Load and validate BOTS_COMPUTER_*. Throws ComputerConfigError for unsafe or malformed values. */
export function loadBotsComputerConfig(env: NodeJS.ProcessEnv = process.env): BotsComputerConfig {
  // Unset: hosted when a provider key is set (see isBotsComputerEnabled), this server's Docker otherwise.
  const driverRaw =
    env.BOTS_COMPUTER_DRIVER?.trim().toLowerCase() || (env.BOTS_COMPUTER_E2B_API_KEY?.trim() ? 'e2b' : 'docker');
  if (driverRaw !== 'docker' && driverRaw !== 'e2b') {
    throw new ComputerConfigError('config_invalid', 'BOTS_COMPUTER_DRIVER must be docker or e2b');
  }
  const driver: ComputerDriver = driverRaw;
  if (driver === 'e2b') return loadHostedConfig(env);
  const allowUnhardened = flag(env.BOTS_COMPUTER_ALLOW_UNHARDENED);
  if (allowUnhardened && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new ComputerConfigError(
      'unhardened_not_allowed',
      'BOTS_COMPUTER_ALLOW_UNHARDENED is allowed only with NODE_ENV=development or test',
    );
  }
  const hardened = !allowUnhardened;
  const runtime = env.BOTS_COMPUTER_RUNTIME?.trim() || 'runsc';
  if (hardened && runtime !== 'runsc') {
    throw new ComputerConfigError(
      'runtime_not_hardened',
      `BOTS_COMPUTER_RUNTIME=${runtime} needs BOTS_COMPUTER_ALLOW_UNHARDENED=1 (development only); production computers run on runsc`,
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runtime)) {
    throw new ComputerConfigError('config_invalid', 'BOTS_COMPUTER_RUNTIME is not a valid runtime name');
  }

  const namespace = loadNamespace(env);

  const missionNetwork = env.SANDBOX_RUNNER_NETWORK ?? env.CLOUD_AGENT_NETWORK ?? 'cloud-agent';
  const configuredNetwork = env.BOTS_COMPUTER_NETWORK?.trim() || null;
  if (configuredNetwork && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(configuredNetwork)) {
    throw new ComputerConfigError('network_invalid', 'BOTS_COMPUTER_NETWORK is not a valid Docker network name');
  }
  let network: string;
  let networkManaged = false;
  if (hardened) {
    if (!configuredNetwork) {
      throw new ComputerConfigError(
        'network_invalid',
        'BOTS_COMPUTER_NETWORK is required in hardened mode (a dedicated bridge with IPv6 and inter-container traffic off)',
      );
    }
    if (FORBIDDEN_HARDENED_NETWORKS.has(configuredNetwork) || configuredNetwork === missionNetwork) {
      throw new ComputerConfigError(
        'network_invalid',
        `BOTS_COMPUTER_NETWORK=${configuredNetwork} is not allowed; use a dedicated bridge for computers`,
      );
    }
    network = configuredNetwork;
  } else if (configuredNetwork) {
    if (FORBIDDEN_NETWORKS.has(configuredNetwork)) {
      throw new ComputerConfigError('network_invalid', `BOTS_COMPUTER_NETWORK=${configuredNetwork} is not allowed`);
    }
    network = configuredNetwork;
  } else {
    network = `gh-bots-${namespace}`;
    networkManaged = true;
  }

  return {
    driver,
    e2b: null,
    image: env.BOTS_COMPUTER_IMAGE?.trim() || DEFAULT_COMPUTER_IMAGE,
    runtime,
    hardened,
    network,
    networkManaged,
    proxy: parseProxy(env.BOTS_COMPUTER_PROXY),
    namespace,
    missionNetwork,
    ...loadCommon(env),
  };
}

/** BOTS_COMPUTER_DRIVER=e2b: no Docker runtime or network; the provider's microVM is the boundary. */
function loadHostedConfig(env: NodeJS.ProcessEnv): BotsComputerConfig {
  const common = loadCommon(env);
  return {
    driver: 'e2b',
    e2b: loadE2bConfig(env, common.memoryBytes, common.cpus),
    image: '',
    runtime: 'e2b',
    hardened: true,
    network: '',
    networkManaged: false,
    proxy: parseProxy(env.BOTS_COMPUTER_PROXY),
    namespace: loadNamespace(env),
    missionNetwork: env.SANDBOX_RUNNER_NETWORK ?? env.CLOUD_AGENT_NETWORK ?? 'cloud-agent',
    ...common,
  };
}

function loadNamespace(env: NodeJS.ProcessEnv): string {
  const namespace = env.BOTS_COMPUTER_NAMESPACE?.trim() || namespaceFromDatabaseUrl(env.DATABASE_URL);
  if (!/^[a-z0-9]{1,16}$/.test(namespace)) {
    throw new ComputerConfigError('config_invalid', 'BOTS_COMPUTER_NAMESPACE must be 1–16 lowercase letters or digits');
  }
  return namespace;
}

/** What both drivers read the same way: size, language, timezone, job hours. */
function loadCommon(
  env: NodeJS.ProcessEnv,
): Pick<BotsComputerConfig, 'memory' | 'memoryBytes' | 'cpus' | 'timezone' | 'lang' | 'jobMaxHours'> {
  const memory = env.BOTS_COMPUTER_MEMORY?.trim() || '2g';
  const memoryBytes = parseMemoryBytes(memory);
  if (memoryBytes === null || memoryBytes < 512 * 1024 ** 2) {
    throw new ComputerConfigError(
      'config_invalid',
      'BOTS_COMPUTER_MEMORY must be a docker memory value of at least 512m',
    );
  }
  const cpus = env.BOTS_COMPUTER_CPUS?.trim() || '1.5';
  if (!/^\d+(\.\d+)?$/.test(cpus) || Number(cpus) <= 0) {
    throw new ComputerConfigError('config_invalid', 'BOTS_COMPUTER_CPUS must be a positive number');
  }
  const lang = env.BOTS_COMPUTER_LANG?.trim() || null;
  if (lang && !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(lang)) {
    throw new ComputerConfigError('config_invalid', 'BOTS_COMPUTER_LANG must be a language tag such as zh-CN');
  }
  const timezone = env.BOTS_COMPUTER_TZ?.trim() || env.TZ?.trim() || hostTimezone();
  if (!/^[A-Za-z0-9_+\-/]+$/.test(timezone)) {
    throw new ComputerConfigError('config_invalid', 'BOTS_COMPUTER_TZ must be an IANA time zone');
  }
  const jobMaxHoursRaw = env.BOTS_COMPUTER_JOB_MAX_HOURS?.trim() || String(JOB_MAX_HOURS_RANGE.fallback);
  const jobMaxHours = Number(jobMaxHoursRaw);
  if (!/^\d+$/.test(jobMaxHoursRaw) || jobMaxHours < JOB_MAX_HOURS_RANGE.min || jobMaxHours > JOB_MAX_HOURS_RANGE.max) {
    throw new ComputerConfigError(
      'config_invalid',
      `BOTS_COMPUTER_JOB_MAX_HOURS must be a whole number of hours from ${JOB_MAX_HOURS_RANGE.min} to ${JOB_MAX_HOURS_RANGE.max}`,
    );
  }
  return { memory, memoryBytes, cpus, timezone, lang, jobMaxHours };
}

// ─── Per member: browser language and timezone ───────────

/**
 * The browser language a member's computer starts with (BCP 47): the
 * operator's BOTS_COMPUTER_LANG when set, else the member's account locale —
 * any Chinese locale is zh-CN, everything else en-US.
 */
export function computerLang(operatorLang: string | null, locale: string | null | undefined): string {
  if (operatorLang) return operatorLang;
  return locale?.trim().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

/** Longest timezone a member may store (IANA names are far shorter). */
export const TIMEZONE_MAX_CHARS = 64;

/**
 * A member's timezone as the computer will use it (`TZ`, Chromium), or null
 * when it is not an IANA zone name: at most 64 characters a zone name uses —
 * starting with a letter, so no raw offsets (`TZ=+08:00` means something else
 * entirely) — and a zone Intl knows. Only the letter case is normalised
 * (`asia/shanghai` would not resolve on the container's case-sensitive zone
 * files); aliases stay as given, so a browser that reports its own zone sees
 * the same string back and never re-sends it.
 */
export function parseTimezone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > TIMEZONE_MAX_CHARS || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat(undefined, { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return resolved.toLowerCase() === value.toLowerCase() ? resolved : value;
}

// ─── Greenhouse's own origins (Chromium URLBlocklist) ─────

/** `scheme://host[:port]` → a URLBlocklist pattern (`host[:port]`, every scheme and path). */
function blocklistPattern(origin: string): string | null {
  try {
    const url = new URL(origin.includes('://') ? origin : `https://${origin}`);
    if (!url.hostname) return null;
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return null;
  }
}

/**
 * Cloud metadata endpoints (AWS/GCP/Azure/OpenStack, Alibaba Cloud): blocked
 * in the browser as well, so even a development computer's browser cannot
 * fetch instance credentials. Defence in depth only — URLBlocklist sees host
 * names and literals, not the shell or DNS rebinding.
 */
const METADATA_HOSTS = ['169.254.169.254', 'metadata.google.internal', '100.100.100.200'];

/**
 * URLBlocklist patterns that keep a computer's browser away from greenhouse
 * itself: an approval card a Bot could click in its own browser would be no
 * approval at all. Covers the configured public/web origins, CORS origins and
 * the host's ports as seen from a container (host.docker.internal), plus the
 * cloud metadata endpoints. Raw host and private IPs are the hardened
 * network's job: the egress rules (`scripts/cloud-agent-net.sh --profile
 * bots`, zero allow rows) that the runtime precheck verifies and every new
 * computer re-proves (runtime.ts, controller.ts). `extra` adds patterns
 * discovered at runtime (the bridge gateway).
 */
export function greenhouseUrlBlocklist(env: NodeJS.ProcessEnv = process.env, extra: string[] = []): string[] {
  const patterns = new Set<string>(METADATA_HOSTS);
  const origins = [env.PUBLIC_BASE_URL, env.WEB_BASE_URL, ...(env.CORS_ALLOWED_ORIGINS ?? '').split(',')];
  for (const origin of origins) {
    const value = origin?.trim();
    if (!value) continue;
    const pattern = blocklistPattern(value);
    if (pattern) patterns.add(pattern);
  }
  for (const port of [env.API_PORT, env.WEB_PORT, env.PORT]) {
    if (port && /^\d{1,5}$/.test(port.trim())) patterns.add(`host.docker.internal:${port.trim()}`);
  }
  for (const pattern of extra) if (pattern) patterns.add(pattern);
  // Commas separate entries in GH_COMPUTER_URL_BLOCKLIST; a pattern never contains one.
  return [...patterns].filter((p) => !p.includes(',')).sort();
}

// ─── Live knobs (workspace settings) ──────────────────────

export { IDLE_MINUTES_RANGE, MAX_RUNNING_RANGE };

function parseIntegerInRange(raw: unknown, range: { min: number; max: number }): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= range.min && value <= range.max ? value : null;
}

/** `bots.computer_idle_minutes`: an integer 5–240; null when invalid. */
export function parseIdleMinutes(raw: unknown): number | null {
  return parseIntegerInRange(raw, IDLE_MINUTES_RANGE);
}

/** `bots.computer_max_running`: an integer 1–50; null when invalid. */
export function parseMaxRunning(raw: unknown): number | null {
  return parseIntegerInRange(raw, MAX_RUNNING_RANGE);
}

/** Memory left to the host itself (Postgres, the API, Mission) before computers are counted. */
const HOST_MEMORY_RESERVE_BYTES = 4 * 1024 ** 3;

/**
 * The effective concurrency: the setting, capped by what the Docker host's
 * memory can hold at `--memory` each (after a 4 GiB reserve, never below 1).
 * Unknown host memory leaves the setting as is.
 */
export function clampMaxRunning(setting: number, memTotalBytes: number | null, memoryBytes: number): number {
  if (!memTotalBytes || memTotalBytes <= 0) return setting;
  const fits = Math.max(1, Math.floor((memTotalBytes - HOST_MEMORY_RESERVE_BYTES) / memoryBytes));
  return Math.min(setting, fits);
}

export interface ComputerKnobs {
  idleMinutes: number;
  /** The configured value before the memory clamp. */
  maxRunningSetting: number;
}

/** Read the two knobs (DB → env → default); a malformed stored value falls back to the default. */
export async function resolveComputerKnobs(): Promise<ComputerKnobs> {
  const [idleRaw, maxRaw] = await Promise.all([
    getWorkspaceValue('bots.computer_idle_minutes').catch(() => undefined),
    getWorkspaceValue('bots.computer_max_running').catch(() => undefined),
  ]);
  const idleMinutes = idleRaw === undefined ? IDLE_MINUTES_RANGE.fallback : parseIdleMinutes(idleRaw);
  const maxRunning = maxRaw === undefined ? MAX_RUNNING_RANGE.fallback : parseMaxRunning(maxRaw);
  if (idleMinutes === null) logger.warn('[bots-computer] bots.computer_idle_minutes is invalid; using 15');
  if (maxRunning === null) logger.warn('[bots-computer] bots.computer_max_running is invalid; using 2');
  return {
    idleMinutes: idleMinutes ?? IDLE_MINUTES_RANGE.fallback,
    maxRunningSetting: maxRunning ?? MAX_RUNNING_RANGE.fallback,
  };
}
