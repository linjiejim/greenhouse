/**
 * Activity log (操作记录) — one stream of changes from the records Greenhouse
 * already keeps:
 *
 *   person      platform_audit_events, actor_type 'human', the COMMAND actions of
 *               every registered application (reads are audited too and are not
 *               activity), drive changes (drive/audit.ts) and a member connecting
 *               or disconnecting an agent;
 *   agent       runs kind 'agent_write' — members' own agents over MCP,
 *               with the client's name (agent-access/governed-write.ts);
 *   automation  runs kind 'automation';
 *   admin       platform_audit_events of the admin actions listed below
 *               (workspace settings, user access, MCP machine clients, a
 *               member's model gateway key revoked by a super).
 *
 * Who sees what: a member sees their own changes (and their agents' and
 * automations'); a super sees everyone's and may narrow to one person. Admin
 * changes are super-only. Every query is bounded by a time window
 * (ACTIVITY_MAX_DAYS) and a page limit, and pages merge on one cursor.
 *
 * Objects are named only when the viewer may read them (knowledge through
 * resolveKbAccess, projects by visibility/membership, files by shelf); other
 * targets show their id. A record that is gone is named from what its audit
 * kept only for a viewer who could read it (its own actor, or a super where a
 * super reads every such record). Admin details carry setting KEY names, never
 * values.
 *
 * Phrasing is shared with Home's recent changes: every item says a verb and
 * the kind of object (`describeToolWrite` for agent writes), so the same
 * change reads the same way in both places.
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

/** A JSON object column, or {} for anything else. */
function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
import { toRowId } from '@greenhouse/utils/id';
import { canRead as canReadKb, resolveKbAccess } from '../knowledge/access.js';
import { DRIVE_AUDIT_APP_ID, type DriveChangeAction } from '../drive/audit.js';
import { fromExtensions } from '../extensions/index.js';
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

/** A member connecting or disconnecting one of their agents, or creating / revoking a model gateway key. */
const PERSONAL_PLATFORM_ACTIONS = [
  'authorizeOAuthClient',
  'revokeOAuthGrant',
  'createGatewayKey',
  'revokeGatewayKey',
] as const;

/** Administrator changes, by Activity module. */
const ADMIN_ACTIONS: Record<string, readonly string[]> = {
  settings: [
    'updateWorkspaceSettings',
    // Services & pricing (v1.6): budget limits and price overrides.
    'updateBudgetLimit',
    'removeBudgetLimit',
    'updateServicePrice',
    'removeServicePrice',
  ],
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
    // A super revoking a member's model gateway key (Services & pricing).
    'revokeMemberGatewayKey',
  ],
};

for (const entry of fromExtensions('activity')) {
  for (const [module, actions] of Object.entries(entry.adminActions ?? {}))
    ADMIN_ACTIONS[module] = [...(ADMIN_ACTIONS[module] ?? []), ...actions];
}

const ADMIN_MODULE_BY_ACTION = new Map(
  Object.entries(ADMIN_ACTIONS).flatMap(([module, actions]) => actions.map((action) => [action, module] as const)),
);

/** Module of a platform application's audit row. */
function appModule(appId: string): string {
  if (appId === DRIVE_AUDIT_APP_ID) return 'files';
  const contributed = fromExtensions('activity').find((entry) => entry.appModules?.[appId]);
  if (contributed) return contributed.appModules![appId]!;
  return appId;
}

const TOOL_MODULES: Record<string, string> = {
  ...Object.assign({}, ...fromExtensions('activity').map((entry) => entry.toolModules ?? {})),
  knowledge_mutation: 'knowledge',
  files_mutation: 'files',
  // An agent's generated image is a new file on the member's personal shelf.
  generate_image: 'files',

  project_mutation: 'projects',
  tables_mutation: 'tables',
  skill_mutation: 'skills',

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
  [/^(share|grant|authorize|invite|issue)/, 'share'],
  [/^(create|add|insert|submit|upload|publish|log|append|import|duplicate|clone)/, 'create'],
  [/^(update|edit|set|rename|patch|change|rotate|resend|upsert|replace|convert|manage)/, 'update'],
  [/^(run|trigger)/, 'run'],
];

/** The kind of change, from an action id (`updateProject`) or a tool action (`records.update`, `files.delete`). */
export function verbOf(action: string): ActivityVerb {
  const last = action.includes('.') ? action.slice(action.lastIndexOf('.') + 1) : action;
  const normalized = last.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  for (const [pattern, verb] of VERB_PATTERNS) if (pattern.test(normalized)) return verb;
  return 'other';
}

