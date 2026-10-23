/**
 * Home "recent changes" (团队动态) — what changed across the team lately,
 * limited to what the viewer may read.
 *
 * Built from each domain's own change record, every query bounded by a time
 * window (RECENT_DAYS) and a LIMIT:
 *   knowledge  knowledge_base_versions (one row per saved edit), each document
 *              confirmed with resolveKbAccess for the viewer;
 *   projects   project_activities of the projects the platform lists for the
 *              viewer (dispatch `listProjects`, so entity policies apply);
 *   tables     table_records changes in tables of the Bases the platform lists
 *              for the viewer, one row per (table, person) with a count —
 *              record values are never read;
 *   files      new files on the team shelf and the viewer's own shelf.
 * A change made through a member's agent is matched to the recorded
 * agent_write run (same member, same module, inside the run's time span) and
 * says "via <client>".
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { ActivityItem, ActivityVerb } from '@greenhouse/types/activity';
import { entityUrl } from '@greenhouse/types/entity-links';
import { filesPageHref, shelfOfVisibility } from '@greenhouse/types/files';
import type { UserRole } from '@greenhouse/types/api';
import { canRead as canReadKb, resolveKbAccess } from '../knowledge/access.js';
import { userHasFeature } from '../auth/features.js';
import { humanActor } from '../platform/actor.js';
import type { PlatformRuntime } from '../platform/runtime.js';
import { moduleOfTool } from './activity-log.js';

export const RECENT_DAYS = 14;
export const RECENT_MAX_ITEMS = 50;
/** Bases / tables a single feed looks into. */
const MAX_BASES = 50;
const MAX_TABLES = 200;
/**
 * A change counts as an agent's when it lands inside the run's span: the write
 * happens after the run is created and before it settles, both stamped by the
 * same API clock. No slack — a person's own edit a moment after their agent
 * finished must stay theirs.
 */
const AGENT_MATCH_SLACK_MS = 0;

export interface RecentViewer {
  id: string;
  role: UserRole;
}

type Draft = Omit<ActivityItem, 'actor'> & { actorId: string };

const PROJECT_ACTIONS: Record<string, { verb: ActivityVerb; entity: string }> = {
  project_created: { verb: 'create', entity: 'project' },
  project_updated: { verb: 'update', entity: 'project' },
  task_created: { verb: 'create', entity: 'task' },
  task_updated: { verb: 'update', entity: 'task' },
  comment_added: { verb: 'comment', entity: 'task' },
  member_added: { verb: 'share', entity: 'project' },
};

function draft(base: Omit<Draft, 'agent' | 'action_title' | 'status' | 'run' | 'detail'> & Partial<Draft>): Draft {
  return { agent: null, action_title: null, status: null, run: null, detail: null, ...base };
}

async function knowledgeChanges(db: DatabaseProvider, viewer: RecentViewer, since: string, limit: number) {
  const rows = await db.activity.recentKnowledgeEdits({ userId: viewer.id, since, limit: limit * 3 });
  const seen = new Set<string>();
  const items: Draft[] = [];
  for (const row of rows) {
    // Several saves of one document by one person read as one change.
    const key = `${row.doc_pk}:${row.changed_by}`;
    if (seen.has(key) || !row.changed_by) continue;
    const readable =
      row.visibility === 'team' ||
      row.owner_user_id === viewer.id ||
      canReadKb(
        await resolveKbAccess(
          db,
          { id: row.doc_pk, visibility: row.visibility, owner_user_id: row.owner_user_id },
          viewer.id,
        ),
      );
    if (!readable) continue;
    seen.add(key);
    items.push(
      draft({
        id: `kb:${row.version_id}`,
        source: 'person',
        at: row.at,
        actorId: row.changed_by,
        module: 'knowledge',
        verb: row.version <= 1 ? 'create' : 'update',
        entity: 'document',
        action: row.version <= 1 ? 'createDocument' : 'updateDocument',
        target: {
          id: String(row.doc_pk),
          label: row.title,
          url: entityUrl({ kind: 'kb_doc', id: row.doc_pk, slug: row.slug }),
        },
      }),
    );
    if (items.length >= limit) break;
  }
  return items;
}

async function projectChanges(
  db: DatabaseProvider,
  runtime: PlatformRuntime,
  viewer: RecentViewer,
  since: string,
  limit: number,
) {
  const listed = await runtime.dispatch({
    actor: humanActor(viewer),
    appId: 'projects',
    actionId: 'listProjects',
    payload: { limit: 500 },
  });
  if (!listed.ok) return [];
  const projects = (listed.data as { projects: Array<{ id: number; title: string }> }).projects;
  const titles = new Map(projects.map((project) => [project.id, project.title]));
  const rows = await db.activity.recentProjectActivities({ projectIds: [...titles.keys()], since, limit });
  const taskIds = [...new Set(rows.map((row) => row.task_id).filter((id): id is number => id !== null))];
  const tasks = await Promise.all(taskIds.map((id) => db.projects.getTaskById(id).catch(() => undefined)));
  const taskTitles = new Map(taskIds.map((id, index) => [id, tasks[index]?.title ?? null]));
  return rows.map((row) => {
    const kind = PROJECT_ACTIONS[row.action] ?? { verb: 'update' as const, entity: 'project' };
    const label = row.task_id ? (taskTitles.get(row.task_id) ?? null) : (titles.get(row.project_id) ?? null);
    return draft({
      id: `pa:${row.id}`,
      source: 'person',
      at: row.at,
      actorId: row.user_id,
      module: 'projects',
      verb: kind.verb,
      entity: row.task_id ? 'task' : kind.entity,
      action: row.action,
      target: {
        id: String(row.task_id ?? row.project_id),
        label,
        url: entityUrl({ kind: 'project', id: row.project_id }),
      },
      detail: row.task_id ? (titles.get(row.project_id) ?? null) : null,
    });
  });
}

