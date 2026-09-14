/**
 * Knowledge Query — the SINGLE read implementation for team, personal and
 * shared knowledge.
 *
 * It replaced `team_knowledge` / `personal_knowledge` (retired 2026-08-14),
 * which were the same table behind a narrower scope. Three implementations cost
 * three tool descriptions on every request and had already drifted apart (the
 * shared scope searched in memory here while the DB had an FTS query for it),
 * but the load-bearing reason is recall: a model that searched `team_knowledge`
 * and missed stopped there, never learning that `scope='shared'` existed. Scope
 * is a parameter, so one search decision now covers everything the caller sees.
 *
 * The read model is three layers, mirroring how an agent actually works:
 *   tree   — which folders/columns exist          (the `ls` that was missing)
 *   search — find documents, optionally in one folder subtree
 *   get    — read one, whole or by section
 */

import { tool } from 'ai';
import { z } from 'zod';
import { safeJsonParse } from '@greenhouse/utils/json';
import { toErrorMessage } from '@greenhouse/utils/error';
import { entityUrl } from '@greenhouse/types/entity-links';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { CITE_URL_INSTRUCTION } from './cite-url.js';
import { kbFolderPath, kbFolderPaths, kbFolderSubtreeIds, kbTree, resolveKbFolderPath } from '../knowledge/folders.js';
import { outlineSections, readSection } from '../knowledge/sections.js';
import { runKnowledgeAgentAction } from '../platform/knowledge/agent-adapter.js';
import type { KnowledgeActionId } from '../platform/knowledge/adapter.js';

/**
 * A result set whose BEST hit scores below this is nothing but scattered body
 * words. Calibrated against the real 指南 column rather than derived from
 * PostgreSQL's weight table — the measured spread is what matters:
 *
 *   query                 top hit   verdict
 *   "第二大脑"              1.00      title match
 *   "知识库" / "登录"        0.66      title match
 *   (ordinary body hits)   0.12–0.19
 *   "zzz 完全无关的词"       0.14      NOTHING relevant — jieba split it and the
 *                                    OR pass matched 完全/无关/词 in prose
 *
 * The junk query overlaps the body-hit band, so no threshold separates them by
 * score alone; what separates them is that junk never reaches a title/summary.
 * Hence the gate sits just above the body band: "no document matched better
 * than a few loose words in its prose". A first guess of 0.05 (below the body
 * floor, theory-derived) never fired on that junk query at all.
 *
 * Weak hits are still RETURNED — annotated, never filtered. The model can judge
 * a snippet; a hidden result cannot be judged by anyone.
 */
const WEAK_RELEVANCE_MAX = 0.2;

/** Documents listed by one `tree` call before it says it truncated. */
const TREE_DOC_LIMIT = 400;

/**
 * Above this, a full `get` also points at outline/section. Set where the
 * cheaper read actually wins: a 7k doc of six sections costs ~7k to read whole
 * versus ~1.4k as outline + one section, while the seeded 指南 docs (~1.3k,
 * 3–6 short sections) would only be made more expensive by the extra round
 * trip. The note is advice printed NEXT TO the full body — nothing is withheld.
 */
const LONG_DOC_CHARS = 6_000;

const knowledgeQuerySchema = z.object({
  action: z
    .enum(['search', 'get', 'list', 'tree', 'versions'])
    .describe(
      '"tree": browse folders and the docs filed in each (team/personal only) — use it first when you do not know what exists. "search": keyword search. "get": read one doc. "list": recent docs. "versions": a doc\'s change history.',
    ),
  scope: z
    .enum(['team', 'personal', 'shared'])
    .default('team')
    .describe('Knowledge scope: team docs, your own personal docs, or docs others shared with you.'),
  query: z.string().optional().describe('Search query for search/list filtering.'),
  doc_id: z
    .string()
    .optional()
    .describe(
      'Document id for get/versions. Accepts either the numeric `id` or the string `doc_id`, exactly as returned by search/tree results or a document link.',
    ),
  folder: z
    .string()
    .optional()
    .describe(
      'Restrict to this folder and its subfolders, e.g. "Engineering" or "Guides/Onboarding" (team/personal only). For tree/search/list. Use action=tree to see which folders exist.',
    ),
  mode: z
    .enum(['full', 'outline', 'section'])
    .optional()
    .describe(
      'For get (default full). "outline": headings + section sizes only, no body — use for long docs. "section": just the section named by `section`.',
    ),
  section: z.string().optional().describe('For get with mode=section: the exact heading, e.g. "Specifications".'),
  limit: z.number().min(1).max(50).optional().describe('Max results (default 10).'),
  offset: z.number().min(0).optional().describe('List offset.'),
});

