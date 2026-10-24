/**
 * Object references — /api/refs
 *
 * POST /api/refs/resolve  { urls: string[] } → { items: ResolvedObjectRef[] }
 *
 * Clients draw a link to a workspace object (a document, file, folder, task, project, table
 * record or conversation) as a chip with its title, and fetch the titles here in one batch.
 * The URL parser is shared (`@greenhouse/types/object-refs`), so web, mobile and this route
 * agree on which links are objects.
 *
 * Rules:
 * - every item is authorized with the same helper its own read route uses; an object the
 *   caller may not read — or that does not exist — comes back with `title: null`, never an
 *   error, and the two cases look the same (no existence oracle);
 * - URLs that name no object are left out;
 * - absolute URLs count only on this workspace's own origin (request origin, `Origin`,
 *   `PUBLIC_BASE_URL`, `WEB_BASE_URL`): `#/projects/3` on another instance is another project.
 */

import { Hono, type Context } from 'hono';
import { getDb, type DatabaseProvider } from '@greenhouse/db';
import {
  MAX_RESOLVE_URLS,
  objectRefId,
  parseObjectUrl,
  type ObjectRef,
  type ResolvedObjectRef,
  type ResolveRefsResponse,
} from '@greenhouse/types/object-refs';
import { runWithConcurrency } from '@greenhouse/utils/concurrency';
import { logger } from '@greenhouse/utils/logger';
import type { ActorContext } from '@greenhouse/platform-kernel';
import type { AppEnv } from '../app-env.js';
import { getAuthUser, requireInternal } from '../auth/middleware.js';
import type { AuthUser } from '../auth/token.js';
import { userHasFeature } from '../auth/features.js';
import { canRead, resolveKbAccess } from '../knowledge/access.js';
import { canReadDrive, resolveDriveAccess } from '../drive/access.js';
import { canAccessSession } from '../sessions/access.js';
import { humanActor } from '../platform/actor.js';
import { projectResource, taskReadAuthorizer } from '../platform/projects/application.js';
import { tablesResource } from '../platform/tables/application.js';
import { getPlatformRuntime, type PlatformHandlerContext } from '../platform/runtime.js';

const RESOLVE_CONCURRENCY = 8;
const TITLE_MAX = 200;

type Resolved = Pick<ResolvedObjectRef, 'title' | 'meta'>;

/** The origins whose absolute URLs are this workspace. */
function workspaceOrigins(c: Context): string[] {
  const origins = [new URL(c.req.url).origin];
  const header = c.req.header('origin');
  if (header) origins.push(header);
  for (const value of [process.env.PUBLIC_BASE_URL, process.env.WEB_BASE_URL]) {
    if (value?.trim()) origins.push(value.trim());
  }
  return origins;
}

