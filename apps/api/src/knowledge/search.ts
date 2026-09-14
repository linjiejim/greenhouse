/**
 * Knowledge search across the three channels a user can legitimately read.
 *
 * Extracted so `/api/knowledge/search` and the global search palette share one
 * implementation. The thing worth sharing is not the query — it is the *safe
 * argument combinations*: `db.knowledgeBase.search()` takes visibility and owner
 * as optional filters, so omitting them returns every private document in the
 * company. There are exactly three correct calls, and they live here once.
 */

import type { DatabaseProvider } from '@greenhouse/db';

export const KNOWLEDGE_SEARCH_SCOPES = ['team', 'personal', 'shared', 'all'] as const;
export type KnowledgeSearchScope = (typeof KNOWLEDGE_SEARCH_SCOPES)[number];

export interface KnowledgeSearchHit {
  id: number;
  slug: string;
  title: string;
  summary: string;
  snippet: string;
  tags: string;
  relevance: number;
  scope: 'team' | 'personal' | 'shared';
  access: 'owner' | 'editor' | 'reader';
}

/**
 * Search the channels selected by `scope` and interleave them.
 *
 * `scope` omitted keeps the historical default (team + the caller's own private
 * docs) — `all` minus shared-with-me.
 */
export async function searchKnowledgeScopes(
  db: DatabaseProvider,
  userId: string,
  query: string,
  scope: KnowledgeSearchScope | undefined,
  limit: number,
): Promise<KnowledgeSearchHit[]> {
  const wantTeam = scope === undefined || scope === 'all' || scope === 'team';
  const wantPersonal = scope === undefined || scope === 'all' || scope === 'personal';
  const wantShared = scope === 'all' || scope === 'shared';

  const [team, mine, shared] = await Promise.all([
    wantTeam
      ? db.knowledgeBase.search(query, { scope: 'shared', status: 'published', visibility: 'team', limit })
      : Promise.resolve([]),
    wantPersonal
      ? db.knowledgeBase.search(query, {
          scope: 'shared',
          status: 'published',
          visibility: 'private',
          ownerUserId: userId,
          limit,
        })
      : Promise.resolve([]),
    // Shared-with-me: gate + role resolved in SQL (matches resolveKbAccess).
    wantShared ? db.knowledgeBase.searchShared(query, userId, { status: 'published', limit }) : Promise.resolve([]),
  ]);

  // Relevance is not comparable across channels — the FTS paths return ts_rank
  // (<1) while the ILIKE fallbacks return a constant 1.0 — so a global relevance
  // sort lets an ILIKE-fallback channel starve genuine FTS hits out of the
  // top-`limit` slice. Each channel already comes back best-first, so interleave
  // by rank (round-robin) and use the fixed channel order only to break ties.
  const tagged = [
    ...team.map((r, rank) => ({ ...r, scope: 'team' as const, access: 'editor' as const, rank, chan: 0 })),
    ...mine.map((r, rank) => ({ ...r, scope: 'personal' as const, access: 'owner' as const, rank, chan: 1 })),
    ...shared.map((r, rank) => ({ ...r, scope: 'shared' as const, access: r.access, rank, chan: 2 })),
  ];

  return tagged
    .sort((a, b) => a.rank - b.rank || a.chan - b.chan)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      slug: r.doc_id,
      title: r.title,
      summary: r._summary || '',
      snippet: r.snippet,
      tags: r.tags || '[]',
      relevance: Number(r.relevance || 0),
      scope: r.scope,
      access: r.access,
    }));
}
