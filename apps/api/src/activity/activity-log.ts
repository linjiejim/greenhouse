/**
 * Activity log (操作记录) — one stream of changes from the records Greenhouse
 * already keeps:
 *
 *   person      platform_audit_events, actor_type 'human', the COMMAND actions of
 *               every registered application (reads are audited too and are not
 *               activity), drive changes (drive/audit.ts) and a member connecting
 *               or disconnecting an agent;
 *   agent       runtime_runs kind 'agent_write' — members' own agents over MCP,
 *               with the client's name (agent-access/governed-write.ts);
 *   automation  runtime_runs kind 'automation';
 *   admin       platform_audit_events of the admin actions listed below
 *               (workspace settings, user access, MCP machine clients).
 *
 * Who sees what: a member sees their own changes (and their agents' and
 * automations'); a super sees everyone's and may narrow to one person. Admin
 * changes are super-only. Every query is bounded by a time window
 * (ACTIVITY_MAX_DAYS) and a page limit, and pages merge on one cursor.
 *
 * Objects are named only when the viewer may read them (knowledge through
 * resolveKbAccess, projects by visibility/membership, files by shelf); other
 * targets show their id. Admin details carry setting KEY names, never values.
 */

import { Buffer } from 'node:buffer';
import type { ActivityAuditRow, ActivityCursor, ActivityRunRow, DatabaseProvider } from '@greenhouse/db';
import type { ApplicationManifest } from '@greenhouse/platform-kernel';
import {
  ACTIVITY_DEFAULT_DAYS,
  ACTIVITY_MAX_DAYS,
  ACTIVITY_PAGE_LIMIT,
  ACTIVITY_SOURCES,
  type ActivityItem,
  type ActivityPage,
  type ActivitySource,
  type ActivityStatus,
  type ActivityVerb,
} from '@greenhouse/types/activity';
import { entityUrl } from '@greenhouse/types/entity-links';
import { filesPageHref, shelfOfVisibility } from '@greenhouse/types/files';
import { safeJsonParse } from '@greenhouse/utils/json';

