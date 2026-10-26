import { fromExtensions } from '../extensions/index.js';
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
 * - a doc may be named by id (`#/knowledge/doc/<id>-…`) or by slug (`#/knowledge/doc/<slug>`
 *   without an id, or the scope routes `#/knowledge/internal/<space>/<slug>`); a slug link
 *   reports the doc's id only when readable;
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
import { canRead, resolveKbAccess } from '../knowledge/access.js';
import { canReadDrive, resolveDriveAccess } from '../drive/access.js';
import { canAccessSession } from '../sessions/access.js';
import { humanActor } from '../platform/actor.js';
import { getPlatformRuntime } from '../platform/runtime.js';

const RESOLVE_CONCURRENCY = 8;
const TITLE_MAX = 200;

/** `id` replaces the link's own id (a doc linked by slug, once it is known to be readable). */
export type Resolved = Pick<ResolvedObjectRef, 'title' | 'meta'> & { id?: string };

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
      : ref.type === 'doc' && ref.slug !== undefined
        ? `doc-slug:${ref.slug}`
        : `${ref.type}:${ref.id}`;
}

export interface ObjectRefResolver {
  db: DatabaseProvider;
  user: AuthUser;
  actor: ActorContext;
  capability: (name: string) => Promise<boolean>;
}

async function resolveRef(ref: ObjectRef, r: ObjectRefResolver): Promise<Resolved> {
  const hidden: Resolved = { title: null };
  const contributed = fromExtensions('objectRefs').find((resolver) => resolver.type === ref.type);
  if (contributed) return contributed.resolve(ref, r);
  switch (ref.type) {
    case 'doc': {
      if (!(await r.capability('knowledge.library.read'))) return hidden;
      // By slug exactly like GET /api/knowledge/docs/:slug, the route the slug link opens.
      const doc =
        ref.slug !== undefined
          ? await r.db.knowledgeBase.get(ref.slug, 'shared')
          : await r.db.knowledgeBase.getById(ref.id);
      if (!doc || doc.status === 'archived') return hidden;
      if (!canRead(await resolveKbAccess(r.db, doc, r.user.id))) return hidden;
      return ref.slug !== undefined ? { title: clip(doc.title), id: String(doc.id) } : { title: clip(doc.title) };
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
    case 'record':
    case 'project':
    case 'task':
      return hidden;
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
    const resolver: ObjectRefResolver = {
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
      return {
        url,
        type: ref.type,
        id: hit.id ?? objectRefId(ref),
        title: hit.title,
        ...(hit.meta ? { meta: hit.meta } : {}),
      };
    });
    return c.json({ items } satisfies ResolveRefsResponse);
  });
}

export interface ObjectRefSource {
  type: ObjectRef['type'];
  resolve: (ref: ObjectRef, ctx: ObjectRefResolver) => Promise<Resolved>;
}
