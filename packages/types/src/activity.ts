/**
 * Activity log (操作记录) and the Home "recent changes" feed — the shared
 * vocabulary of `GET /api/activity` and `GET /api/activity/recent`.
 *
 * An item is one change: who made it, through which agent if any, what kind of
 * change, to what, and when. Sources:
 *   person      a member, in the app (platform audit)
 *   agent       a member's own agent over MCP (a recorded `agent_write` run)
 *   automation  a scheduled automation run
 *   admin       an administrator changing workspace settings, users or MCP access
 */

export const ACTIVITY_SOURCES = ['person', 'agent', 'automation', 'admin'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/** Core modules; an extension application appears under its own app id. */
export const ACTIVITY_MODULES = [
  'knowledge',
  'files',
  'projects',
  'tables',
  'skills',
  'feedback',
  'automations',
  'settings',
  'users',
  'mcp',
] as const;
export type CoreActivityModule = (typeof ACTIVITY_MODULES)[number];

export const ACTIVITY_VERBS = [
  'create',
  'update',
  'delete',
  'archive',
  'restore',
  'move',
  'comment',
  'share',
  'run',
  'other',
] as const;
export type ActivityVerb = (typeof ACTIVITY_VERBS)[number];

export type ActivityStatus = 'succeeded' | 'failed' | 'running' | 'outcome_unknown' | 'canceled';

export interface ActivityItem {
  /** Stable key of the record behind the item (also the page cursor's tiebreak). */
  id: string;
  source: ActivitySource;
  /** UTC ISO timestamp. */
  at: string;
  actor: { id: string; name: string | null };
  /** Set when a member's agent made the change. */
  agent: { client_id: string | null; client_name: string } | null;
  module: CoreActivityModule | (string & {});
  verb: ActivityVerb;
  /** What kind of thing changed (`project`, `task`, `document`, `file`, …), when known. */
  entity: string | null;
  /** The raw action (`updateProject`, `records.update`, `files.delete`, …). */
  action: string;
  /** Server-side English title of the action, for actions without a known verb/entity pair. */
  action_title: string | null;
  /** The object, named only when the viewer may read it. */
  target: { id: string | null; label: string | null; url: string | null } | null;
  /** Runs only. */
  status: ActivityStatus | null;
  /** The run behind an agent write or an automation, for its detail page. */
  run: { id: string; kind: string } | null;
  /** Extra one-line facts, e.g. the setting keys an admin changed (never their values). */
  detail: string | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  next_cursor: string | null;
  /** The time window actually applied (the API bounds it). */
  window: { from: string; to: string };
}

/** Days shown when no start is given, and the longest window one request may span. */
export const ACTIVITY_DEFAULT_DAYS = 30;
export const ACTIVITY_MAX_DAYS = 366;
export const ACTIVITY_PAGE_LIMIT = 50;
/** CSV export stops here; narrow the filters for more. */
export const ACTIVITY_EXPORT_MAX_ROWS = 5000;