type KnowledgeQueryInput = z.infer<typeof knowledgeQuerySchema>;

export interface KnowledgeQueryContext {
  userId: string;
}

/**
 * Canonical in-app deeplink for a KB doc. Cite this in answers so the link never
 * breaks (spec D16); the format itself lives in `@greenhouse/types/entity-links`.
 */
function kbDocUrl(id: number, slug: string): string {
  return entityUrl({ kind: 'kb_doc', id, slug });
}

/**
 * Two id namespaces reach this tool: the string `doc_id` key and the numeric
 * row `id` that search results, tree results and deep links
 * (#/knowledge/doc/<id>-…) expose. Models legitimately arrive with the numeric
 * one; refusing it produced a steady stream of false "not found"s for docs that
 * existed (dev frictions, 2026-08). The text key is tried first so a
 * digits-only doc_id keeps winning, and the numeric fallback re-imposes the
 * scope the text lookup enforces — it widens the key format, not the pool.
 */
async function resolveDoc(db: DatabaseProvider, docId: string, scope: string) {
  const key = docId.trim();
  const doc = await db.knowledgeBase.get(key, scope);
  if (doc) return doc;
  if (!/^\d+$/.test(key)) return undefined;
  const byId = await db.knowledgeBase.getById(Number(key));
  return byId && byId.scope === scope ? byId : undefined;
}

/** Naming the recovery matters more than naming the failure. */
function notFound(docId: string): string {
  return `Document not found: "${docId}". Use action=search (or action=tree) to find the document and read its id from the results rather than guessing one.`;
}

/**
 * Tell the caller when nothing better than a marginal keyword match came back.
 * Silence here is how a 0.02-relevance hit becomes an authoritative citation.
 */
function weakMatchFlag(results: Array<{ relevance: number }>) {
  if (results.length === 0 || !results.every((r) => r.relevance < WEAK_RELEVANCE_MAX)) return {};
  return {
    weak_match: true,
    note: 'Every hit is a marginal keyword match. Prefer telling the user you found nothing authoritative over answering from these.',
  };
}

/** Shape a document body according to `mode`, telling the truth about size. */
function renderBody(input: KnowledgeQueryInput, content: string) {
  if (input.mode === 'outline') {
    return { mode: 'outline' as const, chars: content.length, outline: outlineSections(content) };
  }
  if (input.mode === 'section') {
    if (!input.section) return { error: 'section is required when mode=section' };
    const found = readSection(content, input.section);
    return found.ok
      ? { mode: 'section' as const, heading: found.heading, content: found.content }
      : { error: found.error };
  }
  return {
    content,
    // Never truncate silently; offer the cheaper read instead.
    ...(content.length > LONG_DOC_CHARS
      ? {
          note: `This document is ${content.length} characters. Use mode=outline, then mode=section, to read only what you need.`,
        }
      : {}),
  };
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'knowledge_query',
  name: 'Knowledge',
  brief: 'Browse, search and read team, personal and shared knowledge documents',
  description: `Read-only knowledge base. Actions: tree, search, get, list, versions. Scopes: \`team\` (the shared team record — for anything it covers it is the authoritative source), \`personal\` (only the current user's own docs), \`shared\` (private docs other people shared with you).

Work it like a filesystem: \`tree\` to see which folders exist, \`search\` to find documents (pass \`folder\` to scope the search to one folder and its subfolders), \`get\` to read one. Search in the language the documents are written in. For a long doc use mode=outline and then mode=section instead of pulling the whole body into context. If every hit comes back marked \`weak_match\`, say you found nothing authoritative rather than answering from it.

Team docs typically hold product facts, brand guidelines, SOPs, team notes, architecture, deployment and engineering conventions. A doc's own tables and fields are the authoritative place for its numbers — never assemble figures from prose elsewhere, and treat a field marked as unconfirmed as genuinely unknown rather than filling it from memory. Internal-only — never expose to external users.

${CITE_URL_INSTRUCTION}`,
  category: 'team',
  is_global: true,
  surface: { proxy: 'read', mcp: 'knowledge', workbench: true, unattendedReplaySafe: true },
  icon: 'BookOpen',
  sort_order: 16,
};

