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

interface KnowledgeHttpAction {
  actionId: KnowledgeActionId;
  documentId?: string;
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
  if (method === 'POST' && path === '/tree/reorder') return { actionId: 'updateDocument' };
  // Bulk export reads the team library. `requireSuper()` on the route is the
  // extra "this is an admin act" gate; the capability itself is plain read.
  if (method === 'GET' && path === '/export') return { actionId: 'listDocuments' };

  let match = path.match(/^\/docs\/id\/(\d+)$/);
  if (match && method === 'GET') return { actionId: 'readDocument', documentId: match[1] };

  match = path.match(/^\/docs\/(\d+)\/backlinks$/);
  if (match && method === 'GET') return { actionId: 'readDocument', documentId: match[1] };
  match = path.match(/^\/docs\/(\d+)\/comments$/);
  if (match && method === 'GET') return { actionId: 'readDocument', documentId: match[1] };
  if (match && method === 'POST') return { actionId: 'updateDocument', documentId: match[1] };
  match = path.match(/^\/docs\/(\d+)\/editing-presence$/);
  if (match && method === 'POST') return { actionId: 'updateDocument', documentId: match[1] };
  match = path.match(/^\/comments\/\d+$/);
  if (match && method === 'DELETE') return { actionId: 'updateDocument' };

  match = path.match(/^\/docs\/(\d+)\/versions$/);
  if (match && method === 'GET') return { actionId: 'listVersions', documentId: match[1] };
  match = path.match(/^\/docs\/(\d+)\/versions\/\d+\/restore$/);
  if (match && method === 'POST') return { actionId: 'restoreVersion', documentId: match[1] };
  match = path.match(/^\/docs\/(\d+)\/shares$/);
  if (match && method === 'GET') return { actionId: 'listShares', documentId: match[1] };
  if (match && method === 'POST') return { actionId: 'manageShares', documentId: match[1] };
  match = path.match(/^\/docs\/(\d+)\/shares\/.+$/);
  if (match && method === 'DELETE') return { actionId: 'manageShares', documentId: match[1] };
  match = path.match(/^\/docs\/(\d+)\/ai\/rewrite$/);
  if (match && method === 'POST') return { actionId: 'rewriteDocument', documentId: match[1] };
  match = path.match(/^\/docs\/(\d+)\/enrich$/);
  if (match && method === 'POST') return { actionId: 'enrichDocument', documentId: match[1] };
  match = path.match(/^\/docs\/(\d+)$/);
  if (match && method === 'PUT') return { actionId: 'updateDocument', documentId: match[1] };
  if (match && method === 'DELETE') return { actionId: 'archiveDocument', documentId: match[1] };

  match = path.match(/^\/docs\/([^/]+)$/);
  if (match && method === 'GET') return { actionId: 'readDocument', documentId: match[1] };
  return undefined;
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
      await getDb().platform.recordAudit({
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        requestId: actor.requestId,
        resource,
        actionId: action.id,
        capability: action.capability,
        result: status >= 200 && status < 400 ? 'success' : status === 403 ? 'denied' : 'error',
        summary: { status, method: c.req.method, transport: 'http' },
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
