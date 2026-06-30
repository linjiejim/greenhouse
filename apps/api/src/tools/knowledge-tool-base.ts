/**
 * Shared implementation for the scope-bound knowledge-base tools
 * (`team_knowledge`, `personal_knowledge`).
 *
 * Both tools search and read the same `knowledge_base` table
 * (scope='shared', status='published') and differ ONLY in the visibility /
 * ownership boundary they enforce:
 *   - team:     visibility = 'team'
 *   - personal: visibility = 'private' AND owner_user_id = <current user>
 *
 * Centralising that boundary here keeps the privacy guard in ONE place. Each
 * tool file keeps its own `meta` (id / name / description) and registration, so
 * the LLM still sees two distinct tools.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { DatabaseProvider } from '@greenhouse/db';

// NOTE: Keep this a single top-level z.object (NOT z.discriminatedUnion/z.union).
// Some LLM endpoints require tool parameters to be a JSON Schema of
// `type: "object"` at the top level and reject the `anyOf` that a union emits.
// Fields are validated per-action at runtime in `execute` below.
const inputSchema = z.object({
  action: z
    .enum(['search', 'get'])
    .describe('"search": find documents by keyword. "get": read one document by doc_id.'),
  query: z.string().optional().describe('Search keywords (required when action="search"; English or Chinese)'),
  limit: z.number().min(1).max(10).optional().describe('Max results to return when action="search" (default 5)'),
  doc_id: z.string().optional().describe('Required when action="get". Document ID from search results'),
});

type KnowledgeInput = z.infer<typeof inputSchema>;

/** Minimal doc shape the read-guard inspects. */
interface KnowledgeDocGuardFields {
  visibility: string | null;
  owner_user_id: string | null;
}

export interface ScopedKnowledgeConfig {
  /** Tool description shown to the LLM (each tool passes its own meta.description). */
  description: string;
  /** Visibility / owner filter applied to db.knowledgeBase.search. */
  search: { visibility: 'private' | 'team'; ownerUserId?: string };
  /**
   * Read guard for action="get": may this published, non-archived doc be
   * returned in this scope? (status/archived is already checked by the skeleton.)
   */
  canRead: (doc: KnowledgeDocGuardFields) => boolean;
}

export function createScopedKnowledgeTool(db: DatabaseProvider, config: ScopedKnowledgeConfig) {
  return tool({
    description: config.description,
    inputSchema,
    execute: async (input: KnowledgeInput) => {
      if (input.action === 'search') {
        if (!input.query) {
          return { action: 'search' as const, error: 'query is required when action="search"' };
        }
        const results = await db.knowledgeBase.search(input.query, {
          scope: 'shared',
          status: 'published',
          visibility: config.search.visibility,
          ownerUserId: config.search.ownerUserId,
          limit: input.limit ?? 5,
        });

        return {
          action: 'search' as const,
          found: results.length,
          query: input.query,
          results: results.map((r) => ({
            id: r.id,
            doc_id: r.doc_id,
            title: r.title,
            summary: r._summary || '(no summary)',
            snippet: r.snippet,
            relevance: Math.round(r.relevance * 100) / 100,
          })),
        };
      }

      if (!input.doc_id) {
        return { action: 'get' as const, error: 'doc_id is required when action="get"' };
      }
      const doc = await db.knowledgeBase.get(input.doc_id, 'shared');
      // status/archived is the scope-agnostic check; canRead enforces the
      // visibility/ownership boundary specific to this tool.
      if (!doc || doc.status === 'archived' || !config.canRead(doc)) {
        return { action: 'get' as const, error: `Document not found: ${input.doc_id}` };
      }
      return {
        action: 'get' as const,
        doc_id: doc.doc_id,
        title: doc.title,
        content: doc.content,
        tags: safeJsonParse(doc.tags, []),
        summary: doc._summary || '',
      };
    },
  });
}