function clip(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

function refKey(ref: ObjectRef): string {
  return ref.type === 'task'
    ? `task:${ref.projectId}:${ref.id}`
    : ref.type === 'record'
      ? `record:${ref.baseId ?? ''}:${ref.tableId}:${ref.id}`
      : `${ref.type}:${ref.id}`;
}

/** Scalar → display text; anything else (arrays, objects, empty) → null. */
function displayValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

interface Resolver {
  db: DatabaseProvider;
  user: AuthUser;
  actor: ActorContext;
  capability: (name: string) => Promise<boolean>;
}

async function resolveRef(ref: ObjectRef, r: Resolver): Promise<Resolved> {
  const hidden: Resolved = { title: null };
  switch (ref.type) {
    case 'doc': {
      if (!(await r.capability('knowledge.library.read'))) return hidden;
      const doc = await r.db.knowledgeBase.getById(ref.id);
      if (!doc || doc.status === 'archived') return hidden;
      return canRead(await resolveKbAccess(r.db, doc, r.user.id)) ? { title: clip(doc.title) } : hidden;
    }
    case 'folder': {
      const folder = await r.db.drive.getFolder(ref.id);
      if (!folder || folder.scope !== 'kb') return hidden;
      return canReadDrive(resolveDriveAccess(folder, r.user.id, {})) ? { title: clip(folder.name) } : hidden;
    }
    case 'file': {
      const file = await r.db.drive.getFile(ref.id);
      if (!file || file.scope !== 'kb' || file.status !== 'active') return hidden;
      if (!canReadDrive(resolveDriveAccess(file, r.user.id, {}))) return hidden;
      return { title: clip(file.name), meta: { size: file.size, contentType: file.content_type } };
    }
    case 'project': {
      const result = await getPlatformRuntime().dispatch({
        actor: r.actor,
        appId: 'projects',
        actionId: 'getProject',
        payload: { projectId: ref.id },
        resource: projectResource('getProject', { projectId: ref.id }),
      });
      if (!result.ok) return hidden;
      const project = (result.data as { project?: { title?: unknown } }).project;
      return typeof project?.title === 'string' ? { title: clip(project.title) } : hidden;
    }
    case 'task': {
      if (!(await r.capability('projects.execution.read'))) return hidden;
      const task = await r.db.projects.getTaskById(ref.id);
      // The link names its project too; a task quoted under the wrong project is not this link.
      if (!task || task.project_id !== ref.projectId) return hidden;
      const context: PlatformHandlerContext = { db: r.db };
      const readable = await taskReadAuthorizer(context, r.actor)(task);
      return readable ? { title: clip(task.title) } : hidden;
    }
    case 'record': {
      if (!(await userHasFeature(r.user.id, r.user.role, 'tables', r.db))) return hidden;
      const result = await getPlatformRuntime().dispatch({
        actor: r.actor,
        appId: 'tables',
        actionId: 'getRecord',
        payload: { tableId: ref.tableId, recordId: ref.id },
        resource: tablesResource('getRecord', { tableId: ref.tableId, recordId: ref.id }),
      });
      if (!result.ok) return hidden;
      const [table, fields] = await Promise.all([
        r.db.tables.getTable(ref.tableId),
        r.db.tables.listFields(ref.tableId),
      ]);
      if (!table || (ref.baseId !== null && table.base_id !== ref.baseId)) return hidden;
      const record = (result.data as { record?: { values?: Record<string, unknown> } }).record;
      const primary = fields.find((field) => field.is_primary) ?? fields[0];
      const value = primary ? displayValue(record?.values?.[String(primary.id)]) : null;
      return { title: clip(value ?? `#${ref.id}`) };
    }
    case 'conversation': {
      const session = await r.db.sessions.getById(ref.id);
      if (!session || !(await canAccessSession(r.user, session))) return hidden;
      return { title: clip(session.title ?? '') };
    }
  }
}

export function createRefsRoutes() {
  return new Hono<AppEnv>().use('*', requireInternal()).post('/resolve', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { urls?: unknown } | null;
    const urls = body?.urls;
    if (!Array.isArray(urls) || !urls.every((url) => typeof url === 'string')) {
      return c.json({ error: 'urls must be an array of strings' }, 400);
    }
    if (urls.length > MAX_RESOLVE_URLS) {
      return c.json({ error: `At most ${MAX_RESOLVE_URLS} urls per request` }, 400);
    }

    const origins = workspaceOrigins(c);
    const parsed = (urls as string[])
      .map((url) => ({ url, ref: parseObjectUrl(url, { origins }) }))
      .filter((entry): entry is { url: string; ref: ObjectRef } => entry.ref !== null);

    const user = getAuthUser(c);
    const db = getDb();
    const actor = humanActor(user, c);
    const capabilities = new Map<string, Promise<boolean>>();
    const resolver: Resolver = {
      db,
      user,
      actor,
      capability: (name) => {
        let decision = capabilities.get(name);
        if (!decision) {
          decision = getPlatformRuntime()
            .authorize(actor, name)
            .then((d) => d.allowed);
          capabilities.set(name, decision);
        }
        return decision;
      },
    };

    // Each object once, however many links name it.
    const unique = new Map<string, ObjectRef>();
    for (const { ref } of parsed) unique.set(refKey(ref), ref);
    const resolved = new Map<string, Resolved>();
    await runWithConcurrency([...unique.entries()], RESOLVE_CONCURRENCY, async ([key, ref]) => {
      try {
        resolved.set(key, await resolveRef(ref, resolver));
      } catch (err) {
        logger.warn('[refs] resolve failed', { type: ref.type, error: String(err) });
        resolved.set(key, { title: null });
      }
    });

    const items: ResolvedObjectRef[] = parsed.map(({ url, ref }) => {
      const hit = resolved.get(refKey(ref)) ?? { title: null };
      return { url, type: ref.type, id: objectRefId(ref), title: hit.title, ...(hit.meta ? { meta: hit.meta } : {}) };
    });
    return c.json({ items } satisfies ResolveRefsResponse);
  });
}