async function tableChanges(
  db: DatabaseProvider,
  runtime: PlatformRuntime,
  viewer: RecentViewer,
  since: string,
  limit: number,
) {
  if (!(await userHasFeature(viewer.id, viewer.role, 'tables', db))) return [];
  const listed = await runtime.dispatch({
    actor: humanActor(viewer),
    appId: 'tables',
    actionId: 'listBases',
    payload: {},
  });
  if (!listed.ok) return [];
  const bases = (listed.data as { bases: Array<{ id: number }> }).bases.slice(0, MAX_BASES);
  const tables = new Map<number, { baseId: number; name: string }>();
  for (const base of bases) {
    for (const table of await db.tables.listTables(base.id)) {
      if (tables.size >= MAX_TABLES) break;
      tables.set(table.id, { baseId: base.id, name: table.name });
    }
  }
  const rows = await db.activity.recentTableChanges({ tableIds: [...tables.keys()], since, limit });
  return rows.map((row) => {
    const table = tables.get(row.table_id)!;
    return draft({
      id: `tr:${row.table_id}:${row.updated_by}:${row.at}`,
      source: 'person',
      at: row.at,
      actorId: row.updated_by,
      module: 'tables',
      verb: 'update',
      entity: 'record',
      action: 'updateRecords',
      target: { id: String(row.table_id), label: table.name, url: `#/tables/${table.baseId}/table/${row.table_id}` },
      detail: String(row.records),
    });
  });
}

async function fileChanges(db: DatabaseProvider, viewer: RecentViewer, since: string, limit: number) {
  const rows = await db.drive.listRecentKbFiles({ userId: viewer.id, limit });
  const sinceMs = Date.parse(since);
  return rows
    .filter((row) => row.uploaded_by && Date.parse(row.created_at) >= sinceMs)
    .map((row) => {
      const shelf = shelfOfVisibility(row.visibility);
      return draft({
        id: `df:${row.id}`,
        source: 'person',
        at: new Date(row.created_at).toISOString(),
        actorId: row.uploaded_by!,
        module: 'files',
        verb: 'create',
        entity: 'file',
        action: 'uploadFile',
        target: {
          id: String(row.id),
          label: row.name,
          url: filesPageHref({ shelf, folderId: row.folder_id, fileId: row.id }),
        },
      });
    });
}

/** Say which agent made a change, when a recorded agent write of that member covers it. */
async function attachAgents(db: DatabaseProvider, items: Draft[]): Promise<void> {
  if (items.length === 0) return;
  const times = items.map((item) => Date.parse(item.at));
  const writes = await db.activity.agentWritesOf({
    ownerIds: [...new Set(items.map((item) => item.actorId))],
    from: new Date(Math.min(...times) - 10 * 60_000).toISOString(),
    to: new Date(Math.max(...times) + 1).toISOString(),
    limit: 200,
  });
  for (const item of items) {
    const at = Date.parse(item.at);
    const write = writes.find(
      (candidate) =>
        candidate.owner_user_id === item.actorId &&
        candidate.tool_id !== null &&
        moduleOfTool(candidate.tool_id) === item.module &&
        Date.parse(candidate.from) - AGENT_MATCH_SLACK_MS <= at &&
        at <= Date.parse(candidate.to) + AGENT_MATCH_SLACK_MS,
    );
    if (write) {
      item.source = 'agent';
      item.agent = { client_id: null, client_name: write.client_name ?? 'Agent' };
    }
  }
}

export async function listRecentChanges(
  db: DatabaseProvider,
  viewer: RecentViewer,
  opts: { limit?: number; now?: number },
  deps: { runtime: PlatformRuntime },
): Promise<ActivityItem[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20) || 20, 1), RECENT_MAX_ITEMS);
  const since = new Date((opts.now ?? Date.now()) - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const knowledgeAllowed = (await deps.runtime.authorize(humanActor(viewer), 'knowledge.library.read')).allowed;

  // Each lane fails on its own: one closed door is not an outage of the feed.
  const lanes = await Promise.all([
    knowledgeAllowed ? knowledgeChanges(db, viewer, since, limit).catch(() => []) : Promise.resolve([]),
    projectChanges(db, deps.runtime, viewer, since, limit).catch(() => []),
    tableChanges(db, deps.runtime, viewer, since, limit).catch(() => []),
    fileChanges(db, viewer, since, limit).catch(() => []),
  ]);
  const items = lanes
    .flat()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
  await attachAgents(db, items).catch(() => undefined);

  const ids = [...new Set(items.map((item) => item.actorId))];
  const users = await Promise.all(ids.map((id) => db.users.getById(id).catch(() => undefined)));
  const names = new Map(ids.map((id, index) => [id, users[index]?.nickname ?? null]));
  return items.map(({ actorId, ...item }) => ({ ...item, actor: { id: actorId, name: names.get(actorId) ?? null } }));
}