/** A JSON object column, or {} for anything else. */
function jsonObject(text: string | null): Record<string, unknown> {
  const value = safeJsonParse(text, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
import { canRead as canReadKb, resolveKbAccess } from '../knowledge/access.js';
import { targetLabel as agentWriteTargetLabel } from '../agent-access/governed-write.js';
import { DRIVE_AUDIT_APP_ID, type DriveChangeAction } from '../drive/audit.js';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';
import { MUTATING_PROXY_ALLOWLIST } from '../tools/registry.js';

export interface ActivityViewer {
  id: string;
  role: string;
}

// ─── What counts as a change ─────────────────────────────

const DRIVE_ACTIONS: readonly DriveChangeAction[] = [
  'createFolder',
  'updateFolder',
  'deleteFolder',
  'uploadFile',
  'updateFile',
  'deleteFile',
];

/** A member connecting or disconnecting one of their agents. */
const PERSONAL_PLATFORM_ACTIONS = ['authorizeOAuthClient', 'revokeOAuthGrant'] as const;

/** Administrator changes, by Activity module. */
const ADMIN_ACTIONS: Record<'settings' | 'users' | 'mcp', readonly string[]> = {
  settings: ['updateWorkspaceSettings'],
  users: [
    'setUserFeature',
    'issueAccountInvite',
    'issuePasswordReset',
    'resendAccountPasswordLink',
    'setUserPasswordDirectly',
    'revokeAccountPasswordLink',
  ],
  mcp: [
    'createOAuthMachineClient',
    'rotateOAuthClientSecret',
    'deleteOAuthClient',
    'disableOAuthClient',
    'enableOAuthClient',
  ],
};

const ADMIN_MODULE_BY_ACTION = new Map(
  Object.entries(ADMIN_ACTIONS).flatMap(([module, actions]) => actions.map((action) => [action, module] as const)),
);

/** Module of a platform application's audit row. */
function appModule(appId: string): string {
  return appId === DRIVE_AUDIT_APP_ID ? 'files' : appId;
}

const TOOL_MODULES: Record<string, string> = {
  knowledge_mutation: 'knowledge',
  files_mutation: 'files',
  project_mutation: 'projects',
  tables_mutation: 'tables',
  skill_mutation: 'skills',
  feature_request: 'feedback',
  log_friction: 'feedback',
  automation_mutation: 'automations',
};

/** Module of an agent write, by the tool it called; an extension tool files under its id prefix. */
export function moduleOfTool(toolId: string): string {
  return TOOL_MODULES[toolId] ?? toolId.split('_')[0] ?? 'other';
}

function commandActionsByApp(manifests: readonly ApplicationManifest[]): Map<string, string[]> {
  const byApp = new Map<string, string[]>();
  for (const manifest of manifests) {
    const commands = Object.values(manifest.actions)
      .filter((action) => action.kind === 'command')
      .map((action) => action.id);
    if (commands.length > 0) byApp.set(manifest.id, commands);
  }
  return byApp;
}

function actionTitles(manifests: readonly ApplicationManifest[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const manifest of manifests) {
    for (const action of Object.values(manifest.actions)) titles.set(`${manifest.id}:${action.id}`, action.title);
  }
  return titles;
}

const VERB_PATTERNS: Array<[RegExp, ActivityVerb]> = [
  [/^(delete|remove|purge|destroy|drop|revoke|disable)/, 'delete'],
  [/^(unarchive|restore|enable)/, 'restore'],
  [/^archive/, 'archive'],
  [/^(move|reorder)/, 'move'],
  [/^comment|comment$/, 'comment'],
  [/^(share|grant|authorize|invite|issue|manage)/, 'share'],
  [/^(create|add|insert|submit|upload|publish|log|append|import|duplicate|clone)/, 'create'],
  [/^(update|edit|set|rename|patch|change|rotate|resend|upsert|replace|convert)/, 'update'],
  [/^(run|trigger)/, 'run'],
];

/** The kind of change, from an action id (`updateProject`) or a tool action (`records.update`, `files.delete`). */
export function verbOf(action: string): ActivityVerb {
  const last = action.includes('.') ? action.slice(action.lastIndexOf('.') + 1) : action;
  const normalized = last.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  for (const [pattern, verb] of VERB_PATTERNS) if (pattern.test(normalized)) return verb;
  return 'other';
}

// ─── Filters ─────────────────────────────────────────────

export interface ActivityQuery {
  source?: string | null;
  module?: string | null;
  userId?: string | null;
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

interface ResolvedQuery {
  sources: ActivitySource[];
  module: string | null;
  /** null = everyone (super only). */
  userId: string | null;
  from: string;
  to: string;
  cursor: ActivityCursor | null;
  limit: number;
}

export class ActivityQueryError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTime(raw: string | null | undefined, name: string): number | null {
  if (!raw) return null;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) throw new ActivityQueryError(`${name} is not a valid date`);
  return time;
}

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string | null | undefined): ActivityCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof value.at === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at) &&
      typeof value.key === 'string' &&
      /^[ar]:[A-Za-z0-9_.:-]{1,200}$/.test(value.key)
    ) {
      return { at: value.at, key: value.key };
    }
  } catch {
    // fall through
  }
  throw new ActivityQueryError('cursor is malformed');
}

export function resolveActivityQuery(viewer: ActivityViewer, query: ActivityQuery, now = Date.now()): ResolvedQuery {
  const isSuper = viewer.role === 'super';
  let sources: ActivitySource[] = [...ACTIVITY_SOURCES];
  if (query.source) {
    if (!(ACTIVITY_SOURCES as readonly string[]).includes(query.source)) {
      throw new ActivityQueryError('source must be one of person, agent, automation, admin');
    }
    sources = [query.source as ActivitySource];
  }
  if (!isSuper) sources = sources.filter((source) => source !== 'admin');

  const to = parseTime(query.to, 'to') ?? now;
  const from = parseTime(query.from, 'from') ?? to - ACTIVITY_DEFAULT_DAYS * DAY_MS;
  if (from >= to) throw new ActivityQueryError('from must be before to');
  if (to - from > ACTIVITY_MAX_DAYS * DAY_MS) {
    throw new ActivityQueryError(`a window may span at most ${ACTIVITY_MAX_DAYS} days`);
  }
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? ACTIVITY_PAGE_LIMIT) || ACTIVITY_PAGE_LIMIT, 1), 200);

  return {
    sources,
    module: query.module?.trim() || null,
    // Members always see their own; a super sees everyone unless narrowed.
    userId: isSuper ? query.userId?.trim() || null : viewer.id,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    cursor: decodeCursor(query.cursor),
    limit,
  };
}

