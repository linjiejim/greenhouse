/**
 * Hono adapter that wraps existing Knowledge routes with platform capability
 * authorization and outcome audit. Domain owner/editor/reader checks remain in
 * knowledge-access.ts and are therefore intersected with platform permission.
 */

import type { Context, Next } from 'hono';
import { getDb } from '@greenhouse/db';
import { humanActor } from '../actor.js';
import { knowledgeManifest } from '../manifests/knowledge.js';
import type { KnowledgeActionId } from './adapter.js';
import { getAuthUser } from '../../auth/middleware.js';
import { getPlatformRuntime } from '../runtime.js';

/**
 * What kind of change a route that shares an action with others makes, for the
 * Activity log: `presence` is an editor heartbeat (not a change, never shown),
 * `reorder` reads better than "updated document".
 */
export type KnowledgeHttpChange = 'presence' | 'reorder';

interface KnowledgeHttpAction {
  actionId: KnowledgeActionId;
  documentId?: string;
  change?: KnowledgeHttpChange;
}

export function matchKnowledgeAction(method: string, fullPath: string): KnowledgeHttpAction | undefined {
  const path = fullPath.replace(/^\/api\/knowledge/, '') || '/';

  if (method === 'GET' && path === '/docs') return { actionId: 'listDocuments' };
  if (method === 'GET' && path === '/docs/templates') return { actionId: 'listDocuments' };
  if (method === 'POST' && path === '/docs') return { actionId: 'createDocument' };
  if (method === 'GET' && path === '/search') return { actionId: 'searchDocuments' };
  if (method === 'POST' && path === '/docs/generate') return { actionId: 'generateDocument' };
  // Sibling ordering writes `sort_order` on the docs (and folders) it is given —
  // the same permission moving a doc between folders needs, so the same action.
  if (method === 'POST' && path === '/tree/reorder') return { actionId: 'updateDocument', change: 'reorder' };
  // Bulk export reads the team library. `requireSuper()` on the route is the
  // extra "this is an admin act" gate; the capability itself is plain read.
  if (method === 'GET' && path === '/export') return { actionId: 'listDocuments' };

  let match = path.match(/^\/docs\/id\/([^/]+)$/);
  if (match && method === 'GET') return { actionId: 'readDocument', documentId: match[1] };

  match = path.match(/^\/docs\/([^/]+)\/editing-presence$/);
  if (match && method === 'POST') return { actionId: 'updateDocument', documentId: match[1], change: 'presence' };

  match = path.match(/^\/docs\/([^/]+)\/versions$/);
  if (match && method === 'GET') return { actionId: 'listVersions', documentId: match[1] };
  match = path.match(/^\/docs\/([^/]+)\/versions\/\d+\/restore$/);
  if (match && method === 'POST') return { actionId: 'restoreVersion', documentId: match[1] };
  match = path.match(/^\/docs\/([^/]+)\/shares$/);
  if (match && method === 'GET') return { actionId: 'listShares', documentId: match[1] };
  if (match && method === 'POST') return { actionId: 'manageShares', documentId: match[1] };
  match = path.match(/^\/docs\/([^/]+)\/shares\/.+$/);
  if (match && method === 'DELETE') return { actionId: 'manageShares', documentId: match[1] };
  match = path.match(/^\/docs\/([^/]+)\/ai\/rewrite$/);
  if (match && method === 'POST') return { actionId: 'rewriteDocument', documentId: match[1] };
  match = path.match(/^\/docs\/([^/]+)\/enrich$/);
  if (match && method === 'POST') return { actionId: 'enrichDocument', documentId: match[1] };
  match = path.match(/^\/docs\/([^/]+)$/);
  if (match && method === 'PUT') return { actionId: 'updateDocument', documentId: match[1] };
  if (match && method === 'DELETE') return { actionId: 'archiveDocument', documentId: match[1] };

  match = path.match(/^\/docs\/([^/]+)$/);
  if (match && method === 'GET') return { actionId: 'readDocument', documentId: match[1] };
  return undefined;
}

/** The id of the document a create route just answered with, so the audit can name it. */
async function createdDocumentId(c: Context): Promise<string | undefined> {
  try {
    const body = (await c.res.clone().json()) as { doc?: { id?: unknown } };
    const id = body.doc?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

export function knowledgePlatformHttpMiddleware() {
  return async (c: Context, next: Next) => {
    const matched = matchKnowledgeAction(c.req.method, c.req.path);
    // This middleware is mounted over the whole Knowledge router. Unknown
    // routes must not bypass Platform authorization when a route is added but
    // the capability map is forgotten.
    if (!matched) return c.json({ error: 'Knowledge route is not registered in the authorization map' }, 404);

    const actor = humanActor(getAuthUser(c), c);
    const action = knowledgeManifest.actions[matched.actionId];
    const resource = {
      appId: knowledgeManifest.id,
      moduleId: action.module,
      entityId: action.entity,
      recordId: matched.documentId,
    };
    const decision = await getPlatformRuntime().authorize(actor, action.capability);
    if (!decision.allowed) {
      await getDb().platform.recordAudit({
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        requestId: actor.requestId,
        resource,
        actionId: action.id,
        capability: action.capability,
        result: 'denied',
        summary: { reason: decision.reason, transport: 'http' },
      });
      return c.json({ error: `Forbidden: missing capability ${action.capability}` }, 403);
    }

    try {
      await next();
      const status = c.res.status;
      const succeeded = status >= 200 && status < 400;
      await getDb().platform.recordAudit({
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        requestId: actor.requestId,
        resource:
          succeeded && matched.actionId === 'createDocument'
            ? { ...resource, recordId: await createdDocumentId(c) }
            : resource,
        actionId: action.id,
        capability: action.capability,
        result: succeeded ? 'success' : status === 403 ? 'denied' : 'error',
        summary: {
          status,
          method: c.req.method,
          transport: 'http',
          ...(matched.change ? { change: matched.change } : {}),
          // A heartbeat is audited (it needs edit rights) but is not a change.
          ...(matched.change === 'presence' ? { activity: false } : {}),
        },
      });
    } catch (error) {
      await getDb().platform.recordAudit({
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        requestId: actor.requestId,
        resource,
        actionId: action.id,
        capability: action.capability,
        result: 'error',
        summary: { errorName: error instanceof Error ? error.name : 'UnknownError', transport: 'http' },
      });
      throw error;
    }
  };
}
