/**
 * Module usage counters — the shared vocabulary of `usage_counters`.
 *
 * Counts only (no users, arguments or content), written by the API and read by
 * Administration › Usage. Two kinds:
 *   tool_call  key = catalog tool id,  client = the surface that executed it
 *   page_open  key = a page module id, client = the app that showed it
 *
 * Page module ids are a closed list so a client cannot write arbitrary keys:
 * `PAGE_MODULE_IDS` (core, pinned to the web navigation registry by
 * apps/web/src/lib/usage/page-module.test.ts) plus `ext.<id>` for every
 * extension active on this deployment.
 */

/**
 * Surfaces that execute tools. `browser` still labels turns in conversations the
 * browser extension started; `subagent` (sub-sessions, removed in 1.5) is kept
 * so counts recorded before then still read back.
 */
export const TOOL_CALL_CLIENTS = [
  'mcp',
  'agent_api',
  'web_chat',
  'browser',
  'mobile',
  'feishu',
  'automation',
  'subagent',
] as const;
export type ToolCallClient = (typeof TOOL_CALL_CLIENTS)[number];

/**
 * Apps that show pages. `desktop` and `browser` are kept so counts recorded
 * before the desktop app and the browser extension were removed (1.5) still
 * read back; nothing new is labelled with them.
 */
export const PAGE_OPEN_CLIENTS = ['web', 'desktop', 'mobile', 'browser'] as const;
export type PageOpenClient = (typeof PAGE_OPEN_CLIENTS)[number];

/**
 * Request header a first-party app sets on its API calls: `mobile`. Absent means
 * the plain web app. It only labels counts — never an authorization input.
 */
export const APP_CLIENT_HEADER = 'X-Greenhouse-Client';

/** The app named by `APP_CLIENT_HEADER`, or null for the plain web app / anything unknown. */
export function parseAppClient(value: string | null | undefined): 'mobile' | null {
  return value?.trim().toLowerCase() === 'mobile' ? 'mobile' : null;
}

/**
 * Core page modules. Top-level pages use their route name; Settings and
 * Administration use their navigation module id. Retired modules (the session
 * tags / groups organizers; `tasks` — My prompts, now a SkillHub tab counted as
 * `skillhub`; `agents` — My Agents, now an Automations tab counted as
 * `automations` — all 1.5) are no longer accepted; counts already recorded
 * under them still read back in Administration › Usage.
 */
export const PAGE_MODULE_IDS = [
  'home',
  'chat',
  'knowledge',
  'projects',
  'tables',
  'files',
  'automations',
  'skillhub',
  'activity',
  'settings.preferences',
  'settings.groups',
  'settings.agent-connections',
  'settings.provider-bindings',
  'settings.email-accounts',
  'settings.memory',
  'settings.my-usage',
  'settings.computer',
  'admin.users',
  'admin.runtime-config',
  'admin.branding',
  'admin.usage',
  'admin.services',
  'admin.issues',
  'admin.activity',
  'admin.mcp-keys',
  'admin.team-context',
] as const;
export type CorePageModuleId = (typeof PAGE_MODULE_IDS)[number];

const CORE_PAGE_MODULES = new Set<string>(PAGE_MODULE_IDS);
const EXTENSION_MODULE_PREFIX = 'ext.';

/** Every page an extension contributes (page, page modules, Settings / Administration modules) counts as one module. */
export function extensionPageModuleId(extensionId: string): string {
  return `${EXTENSION_MODULE_PREFIX}${extensionId}`;
}

/** True for a core module id or `ext.<id>` of an active extension. */
export function isPageModuleId(value: unknown, activeExtensionIds: Iterable<string>): value is string {
  if (typeof value !== 'string') return false;
  if (CORE_PAGE_MODULES.has(value)) return true;
  if (!value.startsWith(EXTENSION_MODULE_PREFIX)) return false;
  const id = value.slice(EXTENSION_MODULE_PREFIX.length);
  if (!id) return false;
  for (const active of activeExtensionIds) if (active === id) return true;
  return false;
}

/** Ranges Administration › Usage offers for module counts. */
export const USAGE_RANGE_DAYS = [7, 30, 90] as const;
export type UsageRangeDays = (typeof USAGE_RANGE_DAYS)[number];

export interface UsageCountRow {
  key: string;
  client: string;
  count: number;
}

export interface ModelCacheHitRow {
  model: string;
  calls: number;
  input_tokens: number;
  cached_tokens: number;
  /** cached_tokens / input_tokens; null when the model saw no input tokens. */
  hit_rate: number | null;
}

/** `GET /api/admin/usage/modules?days=` */
export interface ModuleUsageReport {
  days: UsageRangeDays;
  /** Inclusive UTC days, `YYYY-MM-DD`. */
  from: string;
  to: string;
  tool_calls: UsageCountRow[];
  page_opens: UsageCountRow[];
  cache_by_model: ModelCacheHitRow[];
}