// ─── Fetch + merge ───────────────────────────────────────

type Pending =
  | { kind: 'audit'; source: 'person' | 'admin'; row: ActivityAuditRow }
  | { kind: 'run'; source: 'agent' | 'automation'; row: ActivityRunRow };

async function fetchPending(
  db: DatabaseProvider,
  q: ResolvedQuery,
  manifests: readonly ApplicationManifest[],
): Promise<Pending[]> {
  const window = { from: q.from, to: q.to, cursor: q.cursor, limit: q.limit + 1 };
  const wants = (module: string) => !q.module || q.module === module;
  const jobs: Array<Promise<Pending[]>> = [];

  if (q.sources.includes('person')) {
    const actions: Array<{ appId: string; actionIds: readonly string[]; moduleId?: string }> = [];
    for (const [appId, actionIds] of commandActionsByApp(manifests)) {
      if (wants(appModule(appId))) actions.push({ appId, actionIds });
    }
    if (wants('files')) actions.push({ appId: DRIVE_AUDIT_APP_ID, actionIds: DRIVE_ACTIONS });
    if (wants('mcp')) actions.push({ appId: 'platform', actionIds: PERSONAL_PLATFORM_ACTIONS });
    jobs.push(
      db.activity
        .listAuditChanges({ ...window, orgId: PLATFORM_ORG_ID, actions, actorType: 'human', userId: q.userId })
        .then((rows) => rows.map((row) => ({ kind: 'audit', source: 'person', row }) as const)),
    );
  }

  if (q.sources.includes('admin')) {
    const actions = Object.entries(ADMIN_ACTIONS)
      .filter(([module]) => wants(module))
      .map(([, actionIds]) => ({ appId: 'platform', actionIds }));
    jobs.push(
      db.activity
        .listAuditChanges({ ...window, orgId: PLATFORM_ORG_ID, actions, actorType: 'human', userId: q.userId })
        .then((rows) => rows.map((row) => ({ kind: 'audit', source: 'admin', row }) as const)),
    );
  }

  if (q.sources.includes('agent')) {
    const toolIds = q.module ? [...MUTATING_PROXY_ALLOWLIST].filter((id) => moduleOfTool(id) === q.module) : null;
    jobs.push(
      db.activity
        .listRuns({ ...window, kinds: ['agent_write'], ownerUserId: q.userId, toolIds })
        .then((rows) => rows.map((row) => ({ kind: 'run', source: 'agent', row }) as const)),
    );
  }

  if (q.sources.includes('automation') && wants('automations')) {
    jobs.push(
      db.activity
        .listRuns({ ...window, kinds: ['automation'], ownerUserId: q.userId })
        .then((rows) => rows.map((row) => ({ kind: 'run', source: 'automation', row }) as const)),
    );
  }

  const merged = (await Promise.all(jobs)).flat();
  // Newest first on the shared order: fixed-width UTC timestamps, then the key, byte-wise.
  merged.sort((a, b) => (a.row.at === b.row.at ? cmp(b.row.key, a.row.key) : cmp(b.row.at, a.row.at)));
  return merged;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── Hydrate ─────────────────────────────────────────────

interface HydrateContext {
  db: DatabaseProvider;
  viewer: ActivityViewer;
  titles: Map<string, string>;
  names: Map<string, string | null>;
}

async function userNames(db: DatabaseProvider, ids: Iterable<string>): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const users = await Promise.all(unique.map((id) => db.users.getById(id).catch(() => undefined)));
  return new Map(unique.map((id, index) => [id, users[index]?.nickname ?? null]));
}

async function knowledgeTarget(ctx: HydrateContext, recordId: string) {
  try {
    // The kernel records either the numeric id or the doc slug, depending on the caller.
    const doc = /^\d+$/.test(recordId)
      ? await ctx.db.knowledgeBase.getById(Number(recordId))
      : await ctx.db.knowledgeBase.get(recordId, 'shared');
    if (!doc || !canReadKb(await resolveKbAccess(ctx.db, doc, ctx.viewer.id))) return null;
    return { label: doc.title, url: entityUrl({ kind: 'kb_doc', id: doc.id, slug: doc.doc_id }) };
  } catch {
    return null;
  }
}