/**
 * The verb of one write-tool action, by its first word (`update_doc`,
 * `batch_upsert`, `run_now`): what the change did to the object, not how.
 * Anything else stays `other` and shows the action itself.
 */
const TOOL_VERBS: Record<string, ActivityVerb> = {
  create: 'create',
  add: 'create',
  insert: 'create',
  submit: 'create',
  upload: 'create',
  publish: 'create',
  draft: 'create',
  update: 'update',
  edit: 'update',
  patch: 'update',
  append: 'update',
  upsert: 'update',
  batch: 'update',
  move: 'update',
  rename: 'update',
  set: 'update',
  delete: 'delete',
  remove: 'delete',
  archive: 'archive',
  unarchive: 'restore',
  restore: 'restore',
  share: 'share',
  unshare: 'unshare',
  run: 'run',
  send: 'send',
};

/** The object an action prefix (`folders.create`) names. */
const ACTION_ENTITIES: Record<string, string> = {
  knowledge: 'document',
  project: 'project',
  task: 'task',
  comment: 'task',
  records: 'record',
  folders: 'folder',
  files: 'file',
  skills: 'skill',
};

/** The object a tool without an action prefix writes. */
const TOOL_ENTITIES: Record<string, string> = {
  ...Object.assign(
    {},
    ...fromExtensions('activity').map((entry) =>
      Object.fromEntries(Object.entries(entry.toolWrites ?? {}).map(([key, value]) => [key, value.entity])),
    ),
  ),
  knowledge_mutation: 'document',
  tables_mutation: 'record',
  skill_mutation: 'skill',
  automation_mutation: 'automation',

  email_mutation: 'email',
  generate_image: 'file',
};

export interface WriteShape {
  verb: ActivityVerb;
  /** The kind of object (`document`, `file`, `task`…), or null for an unknown tool. */
  entity: string | null;
}

/** What one agent write did, in the Activity vocabulary: "updated document", "created folder". */
export function describeToolWrite(toolId: string, action: string | null): WriteShape {
  const descriptor = fromExtensions('activity')
    .map((entry) => entry.toolWrites?.[toolId])
    .find(Boolean);
  if (descriptor?.verb) return { verb: descriptor.verb as WriteShape['verb'], entity: descriptor.entity };
  // generate_image's `edit` makes a new image too; the original is untouched.
  if (toolId === 'generate_image') return { verb: 'create', entity: 'file' };

  const dot = action ? action.lastIndexOf('.') : -1;
  const prefix = action && dot > 0 ? action.slice(0, dot) : null;
  const segment = action ? action.slice(dot + 1) : '';
  if (toolId === 'project_mutation' && action === 'comment.add') return { verb: 'comment', entity: 'task' };
  const verb = TOOL_VERBS[segment.split('_')[0] ?? ''] ?? 'other';
  const entity = (prefix ? ACTION_ENTITIES[prefix] : undefined) ?? TOOL_ENTITIES[toolId] ?? null;
  return { verb, entity };
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
    for (const entry of fromExtensions('activity'))
      for (const item of entry.personActions ?? []) if (wants(item.module)) actions.push(item);
    if (wants('mcp')) actions.push({ appId: 'platform', actionIds: PERSONAL_PLATFORM_ACTIONS });
    jobs.push(
      db.activity
        .listAuditChanges({ ...window, actions, actorType: 'human', userId: q.userId })
        .then((rows) => rows.map((row) => ({ kind: 'audit', source: 'person', row }) as const)),
    );
  }

  if (q.sources.includes('admin')) {
    const actions = Object.entries(ADMIN_ACTIONS)
      .filter(([module]) => wants(module))
      .map(([, actionIds]) => ({ appId: 'platform', actionIds }));
    jobs.push(
      db.activity
        .listAuditChanges({ ...window, actions, actorType: 'human', userId: q.userId })
        .then((rows) => rows.map((row) => ({ kind: 'audit', source: 'admin', row }) as const)),
    );
  }

  if (q.sources.includes('agent')) {
    const toolIds = q.module ? [...MUTATING_PROXY_ALLOWLIST].filter((id) => moduleOfTool(id) === q.module) : null;
    if (q.module !== 'connectors') {
      jobs.push(
        db.activity
          .listRuns({ ...window, kinds: ['agent_write'], ownerUserId: q.userId, toolIds })
          .then((rows) => rows.map((row) => ({ kind: 'run', source: 'agent', row }) as const)),
      );
    }
    // Remote writes through a connector (connectors/writes.ts), from chat,
    // automations or an outside agent — always the owner's own agent.
    if (wants('connectors')) {
      jobs.push(
        db.activity
          .listRuns({ ...window, kinds: ['connector_write'], ownerUserId: q.userId })
          .then((rows) => rows.map((row) => ({ kind: 'run', source: 'agent', row }) as const)),
      );
    }
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

export interface HydrateContext {
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
    // The kernel records either the row id or the doc slug, depending on the caller.
    const doc = (await ctx.db.knowledgeBase.getById(recordId)) ?? (await ctx.db.knowledgeBase.get(recordId, 'shared'));
    if (!doc || !canReadKb(await resolveKbAccess(ctx.db, doc, ctx.viewer.id))) return null;
    return { label: doc.title, url: entityUrl({ kind: 'kb_doc', id: doc.id, slug: doc.doc_id }) };
  } catch {
    return null;
  }
}

