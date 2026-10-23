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

/** Surfaces that execute tools. */
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
 * Apps that show pages. `desktop` is kept so counts recorded before the desktop
 * app was removed (1.5) still read back; nothing writes it any more.
 */
export const PAGE_OPEN_CLIENTS = ['web', 'desktop', 'mobile', 'browser'] as const;
export type PageOpenClient = (typeof PAGE_OPEN_CLIENTS)[number];

/**
 * Request header a first-party app sets on its API calls: `mobile` or `browser`
 * (the extension). Absent means the plain web app. It only labels counts — never
 * an authorization input.
 */
export const APP_CLIENT_HEADER = 'X-Greenhouse-Client';
const APP_CLIENTS = new Set<string>(['mobile', 'browser']);

/** The app named by `APP_CLIENT_HEADER`, or null for the plain web app / anything unknown. */
export function parseAppClient(value: string | null | undefined): 'mobile' | 'browser' | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return APP_CLIENTS.has(normalized) ? (normalized as 'mobile' | 'browser') : null;
}

/**
 * Core page modules. Top-level pages use their route name; Settings and
 * Administration use their navigation module id. `session-tags` /
 * `session-groups` are the chat-sidebar organizers (counted when their picker,
 * filter or manager opens), because they have no page of their own.
 */
export const PAGE_MODULE_IDS = [
  'chat',
  'knowledge',
  'projects',
  'tables',
  'automations',
  'tasks',
  'agents',
  'skillhub',
  'executions',
  'session-tags',
  'session-groups',
  'settings.preferences',
  'settings.groups',
  'settings.agent-connections',
  'settings.provider-bindings',
  'settings.email-accounts',
  'settings.memory',
  'admin.users',
  'admin.runtime-config',
  'admin.branding',
  'admin.usage',
  'admin.feature-requests',
  'admin.frictions',
  'admin.mcp-keys',
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