async function projectReadable(ctx: HydrateContext, projectId: number) {
  const project = await ctx.db.projects.getProjectById(projectId);
  if (!project) return null;
  if (ctx.viewer.role === 'super' || project.visibility === 'public') return project;
  const members = await ctx.db.projects.getMembers(project.id);
  return members.some((member) => member.user_id === ctx.viewer.id) ? project : null;
}

async function projectTarget(ctx: HydrateContext, entity: string | null, recordId: string) {
  const id = Number(recordId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  try {
    if (entity === 'project') {
      const project = await projectReadable(ctx, id);
      return project ? { label: project.title, url: entityUrl({ kind: 'project', id: project.id }) } : null;
    }
    if (entity === 'task') {
      const task = await ctx.db.projects.getTaskById(id);
      const project = task ? await projectReadable(ctx, task.project_id) : null;
      return task && project ? { label: task.title, url: entityUrl({ kind: 'project', id: project.id }) } : null;
    }
  } catch {
    // A label is a convenience; the id is always shown.
  }
  return null;
}

function driveTarget(ctx: HydrateContext, entity: string | null, recordId: string, summary: Record<string, unknown>) {
  const visibility = summary.visibility === 'private' ? 'private' : summary.visibility === 'team' ? 'team' : null;
  const mine = typeof summary.owner_user_id === 'string' && summary.owner_user_id === ctx.viewer.id;
  if (summary.scope !== 'kb' || !(visibility === 'team' || mine) || typeof summary.name !== 'string') return null;
  const shelf = shelfOfVisibility(visibility);
  const id = Number(recordId);
  const url =
    entity === 'folder' ? filesPageHref({ shelf, folderId: id }) : entity === 'file' ? filesPageHref({ shelf }) : null;
  return { label: summary.name, url };
}

function adminDetail(row: ActivityAuditRow, summary: Record<string, unknown>): string | null {
  const keys = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
  if (row.action_id === 'updateWorkspaceSettings') {
    // Key names only — some of these settings are secrets.
    const changed = [...keys(summary.set), ...keys(summary.cleared)];
    return changed.length > 0 ? changed.join(', ') : null;
  }
  if (row.action_id === 'setUserFeature' && typeof summary.feature === 'string') {
    return `${summary.feature}: ${summary.enabled === false ? 'off' : 'on'}`;
  }
  return null;
}

async function hydrateAudit(
  ctx: HydrateContext,
  source: 'person' | 'admin',
  row: ActivityAuditRow,
): Promise<ActivityItem> {
  const summary = jsonObject(row.summary);
  const module =
    source === 'admin'
      ? (ADMIN_MODULE_BY_ACTION.get(row.action_id) ?? 'settings')
      : row.app_id === 'platform'
        ? 'mcp'
        : appModule(row.app_id);
  let target: ActivityItem['target'] = row.record_id ? { id: row.record_id, label: null, url: null } : null;
  if (row.record_id) {
    const resolved =
      row.app_id === 'knowledge'
        ? await knowledgeTarget(ctx, row.record_id)
        : row.app_id === 'projects'
          ? await projectTarget(ctx, row.entity_id, row.record_id)
          : row.app_id === DRIVE_AUDIT_APP_ID
            ? driveTarget(ctx, row.entity_id, row.record_id, summary)
            : row.app_id === 'platform' && row.entity_id === 'user'
              ? { label: ctx.names.get(row.record_id) ?? null, url: null }
              : null;
    if (resolved) target = { id: row.record_id, ...resolved };
  }
  return {
    id: row.key,
    source,
    at: row.at,
    actor: { id: row.actor_id, name: ctx.names.get(row.actor_id) ?? null },
    agent: null,
    module,
    verb: verbOf(row.action_id),
    entity: row.entity_id,
    action: row.action_id,
    action_title: ctx.titles.get(`${row.app_id}:${row.action_id}`) ?? null,
    target,
    status: null,
    run: null,
    detail: source === 'admin' ? adminDetail(row, summary) : null,
  };
}

function runStatus(row: ActivityRunRow): ActivityStatus {
  if (row.status === 'succeeded') return 'succeeded';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'canceled') return 'canceled';
  if (row.status === 'interrupted') return row.kind === 'agent_write' ? 'outcome_unknown' : 'failed';
  return 'running';
}