async function projectReadable(ctx: HydrateContext, projectId: string) {
  const project = await ctx.db.projects.getProjectById(projectId);
  if (!project) return null;
  if (ctx.viewer.role === 'super' || project.visibility === 'public') return project;
  const members = await ctx.db.projects.getMembers(project.id);
  return members.some((member) => member.user_id === ctx.viewer.id) ? project : null;
}

async function projectTarget(ctx: HydrateContext, entity: string | null, recordId: string) {
  const id = toRowId(recordId);
  if (!id) return null;
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

interface DriveNode {
  scope?: unknown;
  visibility?: unknown;
  owner_user_id?: unknown;
  name?: unknown;
}

function driveTarget(ctx: HydrateContext, entity: string | null, recordId: string, node: DriveNode) {
  const visibility = node.visibility === 'private' ? 'private' : node.visibility === 'team' ? 'team' : null;
  const mine = typeof node.owner_user_id === 'string' && node.owner_user_id === ctx.viewer.id;
  if (node.scope !== 'kb' || !(visibility === 'team' || mine) || typeof node.name !== 'string') return null;
  const shelf = shelfOfVisibility(visibility);
  const id = recordId;
  const url =
    entity === 'folder' ? filesPageHref({ shelf, folderId: id }) : entity === 'file' ? filesPageHref({ shelf }) : null;
  return { label: node.name, url };
}

/** A file or folder as it is now, named under the same shelf rule as its audit rows. */
async function liveDriveTarget(ctx: HydrateContext, entity: 'file' | 'folder', recordId: string) {
  const id = toRowId(recordId);
  if (!id) return null;
  try {
    const row = entity === 'folder' ? await ctx.db.drive.getFolder(id) : await ctx.db.drive.getFile(id);
    return row ? driveTarget(ctx, entity, recordId, row) : null;
  } catch {
    return null;
  }
}

async function oauthClientName(ctx: HydrateContext, clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  try {
    return (await ctx.db.platformOAuth.getClient(clientId))?.client_name ?? null;
  } catch {
    return null;
  }
}

/**
 * The title an audit kept for a record that may be gone (projects record it on
 * create and delete). Shown to whoever made the change, and to a super, who
 * reads every project; never to anyone else.
 */
function keptTitle(ctx: HydrateContext, row: ActivityAuditRow, summary: Record<string, unknown>): string | null {
  if (typeof summary.title !== 'string' || !summary.title) return null;
  return ctx.viewer.id === row.actor_id || ctx.viewer.role === 'super' ? summary.title : null;
}

function adminDetail(row: ActivityAuditRow, summary: Record<string, unknown>): string | null {
  const keys = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
  if (row.action_id === 'updateWorkspaceSettings') {
    // Key names only — some of these settings are secrets.
    const changed = [...keys(summary.set), ...keys(summary.cleared)];
    return changed.length > 0 ? changed.join(', ') : null;
  }
  if (
    (row.action_id === 'updateBudgetLimit' ||
      row.action_id === 'removeBudgetLimit' ||
      row.action_id === 'updateServicePrice' ||
      row.action_id === 'removeServicePrice') &&
    typeof summary.detail === 'string'
  ) {
    return summary.detail;
  }
  if (row.action_id === 'revokeMemberGatewayKey' && typeof summary.detail === 'string') return summary.detail;
  if (
    fromExtensions('activity').some((entry) =>
      Object.values(entry.adminActions ?? {}).some((actions) => actions.includes(row.action_id)),
    ) &&
    typeof summary.detail === 'string'
  ) {
    return summary.detail;
  }
  if (row.action_id === 'setUserFeature' && typeof summary.feature === 'string') {
    return `${summary.feature}: ${summary.enabled === false ? 'off' : 'on'}`;
  }
  return null;
}

/** The verb and object of a person's or admin's audited change. */
function auditShape(row: ActivityAuditRow, summary: Record<string, unknown>): WriteShape {
  const verb = verbOf(row.action_id);
  if (row.app_id === 'knowledge') {
    if (summary.change === 'reorder') return { verb: 'move', entity: 'document' };
  }
  // A comment is filed against its task: "commented on task <title>".
  if (row.app_id === 'projects' && row.action_id === 'addComment') return { verb: 'comment', entity: 'task' };
  return { verb, entity: row.entity_id };
}

async function hydrateAudit(
  ctx: HydrateContext,
  source: 'person' | 'admin',
  row: ActivityAuditRow,
): Promise<ActivityItem> {
  const summary = jsonObject(row.summary);
  const shape = auditShape(row, summary);
  const module =
    source === 'admin'
      ? (ADMIN_MODULE_BY_ACTION.get(row.action_id) ?? 'settings')
      : row.app_id === 'platform'
        ? 'mcp'
        : appModule(row.app_id);
  let target: ActivityItem['target'] = row.record_id ? { id: row.record_id, label: null, url: null } : null;
  if (row.app_id === 'platform' && (row.entity_id === 'oauthGrant' || row.entity_id === 'oauthClient')) {
    // An agent connection is named by its client; the grant / client id means nothing to a person.
    const clientId = row.entity_id === 'oauthClient' ? row.record_id : row.client_id;
    const name =
      (await oauthClientName(ctx, clientId)) ?? (typeof summary.client_name === 'string' ? summary.client_name : null);
    target = name ? { id: null, label: name, url: null } : null;
  } else if (row.record_id && fromExtensions('activity').some((entry) => entry.targets?.[row.entity_id ?? ''])) {
    const resolve = fromExtensions('activity').find((entry) => entry.targets?.[row.entity_id ?? ''])!.targets![
      row.entity_id!
    ]!;
    const named = await resolve(ctx, row, summary);
    target = { id: row.record_id, label: named?.label ?? null, url: named?.url ?? null };
  } else if (row.app_id === 'platform' && row.entity_id === 'gatewayKey') {
    // A gateway key is named by the name its owner gave it (never its secret).
    target = typeof summary.name === 'string' ? { id: row.record_id, label: summary.name, url: null } : null;
  } else if (row.record_id) {
    const resolved =
      row.app_id === 'knowledge'
        ? await knowledgeTarget(ctx, row.record_id)
        : row.app_id === 'projects'
          ? shape.entity === 'comment'
            ? // A deleted comment is named by the task it was on, which its audit keeps.
              await projectTarget(ctx, 'task', String(summary.task_id ?? ''))
            : await projectTarget(ctx, shape.entity, row.record_id)
          : row.app_id === DRIVE_AUDIT_APP_ID
            ? driveTarget(ctx, row.entity_id, row.record_id, summary)
            : row.app_id === 'platform' && row.entity_id === 'user'
              ? { label: ctx.names.get(row.record_id) ?? null, url: null }
              : null;
    if (resolved) target = { id: row.record_id, ...resolved };
    else if (row.app_id === 'projects') {
      const kept = keptTitle(ctx, row, summary);
      if (kept) target = { id: row.record_id, label: kept, url: null };
    }
  }
  return {
    id: row.key,
    source,
    at: row.at,
    actor: { id: row.actor_id, name: ctx.names.get(row.actor_id) ?? null },
    agent: null,
    module,
    verb: shape.verb,
    entity: shape.entity,
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
  if (row.status === 'interrupted') {
    return row.kind === 'agent_write' || row.kind === 'connector_write' ? 'outcome_unknown' : 'failed';
  }
  return 'running';
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function text(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/**
 * The object an agent write touched, named only for a viewer who may read it:
 * looked up as it is now under the module's own read rule (a created record by
 * the id its output returned). A record that cannot be looked up any more is
 * named from the write's own input/output only for the member whose agent made
 * it — they could read it then — or, for modules a super reads in full, a super.
 */
async function agentWriteTarget(
  ctx: HydrateContext,
  row: ActivityRunRow,
  toolId: string,
  action: string | null,
  shape: WriteShape,
): Promise<ActivityItem['target']> {
  const input = field(jsonObject(row.input), 'input');
  const result = field(row.output, 'result');
  const creates = shape.verb === 'create';
  const own = ctx.viewer.id === row.owner_user_id;
  const superReads = ctx.viewer.role === 'super';
  let id: string | null = null;
  let live: { label: string; url: string | null } | null = null;
  let kept: string | null = null;
  let keptVisible = own;

  if (toolId === 'knowledge_mutation') {
    id = creates ? idText(field(result, 'document', 'id')) : idText(field(input, 'doc_id'));
    live = id ? await knowledgeTarget(ctx, id) : null;
    kept = text(field(result, 'document', 'title'), creates ? field(input, 'title') : null);
  } else if (toolId === 'project_mutation') {
    const entity = shape.entity === 'project' ? 'project' : 'task';
    id =
      action === 'project.create'
        ? idText(field(result, 'project', 'id'))
        : action === 'task.create'
          ? idText(field(result, 'task', 'id'))
          : idText(field(input, entity === 'project' ? 'project_id' : 'task_id'));
    live = id ? await projectTarget(ctx, entity, id) : null;
    kept = text(field(result, entity, 'title'), creates ? field(input, 'title') : null);
    keptVisible = own || superReads;
  } else if (
    (toolId === 'files_mutation' && (shape.entity === 'file' || shape.entity === 'folder')) ||
    fromExtensions('activity').some((entry) => entry.fileTools?.includes(toolId))
  ) {
    const entity = shape.entity === 'folder' ? 'folder' : 'file';
    id = idText(field(result, entity, 'id')) ?? idText(field(input, entity === 'file' ? 'file_id' : 'folder_id'));
    live = id ? await liveDriveTarget(ctx, entity, id) : null;
    kept = text(field(result, entity, 'name'), field(input, 'name'));
  } else if (toolId === 'skill_mutation') {
    kept = text(field(result, 'skill', 'display_name'), field(input, 'display_name'), field(input, 'name'));
    keptVisible = own || superReads;
  } else if (toolId === 'automation_mutation') {
    kept = text(field(result, 'automation', 'name'), field(input, 'name'));
  } else {
    const title = fromExtensions('activity')
      .map((entry) => entry.toolWrites?.[toolId]?.title)
      .find(Boolean);
    if (title) {
      kept = text(field(result, title.result, title.field), field(input, title.field));
      keptVisible = own || superReads;
    }
  }

  if (live) return { id, ...live };
  if (kept && keptVisible) return { id, label: kept, url: null };
  return null;
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
  if (source === 'agent' && row.kind === 'connector_write') {
    const connector = text(input.connector_name, input.connector) ?? 'Connector';
    const tool = text(input.tool) ?? 'tool';
    return {
      ...base,
      agent: {
        client_id: null,
        client_name: text(input.client_name) ?? (input.origin === 'automation' ? 'Automation' : 'Agent'),
        avatar: null,
      },
      module: 'connectors',
      verb: 'other',
      entity: null,
      action: tool,
      action_title: `${tool} · ${connector}`,
      // The connector is the member's own or a team one; its name is no secret.
      target: { id: typeof input.connector_id === 'string' ? input.connector_id : null, label: connector, url: null },
    };
  }
  if (source === 'agent') {
    const toolId = typeof input.tool_id === 'string' ? input.tool_id : 'unknown';
    const action = typeof input.action === 'string' && input.action ? input.action : null;
    const shape = describeToolWrite(toolId, action);
    return {
      ...base,
      agent: {
        client_id: typeof input.client_id === 'string' ? input.client_id : null,
        client_name: typeof input.client_name === 'string' ? input.client_name : 'Agent',
        avatar:
          typeof input.client_id === 'string'
            ? await ctx.db.platformOAuth.getUserClientAvatar(row.owner_user_id, input.client_id).catch(() => null)
            : null,
      },
      module: moduleOfTool(toolId),
      verb: shape.verb,
      entity: shape.entity,
      action: action ?? toolId,
      action_title: null,
      // Named only when the VIEWER may read it — a super must not learn the title
      // of a member's private document through that member's agent write.
      target: await agentWriteTarget(ctx, row, toolId, action, shape).catch(() => null),
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
