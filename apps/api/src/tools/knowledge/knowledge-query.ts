/**
 * Knowledge Query tool — read-only access to team, personal, and shared knowledge.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { safeJsonParse } from '@greenhouse/utils/json';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from '../define.js';

const knowledgeQuerySchema = z.object({
  action: z
    .enum(['search', 'get', 'list', 'versions'])
    .describe('Read-only knowledge action. "versions": list a doc\'s change history.'),
  scope: z
    .enum(['team', 'personal', 'shared'])
    .default('team')
    .describe('Knowledge scope: team docs, your own personal docs, or docs others shared with you.'),
  query: z.string().optional().describe('Search query for search/list filtering.'),
  doc_id: z.string().optional().describe('Document id for get/versions action.'),
  limit: z.number().min(1).max(50).optional().describe('Max results (default 10).'),
  offset: z.number().min(0).optional().describe('List offset.'),
});

type KnowledgeQueryInput = z.infer<typeof knowledgeQuerySchema>;

export interface KnowledgeQueryContext {
  userId: string;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'knowledge_query',
  name: 'Knowledge Query',
  brief: 'Read team, personal, and shared knowledge documents',
  description: `Read-only knowledge query tool. Actions: search, get, list, versions. Scopes: team knowledge, the current user's personal docs, and 'shared' (private docs other people shared with the user, directly or via a group). Use action=versions to inspect a doc's change history before restoring. Personal scope is strictly limited to the current user.`,
  category: 'team',
  is_global: true,
  icon: 'BookOpen',
  group: 'knowledge',
  surface: { proxy: 'read', mcp: true },
};

export function createKnowledgeQueryTool(db: DatabaseProvider, ctx: KnowledgeQueryContext) {
  return tool({
    description: meta.description,
    inputSchema: knowledgeQuerySchema,
    execute: async (input: KnowledgeQueryInput) => {
      try {
        const limit = input.limit ?? 10;

        if (input.scope === 'shared') {
          // Private docs OTHERS shared with the current user (directly or via a group).
          const ids = await db.knowledgeShares.listDocIdsForUser(ctx.userId);
          const shared = (await db.knowledgeBase.listByIds(ids, { status: 'published' })).filter(
            (d) => d.visibility === 'private' && d.owner_user_id !== ctx.userId,
          );

          if (input.action === 'get' || input.action === 'versions') {
            if (!input.doc_id) return { error: `doc_id is required for action=${input.action}` };
            const doc = shared.find((d) => d.doc_id === input.doc_id);
            if (!doc) return { error: `Document not found: ${input.doc_id}` };
            if (input.action === 'versions') {
              const versions = await db.knowledgeBase.listVersions(doc.id);
              return {
                scope: 'shared',
                doc_id: doc.doc_id,
                found: versions.length,
                versions: versions.map((v) => ({
                  version: v.version,
                  change_reason: v.change_reason || '',
                  changed_by: v.changed_by,
                  created_at: v.created_at,
                })),
              };
            }
            return {
              scope: 'shared',
              doc_id: doc.doc_id,
              title: doc.title,
              content: doc.content,
              tags: safeJsonParse(doc.tags, []),
              summary: doc._summary || '',
            };
          }

          // search (substring) / list
          const q = (input.query || '').toLowerCase();
          const matched = q
            ? shared.filter(
                (d) =>
                  d.title.toLowerCase().includes(q) ||
                  (d._summary || '').toLowerCase().includes(q) ||
                  d.content.toLowerCase().includes(q),
              )
            : shared;
          return {
            scope: 'shared',
            found: matched.length,
            results: matched.slice(0, limit).map((d) => ({
              id: d.id,
              doc_id: d.doc_id,
              title: d.title,
              summary: d._summary || '',
              tags: safeJsonParse(d.tags, []),
              updated_at: d.updated_at,
            })),
          };
        }

        const scope = 'shared';
        const visibility = input.scope === 'team' ? 'team' : 'private';
        const ownerUserId = input.scope === 'personal' ? ctx.userId : undefined;

        if (input.action === 'search') {
          if (!input.query) return { error: 'query is required for action=search' };
          const results = await db.knowledgeBase.search(input.query, {
            scope,
            status: 'published',
            visibility,
            ownerUserId,
            limit,
          });
          return {
            scope: input.scope,
            found: results.length,
            results: results.map((r) => ({
              id: r.id,
              doc_id: r.doc_id,
              title: r.title,
              summary: r._summary || '',
              snippet: r.snippet,
              tags: safeJsonParse(r.tags, []),
              relevance: Math.round(r.relevance * 100) / 100,
            })),
          };
        }

        if (input.action === 'get') {
          if (!input.doc_id) return { error: 'doc_id is required' };
          // Team and personal docs both have user_id=NULL (default get arg); personal
          // ownership is enforced by the owner_user_id check below, not by user_id.
          const doc = await db.knowledgeBase.get(input.doc_id, scope);
          if (!doc || doc.status === 'archived' || doc.visibility !== visibility) {
            return { error: `Document not found: ${input.doc_id}` };
          }
          if (input.scope === 'personal' && doc.owner_user_id !== ctx.userId) {
            return { error: `Document not found: ${input.doc_id}` };
          }
          return {
            scope: input.scope,
            doc_id: doc.doc_id,
            title: doc.title,
            content: doc.content,
            tags: safeJsonParse(doc.tags, []),
            summary: doc._summary || '',
          };
        }

        if (input.action === 'versions') {
          if (!input.doc_id) return { error: 'doc_id is required for action=versions' };
          const doc = await db.knowledgeBase.get(input.doc_id, scope);
          if (!doc || doc.visibility !== visibility) return { error: `Document not found: ${input.doc_id}` };
          if (input.scope === 'personal' && doc.owner_user_id !== ctx.userId) {
            return { error: `Document not found: ${input.doc_id}` };
          }
          const versions = await db.knowledgeBase.listVersions(doc.id);
          return {
            scope: input.scope,
            doc_id: doc.doc_id,
            found: versions.length,
            versions: versions.map((v) => ({
              version: v.version,
              change_reason: v.change_reason || '',
              changed_by: v.changed_by,
              created_at: v.created_at,
            })),
          };
        }

        const docs = await db.knowledgeBase.list({
          scope,
          status: 'published',
          visibility,
          ownerUserId,
          search: input.query,
          limit,
          offset: input.offset,
        });
        return {
          scope: input.scope,
          found: docs.length,
          results: docs.map((d) => ({
            id: d.id,
            doc_id: d.doc_id,
            title: d.title,
            summary: d._summary || '',
            tags: safeJsonParse(d.tags, []),
            updated_at: d.updated_at,
          })),
        };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const knowledgeQueryTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'internal' },
  create: (ctx) => createKnowledgeQueryTool(ctx.db, { userId: ctx.userId }),
});