async function hydrateRun(
  ctx: HydrateContext,
  source: 'agent' | 'automation',
  row: ActivityRunRow,
): Promise<ActivityItem> {
  const input = jsonObject(row.input);
  const base = {
    id: row.key,
    source,
    at: row.at,
    actor: { id: row.owner_user_id, name: ctx.names.get(row.owner_user_id) ?? null },
    status: runStatus(row),
    run: { id: row.id, kind: row.kind },
    detail: row.error_message,
  };
  if (source === 'agent') {
    const toolId = typeof input.tool_id === 'string' ? input.tool_id : 'unknown';
    const action = typeof input.action === 'string' ? input.action : toolId;
    // Named only when the VIEWER may read it — a super must not learn the title
    // of a member's private document through that member's agent write.
    const label = await agentWriteTargetLabel(ctx.db, ctx.viewer.id, toolId, input.input).catch(() => null);
    return {
      ...base,
      agent: {
        client_id: typeof input.client_id === 'string' ? input.client_id : null,
        client_name: typeof input.client_name === 'string' ? input.client_name : 'Agent',
      },
      module: moduleOfTool(toolId),
      verb: verbOf(action),
      entity: null,
      action,
      action_title: null,
      target: label ? { id: null, label, url: null } : null,
    };
  }
  const task =
    input.task && typeof input.task === 'object' && !Array.isArray(input.task)
      ? (input.task as Record<string, unknown>)
      : {};
  const name = typeof task.name === 'string' ? task.name : typeof input.title === 'string' ? input.title : null;
  return {
    ...base,
    agent: null,
    module: 'automations',
    verb: 'run',
    entity: 'automation',
    action: 'run',
    action_title: null,
    target: name ? { id: null, label: name, url: '#/automations' } : null,
  };
}

export interface ActivityDeps {
  manifests: readonly ApplicationManifest[];
}

/** One page of the activity log for this viewer. */
export async function listActivity(
  db: DatabaseProvider,
  viewer: ActivityViewer,
  query: ActivityQuery,
  deps: ActivityDeps,
): Promise<ActivityPage> {
  const q = resolveActivityQuery(viewer, query);
  const pending = await fetchPending(db, q, deps.manifests);
  const page = pending.slice(0, q.limit);
  const last = page.at(-1);

  const people = page.flatMap((entry) =>
    entry.kind === 'audit'
      ? [entry.row.actor_id, ...(entry.row.app_id === 'platform' && entry.row.record_id ? [entry.row.record_id] : [])]
      : [entry.row.owner_user_id],
  );
  const ctx: HydrateContext = {
    db,
    viewer,
    titles: actionTitles(deps.manifests),
    names: await userNames(db, people),
  };
  const items = await Promise.all(
    page.map((entry) =>
      entry.kind === 'audit' ? hydrateAudit(ctx, entry.source, entry.row) : hydrateRun(ctx, entry.source, entry.row),
    ),
  );
  return {
    items,
    next_cursor: pending.length > q.limit && last ? encodeActivityCursor({ at: last.row.at, key: last.row.key }) : null,
    window: { from: q.from, to: q.to },
  };
}

// ─── CSV ─────────────────────────────────────────────────

const CSV_COLUMNS = ['time', 'source', 'person', 'agent', 'module', 'action', 'target', 'status', 'detail'] as const;

function csvCell(value: string | null | undefined): string {
  const text = value ?? '';
  // Neutralize spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function activityCsvRows(items: readonly ActivityItem[]): string[] {
  return items.map((item) =>
    [
      item.at,
      item.source,
      item.actor.name ?? item.actor.id,
      item.agent?.client_name ?? '',
      item.module,
      item.action_title ?? item.action,
      item.target?.label ?? item.target?.id ?? '',
      item.status ?? '',
      item.detail ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
}

export const ACTIVITY_CSV_HEADER = CSV_COLUMNS.join(',');