export function createKnowledgeQueryTool(db: DatabaseProvider, ctx: KnowledgeQueryContext) {
  const legacyTool = tool({
    description: meta.description,
    inputSchema: knowledgeQuerySchema,
    execute: async (input: KnowledgeQueryInput) => {
      try {
        const limit = input.limit ?? 10;

        // ─── shared: private docs OTHERS shared with the caller ───
        if (input.scope === 'shared') {
          if (input.action === 'tree') {
            return {
              error:
                'tree is only available for team/personal scope — docs shared with you are a flat list, not a folder tree. Use action=list or action=search.',
            };
          }
          if (input.action === 'search') {
            if (!input.query) return { error: 'query is required for action=search' };
            // FTS + grant join in SQL. This scope used to load every shared doc
            // and substring-match it in memory while the query below existed.
            const results = await db.knowledgeBase.searchShared(input.query, ctx.userId, { limit });
            const paths = await kbFolderPaths(
              db,
              results.map((r) => r.folder_id).filter((id): id is number => id != null),
            );
            return {
              scope: 'shared',
              found: results.length,
              ...weakMatchFlag(results),
              results: results.map((r) => ({
                id: r.id,
                doc_id: r.doc_id,
                url: kbDocUrl(r.id, r.doc_id),
                title: r.title,
                summary: r._summary || '',
                snippet: r.snippet,
                access: r.access,
                relevance: Math.round(r.relevance * 100) / 100,
                ...(r.folder_id != null ? { folder: paths.get(r.folder_id) } : {}),
              })),
            };
          }

          const ids = await db.knowledgeShares.listDocIdsForUser(ctx.userId);
          const shared = (await db.knowledgeBase.listByIds(ids, { status: 'published' })).filter(
            (d) => d.visibility === 'private' && d.owner_user_id !== ctx.userId,
          );

          if (input.action === 'get' || input.action === 'versions') {
            if (!input.doc_id) return { error: `doc_id is required for action=${input.action}` };
            const key = input.doc_id.trim();
            const doc = shared.find((d) => d.doc_id === key || String(d.id) === key);
            if (!doc) return { error: notFound(key) };
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
              id: doc.id,
              doc_id: doc.doc_id,
              url: kbDocUrl(doc.id, doc.doc_id),
              title: doc.title,
              ...renderBody(input, doc.content),
              tags: safeJsonParse(doc.tags, []),
              summary: doc._summary || '',
            };
          }

          const q = (input.query || '').toLowerCase();
          const matched = q ? shared.filter((d) => d.title.toLowerCase().includes(q)) : shared;
          return {
            scope: 'shared',
            found: matched.length,
            results: matched.slice(0, limit).map((d) => ({
              id: d.id,
              doc_id: d.doc_id,
              url: kbDocUrl(d.id, d.doc_id),
              title: d.title,
              summary: d._summary || '',
              tags: safeJsonParse(d.tags, []),
              updated_at: d.updated_at,
            })),
          };
        }

        // ─── team / personal: the same table, two access boundaries ───
        const scope = 'shared';
        const visibility = input.scope === 'team' ? 'team' : 'private';
        const ownerUserId = input.scope === 'personal' ? ctx.userId : undefined;
        const folderScope = { visibility, ownerUserId: ctx.userId } as const;

        // Folder → subtree ids, shared by tree/search/list. Resolution is scoped
        // exactly like a move is guarded: a team doc only ever sees team folders,
        // a personal doc only the owner's own.
        let folderIds: number[] | undefined;
        let folderPath: string | undefined;
        if (input.folder !== undefined && input.action !== 'get' && input.action !== 'versions') {
          const resolved = await resolveKbFolderPath(db, input.folder, folderScope);
          if (!resolved.ok) return { error: resolved.error };
          if (resolved.folderId != null) {
            folderIds = await kbFolderSubtreeIds(db, resolved.folderId, folderScope);
            folderPath = resolved.path;
          }
        }

        if (input.action === 'tree') {
          const tree = await kbTree(db, folderScope, {
            rootId: folderIds ? folderIds[0] : null,
            docLimit: TREE_DOC_LIMIT,
          });
          return {
            scope: input.scope,
            root: folderPath ?? '/',
            folders: tree.folders,
            total_docs: tree.total_docs,
            ...(tree.truncated
              ? {
                  truncated: true,
                  note: `Only the first ${TREE_DOC_LIMIT} documents are listed. Narrow with \`folder\`, or use action=search.`,
                }
              : {}),
          };
        }

        if (input.action === 'search') {
          if (!input.query) return { error: 'query is required for action=search' };
          const results = await db.knowledgeBase.search(input.query, {
            scope,
            status: 'published',
            visibility,
            ownerUserId,
            folderIds,
            limit,
          });
          const paths = await kbFolderPaths(
            db,
            results.map((r) => r.folder_id).filter((id): id is number => id != null),
          );
          return {
            scope: input.scope,
            ...(folderPath ? { folder: folderPath } : {}),
            found: results.length,
            ...weakMatchFlag(results),
            results: results.map((r) => ({
              id: r.id,
              doc_id: r.doc_id,
              url: kbDocUrl(r.id, r.doc_id),
              title: r.title,
              summary: r._summary || '',
              snippet: r.snippet,
              tags: safeJsonParse(r.tags, []),
              relevance: Math.round(r.relevance * 100) / 100,
              ...(r.folder_id != null ? { folder: paths.get(r.folder_id) } : {}),
            })),
          };
        }

        if (input.action === 'get' || input.action === 'versions') {
          if (!input.doc_id) return { error: `doc_id is required for action=${input.action}` };
          const doc = await resolveDoc(db, input.doc_id, scope);
          // Team and personal docs both have user_id=NULL; personal ownership is
          // enforced by the owner check below, not by user_id.
          if (!doc || doc.status === 'archived' || doc.visibility !== visibility) {
            return { error: notFound(input.doc_id) };
          }
          if (input.scope === 'personal' && doc.owner_user_id !== ctx.userId) {
            return { error: notFound(input.doc_id) };
          }

          if (input.action === 'versions') {
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

          return {
            scope: input.scope,
            id: doc.id,
            doc_id: doc.doc_id,
            url: kbDocUrl(doc.id, doc.doc_id),
            title: doc.title,
            ...renderBody(input, doc.content),
            tags: safeJsonParse(doc.tags, []),
            summary: doc._summary || '',
            ...(doc.folder_id != null ? { folder: await kbFolderPath(db, doc.folder_id) } : {}),
          };
        }

        const docs = await db.knowledgeBase.list({
          scope,
          status: 'published',
          visibility,
          ownerUserId,
          folderIds,
          search: input.query,
          limit,
          offset: input.offset,
        });
        const paths = await kbFolderPaths(
          db,
          docs.map((d) => d.folder_id).filter((id): id is number => id != null),
        );
        return {
          scope: input.scope,
          ...(folderPath ? { folder: folderPath } : {}),
          found: docs.length,
          results: docs.map((d) => ({
            id: d.id,
            doc_id: d.doc_id,
            url: kbDocUrl(d.id, d.doc_id),
            title: d.title,
            summary: d._summary || '',
            tags: safeJsonParse(d.tags, []),
            updated_at: d.updated_at,
            ...(d.folder_id != null ? { folder: paths.get(d.folder_id) } : {}),
          })),
        };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
  const legacyExecute = legacyTool.execute!;
  return {
    ...legacyTool,
    execute: async (input: KnowledgeQueryInput, options: Parameters<typeof legacyExecute>[1]) => {
      const actionId: KnowledgeActionId =
        input.action === 'versions'
          ? 'listVersions'
          : input.action === 'get'
            ? 'readDocument'
            : input.action === 'search'
              ? 'searchDocuments'
              : // `tree` is an ordinary library read — same capability as list.
                'listDocuments';
      return runKnowledgeAgentAction(ctx, actionId, input, () => legacyExecute(input, options), input.doc_id);
    },
  };
}

export const knowledgeQueryTool = defineTool({ meta, kind: 'lazy' });
