/**
 * Knowledge base service — internal knowledge base (PostgreSQL).
 *
 * Isolated from the public-facing `sources` table.
 * Supports editable team docs, Tiptap JSON state, Markdown canonical content,
 * versions, FTS, and incremental ingest via content_hash.
 */

import { eq, and, sql, isNull, ilike, like, or, desc, asc, gt, inArray } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { knowledgeBase, knowledgeBaseVersions, kbLinks } from '../schema/index.js';
import type { KnowledgeDocRow, KnowledgeDocVersionRow } from '../schema/knowledge-base.js';
import { segmentForFts, buildSegmentedTsQuery, buildSnippet, jsonArrayToText } from './fts.js';

/**
 * Extract the target doc ids of canonical internal links
 * `#/knowledge/doc/<id>-<slug>` (the slug part is optional/decorative) from a
 * doc's Markdown. Used to rebuild a doc's outlinks on save.
 */
export function extractDocLinkIds(content: string): number[] {
  const ids = new Set<number>();
  const re = /#\/knowledge\/doc\/(\d+)/g;
  for (const m of content.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) ids.add(n);
  }
  return [...ids];
}

/** Recompute the weighted jieba token columns from a doc's text fields. */
function kbTokens(fields: {
  title?: string | null;
  tagsText?: string | null;
  summary?: string | null;
  questionsText?: string | null;
  content?: string | null;
  topicsText?: string | null;
}): { _tokens_a: string; _tokens_b: string; _tokens_c: string } {
  const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' ');
  return {
    _tokens_a: segmentForFts(join(fields.title, fields.tagsText)),
    _tokens_b: segmentForFts(join(fields.summary, fields.questionsText)),
    _tokens_c: segmentForFts(join(fields.content, fields.topicsText)),
  };
}

export interface KnowledgeDocInput {
  doc_id: string;
  scope?: string;
  title: string;
  content: string;
  content_json?: string | null;
  content_hash?: string | null;
  visibility?: string;
  status?: string;
  is_template?: boolean;
  tags?: string[];
  meta?: Record<string, unknown>;
  file_path?: string | null;
  folder_id?: number | null;
  owner_user_id?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  _summary?: string;
  _questions?: string[];
  _topics?: string[];
}

export interface KnowledgeDocUpdateInput {
  doc_id?: string;
  title?: string;
  content?: string;
  content_json?: string | null;
  visibility?: string;
  status?: string;
  is_template?: boolean;
  tags?: string[];
  meta?: Record<string, unknown>;
  folder_id?: number | null;
  owner_user_id?: string | null;
  _summary?: string;
  _questions?: string[];
  _topics?: string[];
}

export interface KnowledgeSearchResult {
  id: number;
  doc_id: string;
  title: string;
  _summary: string | null;
  snippet: string;
  tags: string;
  relevance: number;
  /** Folder the doc is filed in (null = root); the tools render it as a path. */
  folder_id: number | null;
}

/** A shared-with-me hit carries the caller's effective role on the doc. */
export interface KnowledgeSharedSearchResult extends KnowledgeSearchResult {
  access: 'editor' | 'reader';
}

export interface KnowledgeListOpts {
  scope?: string;
  /** Filter by the `owner_user_id` column (the document creator). */
  ownerUserId?: string | null;
  visibility?: string;
  status?: string;
  space?: string;
  search?: string;
  /**
   * Restrict to documents filed in these folders. Callers pass an already
   * expanded subtree (see `kbFolderSubtreeIds`); an empty array matches nothing,
   * `undefined` means no folder restriction at all.
   */
  folderIds?: number[];
  limit?: number;
  offset?: number;
}

export interface KnowledgeSearchOpts {
  scope?: string;
  /** Filter by the `owner_user_id` column (the document creator). */
  ownerUserId?: string | null;
  visibility?: string;
  status?: string;
  /** Same semantics as KnowledgeListOpts.folderIds. */
  folderIds?: number[];
  limit?: number;
}

/**
 * `folder_id IN (…)` for the raw-SQL search paths. An EMPTY array must match
 * nothing rather than everything: it means "the caller asked for a folder whose
 * subtree turned out empty", and widening that to the whole library would
 * silently answer a scoped question with unscoped results.
 */
function folderFilter(folderIds: number[] | undefined, prefix: '' | 'kb.') {
  if (folderIds === undefined) return sql``;
  if (folderIds.length === 0) return sql`AND false`;
  const column = prefix === 'kb.' ? sql`kb.folder_id` : sql`folder_id`;
  return sql`AND ${column} IN ${sql`(${sql.join(
    folderIds.map((id) => sql`${id}`),
    sql`, `,
  )})`}`;
}

export function createKnowledgeBaseService(db: Db) {
  const service = {
    async upsert(doc: KnowledgeDocInput): Promise<void> {
      const now = nowIso();
      const tokens = kbTokens({
        title: doc.title,
        tagsText: (doc.tags ?? []).join(' '),
        summary: doc._summary,
        questionsText: (doc._questions ?? []).join(' '),
        content: doc.content,
        topicsText: (doc._topics ?? []).join(' '),
      });
      const values = {
        doc_id: doc.doc_id,
        scope: doc.scope ?? 'shared',
        title: doc.title,
        content: doc.content,
        content_json: doc.content_json ?? '{}',
        content_hash: doc.content_hash ?? null,
        visibility: doc.visibility ?? 'team',
        status: doc.status ?? 'published',
        tags: JSON.stringify(doc.tags ?? []),
        meta: JSON.stringify(doc.meta ?? {}),
        file_path: doc.file_path ?? null,
        folder_id: doc.folder_id ?? null,
        owner_user_id: doc.owner_user_id ?? doc.created_by ?? null,
        created_by: doc.created_by ?? null,
        updated_by: doc.updated_by ?? doc.created_by ?? null,
        _summary: doc._summary ?? '',
        _questions: JSON.stringify(doc._questions ?? []),
        _topics: JSON.stringify(doc._topics ?? []),
        ...tokens,
        created_at: now,
        updated_at: now,
      };

      await db
        .insert(knowledgeBase)
        .values(values)
        .onConflictDoUpdate({
          target: [knowledgeBase.doc_id, knowledgeBase.scope],
          set: {
            title: values.title,
            content: values.content,
            content_json: values.content_json,
            content_hash: values.content_hash,
            visibility: values.visibility,
            status: values.status,
            tags: values.tags,
            meta: values.meta,
            file_path: values.file_path,
            owner_user_id: values.owner_user_id,
            updated_by: values.updated_by,
            updated_at: values.updated_at,
            // Clear enrichment on ingest/content change unless explicitly provided.
            _summary: values._summary,
            _questions: values._questions,
            _topics: values._topics,
            _enriched_at: doc._summary || doc._questions || doc._topics ? now : null,
            ...tokens,
          },
        });
    },

    async create(doc: KnowledgeDocInput): Promise<KnowledgeDocRow> {
      const now = nowIso();
      const tokens = kbTokens({
        title: doc.title,
        tagsText: (doc.tags ?? []).join(' '),
        summary: doc._summary,
        questionsText: (doc._questions ?? []).join(' '),
        content: doc.content,
        topicsText: (doc._topics ?? []).join(' '),
      });
      const inserted = await db
        .insert(knowledgeBase)
        .values({
          doc_id: doc.doc_id,
          scope: doc.scope ?? 'shared',
          title: doc.title,
          content: doc.content,
          content_json: doc.content_json ?? '{}',
          content_hash: doc.content_hash ?? null,
          visibility: doc.visibility ?? 'team',
          status: doc.status ?? 'published',
          is_template: doc.is_template ?? false,
          tags: JSON.stringify(doc.tags ?? []),
          meta: JSON.stringify(doc.meta ?? {}),
          file_path: doc.file_path ?? null,
          folder_id: doc.folder_id ?? null,
          owner_user_id: doc.owner_user_id ?? doc.created_by ?? null,
          created_by: doc.created_by ?? null,
          updated_by: doc.updated_by ?? doc.created_by ?? null,
          _summary: doc._summary ?? '',
          _questions: JSON.stringify(doc._questions ?? []),
          _topics: JSON.stringify(doc._topics ?? []),
          _enriched_at: doc._summary || doc._questions || doc._topics ? now : null,
          ...tokens,
          created_at: now,
          updated_at: now,
        })
        .returning();

      const row = inserted[0]!;
      await service.createVersion(row, doc.created_by ?? doc.updated_by ?? null, 'Created document');
      return row;
    },

    async update(
      id: number,
      updates: KnowledgeDocUpdateInput,
      changedBy?: string | null,
      reason = 'Updated document',
    ): Promise<KnowledgeDocRow | undefined> {
      const current = await service.getById(id);
      if (!current) return undefined;

      const setValues: Record<string, unknown> = { updated_at: nowIso(), updated_by: changedBy ?? null };
      if (updates.doc_id !== undefined) setValues.doc_id = updates.doc_id;
      if (updates.title !== undefined) setValues.title = updates.title;
      if (updates.content !== undefined) setValues.content = updates.content;
      if (updates.content_json !== undefined) setValues.content_json = updates.content_json ?? '{}';
      // Markdown is canonical. If `content` changed but no fresh Tiptap JSON was supplied
      // (e.g. agent knowledge_mutation only sends Markdown), clear the now-stale JSON so the
      // editor falls back to rendering the new Markdown instead of showing the old content.
      else if (updates.content !== undefined) setValues.content_json = '{}';
      if (updates.visibility !== undefined) setValues.visibility = updates.visibility;
      if (updates.status !== undefined) setValues.status = updates.status;
      if (updates.is_template !== undefined) setValues.is_template = updates.is_template;
      if (updates.tags !== undefined) setValues.tags = JSON.stringify(updates.tags);
      if (updates.meta !== undefined) setValues.meta = JSON.stringify(updates.meta);
      if (updates.folder_id !== undefined) setValues.folder_id = updates.folder_id;
      if (updates.owner_user_id !== undefined) setValues.owner_user_id = updates.owner_user_id;
      if (updates._summary !== undefined) setValues._summary = updates._summary;
      if (updates._questions !== undefined) setValues._questions = JSON.stringify(updates._questions);
      if (updates._topics !== undefined) setValues._topics = JSON.stringify(updates._topics);
      if (updates._summary !== undefined || updates._questions !== undefined || updates._topics !== undefined) {
        setValues._enriched_at = nowIso();
      } else if (updates.content !== undefined) {
        setValues._enriched_at = null;
      }

      // Recompute the weighted jieba token columns whenever a searchable field
      // changed, merging the incoming updates over the current stored values.
      const touchesTokens =
        updates.title !== undefined ||
        updates.tags !== undefined ||
        updates.content !== undefined ||
        updates._summary !== undefined ||
        updates._questions !== undefined ||
        updates._topics !== undefined;
      if (touchesTokens) {
        Object.assign(
          setValues,
          kbTokens({
            title: updates.title ?? current.title,
            tagsText: updates.tags ? updates.tags.join(' ') : jsonArrayToText(current.tags),
            summary: updates._summary ?? current._summary,
            questionsText: updates._questions ? updates._questions.join(' ') : jsonArrayToText(current._questions),
            content: updates.content ?? current.content,
            topicsText: updates._topics ? updates._topics.join(' ') : jsonArrayToText(current._topics),
          }),
        );
      }

      const rows = await db.update(knowledgeBase).set(setValues).where(eq(knowledgeBase.id, id)).returning();
      const updated = rows[0];
      if (updated) await service.createVersion(updated, changedBy ?? null, reason);
      return updated;
    },

    async archive(id: number, changedBy?: string | null): Promise<boolean> {
      const row = await service.update(id, { status: 'archived' }, changedBy, 'Archived document');
      return !!row;
    },

    async get(docId: string, scope = 'shared'): Promise<KnowledgeDocRow | undefined> {
      const conditions = and(eq(knowledgeBase.doc_id, docId), eq(knowledgeBase.scope, scope));

      const rows = await db.select().from(knowledgeBase).where(conditions).limit(1);
      return rows[0] ?? undefined;
    },

    async getById(id: number): Promise<KnowledgeDocRow | undefined> {
      const rows = await db.select().from(knowledgeBase).where(eq(knowledgeBase.id, id)).limit(1);
      return rows[0] ?? undefined;
    },

    async search(query: string, opts?: KnowledgeSearchOpts): Promise<KnowledgeSearchResult[]> {
      const limit = opts?.limit ?? 10;
      const scope = opts?.scope ?? 'shared';
      const status = opts?.status ?? 'published';
      const andQuery = buildSegmentedTsQuery(query, '&');
      const orQuery = buildSegmentedTsQuery(query, '|');

      if (!andQuery && !orQuery) {
        return service.searchLike(query, { ...opts, scope, status }, limit);
      }

      const ownerClause = opts?.ownerUserId ? sql`AND kb.owner_user_id = ${opts.ownerUserId}` : sql``;
      const visibilityClause = opts?.visibility ? sql`AND kb.visibility = ${opts.visibility}` : sql``;
      const folderClause = folderFilter(opts?.folderIds, 'kb.');

      // Query the jieba-segmented token columns so Chinese sentences word-match.
      const weightedTsVector = sql`(
        setweight(to_tsvector('simple', kb._tokens_a), 'A') ||
        setweight(to_tsvector('simple', kb._tokens_b), 'B') ||
        setweight(to_tsvector('simple', kb._tokens_c), 'C')
      )`;

      // Two passes: AND first (precision), then OR TOPS UP the remaining slots
      // (recall). Returning on the first non-empty pass instead let a single
      // mediocre AND hit hide the entire OR candidate set.
      const collected: (KnowledgeSearchResult & { content: string })[] = [];
      const seen = new Set<number>();
      for (const tsQuery of [andQuery, orQuery]) {
        if (!tsQuery || collected.length >= limit) continue;
        try {
          const result = await db.execute(sql`
            SELECT kb.id, kb.doc_id, kb.title, kb._summary, kb.tags, kb.folder_id, kb.content,
                   ts_rank(${weightedTsVector}, to_tsquery('simple', ${tsQuery})) as relevance
            FROM knowledge_base kb
            WHERE ${weightedTsVector} @@ to_tsquery('simple', ${tsQuery})
              AND kb.scope = ${scope}
              AND kb.status = ${status}
            ${ownerClause}
            ${visibilityClause}
            ${folderClause}
            ORDER BY relevance DESC
            LIMIT ${limit}
          `);
          for (const row of result as unknown as (KnowledgeSearchResult & { content: string })[]) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            collected.push(row);
            if (collected.length >= limit) break;
          }
        } catch {
          /* try next variant, then ILIKE */
        }
      }
      if (collected.length > 0) {
        // ts_headline can't align with segmented tokens; build the CJK snippet
        // in the app layer from the raw content, then drop the content column.
        return collected.map(({ content, ...r }) => ({ ...r, snippet: buildSnippet(content, query) }));
      }
      return service.searchLike(query, { ...opts, scope, status }, limit);
    },

    /**
     * Search PRIVATE docs shared WITH the caller (never their own): FTS over the
     * jieba token columns, gated by a share grant (direct or via a group the
     * caller belongs to). The strongest matching role (editor > reader) rides
     * along as `access`. Access is enforced in SQL — the app never post-filters —
     * so the gate matches `resolveKbAccess`. Falls back to ILIKE like `search`.
     */
    async searchShared(
      query: string,
      userId: string,
      opts?: { status?: string; limit?: number },
    ): Promise<KnowledgeSharedSearchResult[]> {
      const limit = opts?.limit ?? 10;
      const status = opts?.status ?? 'published';
      const andQuery = buildSegmentedTsQuery(query, '&');
      const orQuery = buildSegmentedTsQuery(query, '|');

      // The caller's grant on each doc, folded to the strongest role. A LATERAL
      // join both gates the row (INNER → no grant, no row) and surfaces the role.
      const grantJoin = sql`
        JOIN LATERAL (
          SELECT s.role FROM knowledge_base_shares s
          WHERE s.doc_id = kb.id
            AND (
              s.shared_with = ${userId}
              OR s.shared_with IN (SELECT 'group:' || group_id FROM group_members WHERE user_id = ${userId})
            )
          ORDER BY CASE s.role WHEN 'editor' THEN 0 ELSE 1 END
          LIMIT 1
        ) g ON true
      `;

      if (!andQuery && !orQuery) {
        return service.searchSharedLike(query, userId, grantJoin, status, limit);
      }

      const weightedTsVector = sql`(
        setweight(to_tsvector('simple', kb._tokens_a), 'A') ||
        setweight(to_tsvector('simple', kb._tokens_b), 'B') ||
        setweight(to_tsvector('simple', kb._tokens_c), 'C')
      )`;

      // AND for precision, then OR to top up the remaining slots (same rule as
      // `search` — a lone AND hit must not hide the OR candidates).
      const collected: (KnowledgeSharedSearchResult & { content: string })[] = [];
      const seen = new Set<number>();
      for (const tsQuery of [andQuery, orQuery]) {
        if (!tsQuery || collected.length >= limit) continue;
        try {
          const result = await db.execute(sql`
            SELECT kb.id, kb.doc_id, kb.title, kb._summary, kb.tags, kb.folder_id, kb.content,
                   ts_rank(${weightedTsVector}, to_tsquery('simple', ${tsQuery})) as relevance,
                   g.role as access
            FROM knowledge_base kb
            ${grantJoin}
            WHERE ${weightedTsVector} @@ to_tsquery('simple', ${tsQuery})
              AND kb.scope = 'shared'
              AND kb.status = ${status}
              AND kb.visibility = 'private'
              AND kb.owner_user_id IS DISTINCT FROM ${userId}
            ORDER BY relevance DESC
            LIMIT ${limit}
          `);
          for (const row of result as unknown as (KnowledgeSharedSearchResult & { content: string })[]) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            collected.push(row);
            if (collected.length >= limit) break;
          }
        } catch {
          /* try next variant, then ILIKE */
        }
      }
      if (collected.length > 0) {
        return collected.map(({ content, ...r }) => ({ ...r, snippet: buildSnippet(content, query) }));
      }
      return service.searchSharedLike(query, userId, grantJoin, status, limit);
    },

    async searchSharedLike(
      query: string,
      _userId: string,
      grantJoin: ReturnType<typeof sql>,
      status: string,
      limit: number,
    ): Promise<KnowledgeSharedSearchResult[]> {
      const like = `%${query}%`;
      const result = await db.execute(sql`
        SELECT kb.id, kb.doc_id, kb.title, kb._summary, kb.tags, kb.folder_id,
               SUBSTRING(kb.content, 1, 240) as snippet, 1.0 as relevance, g.role as access
        FROM knowledge_base kb
        ${grantJoin}
        WHERE kb.scope = 'shared'
          AND kb.status = ${status}
          AND kb.visibility = 'private'
          AND kb.owner_user_id IS DISTINCT FROM ${_userId}
          AND (
            kb.title ILIKE ${like} OR kb.content ILIKE ${like}
            OR kb._summary ILIKE ${like} OR kb._questions ILIKE ${like}
            OR kb._topics ILIKE ${like} OR kb.tags ILIKE ${like}
          )
        ORDER BY CASE WHEN kb.title ILIKE ${like} THEN 0 ELSE 1 END, kb.updated_at DESC, kb.title
        LIMIT ${limit}
      `);
      return result as unknown as KnowledgeSharedSearchResult[];
    },

    async listAll(scope = 'shared'): Promise<KnowledgeDocRow[]> {
      const conditions = and(eq(knowledgeBase.scope, scope));

      return db.select().from(knowledgeBase).where(conditions).orderBy(desc(knowledgeBase.updated_at));
    },

    async list(opts?: KnowledgeListOpts): Promise<KnowledgeDocRow[]> {
      const scope = opts?.scope ?? 'shared';
      const status = opts?.status ?? 'published';
      const conditions = [eq(knowledgeBase.scope, scope), eq(knowledgeBase.status, status)];
      if (opts?.ownerUserId) conditions.push(eq(knowledgeBase.owner_user_id, opts.ownerUserId));
      if (opts?.visibility) conditions.push(eq(knowledgeBase.visibility, opts.visibility));
      if (opts?.space) conditions.push(sql`${knowledgeBase.meta}::jsonb ->> 'space' = ${opts.space}`);
      // An empty folder set matches nothing (see folderFilter) — never widen.
      if (opts?.folderIds !== undefined) {
        conditions.push(opts.folderIds.length === 0 ? sql`false` : inArray(knowledgeBase.folder_id, opts.folderIds));
      }
      if (opts?.search) {
        const like = `%${opts.search}%`;
        conditions.push(
          or(
            ilike(knowledgeBase.title, like),
            ilike(knowledgeBase.content, like),
            ilike(knowledgeBase._summary!, like),
          )!,
        );
      }

      return db
        .select()
        .from(knowledgeBase)
        .where(and(...conditions))
        .orderBy(desc(knowledgeBase.updated_at))
        .limit(opts?.limit ?? 50)
        .offset(opts?.offset ?? 0);
    },

    /** Team-visible templates for the "new from template" picker. */
    async listTemplates(): Promise<KnowledgeDocRow[]> {
      return db
        .select()
        .from(knowledgeBase)
        .where(
          and(
            eq(knowledgeBase.is_template, true),
            eq(knowledgeBase.visibility, 'team'),
            eq(knowledgeBase.scope, 'shared'),
          ),
        )
        .orderBy(asc(knowledgeBase.title));
    },

    /** Fetch docs by their numeric ids (used to resolve shared-with-me docs). */
    async listByIds(ids: number[], opts?: { status?: string }): Promise<KnowledgeDocRow[]> {
      if (ids.length === 0) return [];
      const conditions = [inArray(knowledgeBase.id, ids)];
      if (opts?.status) conditions.push(eq(knowledgeBase.status, opts.status));
      return db
        .select()
        .from(knowledgeBase)
        .where(and(...conditions))
        .orderBy(desc(knowledgeBase.updated_at));
    },

    async delete(docId: string, scope = 'shared'): Promise<boolean> {
      const result = await db
        .delete(knowledgeBase)
        .where(and(eq(knowledgeBase.doc_id, docId), eq(knowledgeBase.scope, scope)))
        .returning({ id: knowledgeBase.id });
      return result.length > 0;
    },

    async count(scope?: string): Promise<number> {
      const condition = scope ? sql`WHERE scope = ${scope}` : sql``;
      const result = await db.execute(sql`SELECT COUNT(*)::int as count FROM knowledge_base ${condition}`);
      return Number((result as any[])[0]?.count ?? 0);
    },

    /**
     * Rebuild the outgoing links of a doc from its Markdown (the canonical
     * `#/knowledge/doc/<id>` links). Deletes the doc's existing outlinks and
     * inserts the current set — self-links and links to non-existent docs are
     * dropped (the FK requires the target to exist). Idempotent.
     */
    async rebuildOutlinks(fromDocId: number, content: string): Promise<void> {
      const targetIds = extractDocLinkIds(content).filter((id) => id !== fromDocId);
      await db.delete(kbLinks).where(eq(kbLinks.from_doc_id, fromDocId));
      if (targetIds.length === 0) return;
      // Keep only targets that actually exist (FK safety).
      const existing = await db
        .select({ id: knowledgeBase.id })
        .from(knowledgeBase)
        .where(inArray(knowledgeBase.id, targetIds));
      const valid = existing.map((r) => r.id);
      if (valid.length === 0) return;
      const now = nowIso();
      await db
        .insert(kbLinks)
        .values(valid.map((toId) => ({ from_doc_id: fromDocId, to_doc_id: toId, created_at: now })))
        .onConflictDoNothing();
    },

    /**
     * Docs that link TO the given doc (backlinks). Returns the full source rows so
     * the caller can access-filter them (a private doc's title must not leak to a
     * reader who can't open it).
     */
    async listBacklinks(toDocId: number): Promise<KnowledgeDocRow[]> {
      const rows = await db
        .select({ doc: knowledgeBase })
        .from(kbLinks)
        .innerJoin(knowledgeBase, eq(kbLinks.from_doc_id, knowledgeBase.id))
        .where(and(eq(kbLinks.to_doc_id, toDocId), sql`${knowledgeBase.status} <> 'archived'`))
        .orderBy(desc(knowledgeBase.updated_at));
      return rows.map((r) => r.doc);
    },

    /**
     * Hard-delete docs whose `doc_id` starts with a prefix. Only used to reset the
     * benchmark corpus (`bench:` docs) — real knowledge is archived, never dropped.
     */
    async deleteByDocIdPrefix(prefix: string): Promise<number> {
      const rows = await db
        .delete(knowledgeBase)
        .where(like(knowledgeBase.doc_id, `${prefix}%`))
        .returning({ id: knowledgeBase.id });
      return rows.length;
    },

    /**
     * Write a manual sibling order for docs sharing a folder: `ids` in display
     * order become sort_order 1..n in ONE statement (atomic without a
     * transaction). Mirrors `drive.reorderFolders`; authorization and the
     * "these really are siblings" check belong to the caller.
     */
    async reorderDocs(ids: number[]): Promise<void> {
      if (ids.length === 0) return;
      const pairs = ids.map((id, i) => sql`(${id}::int, ${i + 1}::int)`);
      await db.execute(sql`
        UPDATE ${knowledgeBase} SET sort_order = v.ord
        FROM (VALUES ${sql.join(pairs, sql`, `)}) AS v(id, ord)
        WHERE ${knowledgeBase.id} = v.id
      `);
    },

    /** Count non-archived docs placed directly in a folder (folder-delete guard). */
    async countInFolder(folderId: number): Promise<number> {
      const rows = await db
        .select({ cnt: sql<number>`COUNT(*)` })
        .from(knowledgeBase)
        .where(and(eq(knowledgeBase.folder_id, folderId), sql`${knowledgeBase.status} <> 'archived'`));
      return Number(rows[0]?.cnt ?? 0);
    },

    async listUnenriched(limit = 20): Promise<KnowledgeDocRow[]> {
      return db
        .select()
        .from(knowledgeBase)
        .where(and(isNull(knowledgeBase._enriched_at), eq(knowledgeBase.status, 'published')))
        .limit(limit);
    },

    /**
     * Recompute the segmented `_tokens_a/b/c` columns for every row (keyset-paged,
     * idempotent — recompute is deterministic). Used by `cli knowledge reindex`
     * after the migration adds the columns empty. Does NOT bump `updated_at`.
     */
    /**
     * Rows whose segmented FTS tokens were never computed — documents that
     * predate the token columns (added by a migration with empty defaults).
     * Search silently misses them until `reindexTokens` runs.
     */
    async countUntokenized(): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(knowledgeBase)
        .where(
          and(eq(knowledgeBase._tokens_a, ''), sql`(${knowledgeBase.title} <> '' OR ${knowledgeBase.content} <> '')`),
        );
      return rows[0]?.count ?? 0;
    },

    async reindexTokens(batchSize = 200, onProgress?: (done: number) => void): Promise<number> {
      let lastId = 0;
      let total = 0;
      for (;;) {
        const rows = await db
          .select({
            id: knowledgeBase.id,
            title: knowledgeBase.title,
            tags: knowledgeBase.tags,
            content: knowledgeBase.content,
            _summary: knowledgeBase._summary,
            _questions: knowledgeBase._questions,
            _topics: knowledgeBase._topics,
          })
          .from(knowledgeBase)
          .where(gt(knowledgeBase.id, lastId))
          .orderBy(asc(knowledgeBase.id))
          .limit(batchSize);
        if (rows.length === 0) break;
        for (const row of rows) {
          const tokens = kbTokens({
            title: row.title,
            tagsText: jsonArrayToText(row.tags),
            summary: row._summary,
            questionsText: jsonArrayToText(row._questions),
            content: row.content,
            topicsText: jsonArrayToText(row._topics),
          });
          await db.update(knowledgeBase).set(tokens).where(eq(knowledgeBase.id, row.id));
          total++;
        }
        lastId = rows[rows.length - 1]!.id;
        onProgress?.(total);
      }
      return total;
    },

    async listVersions(docId: number): Promise<KnowledgeDocVersionRow[]> {
      return db
        .select()
        .from(knowledgeBaseVersions)
        .where(eq(knowledgeBaseVersions.doc_id, docId))
        .orderBy(desc(knowledgeBaseVersions.version));
    },

    async getVersion(docId: number, version: number): Promise<KnowledgeDocVersionRow | undefined> {
      const rows = await db
        .select()
        .from(knowledgeBaseVersions)
        .where(and(eq(knowledgeBaseVersions.doc_id, docId), eq(knowledgeBaseVersions.version, version)))
        .limit(1);
      return rows[0];
    },

    /**
     * Roll a document back to a prior version. Non-destructive: applies the
     * snapshot via update(), which records a NEW version, so the restore itself
     * is auditable and reversible. Returns undefined if the version is unknown.
     */
    async restoreVersion(id: number, version: number, changedBy?: string | null): Promise<KnowledgeDocRow | undefined> {
      const snapshot = await service.getVersion(id, version);
      if (!snapshot) return undefined;
      // Apply the snapshot through update() so the rollback is itself recorded as a
      // new version (non-destructive history — you can always roll forward again).
      return service.update(
        id,
        {
          title: snapshot.title,
          content: snapshot.content,
          content_json: snapshot.content_json ?? '{}',
          _summary: snapshot.summary ?? '',
        },
        changedBy ?? null,
        `Restored from v${version}`,
      );
    },

    async updateEnrichment(
      id: number,
      data: { _summary: string; _questions: string[]; _topics: string[]; _enriched_at?: string | null },
    ): Promise<void> {
      // Recompute the B/C token tiers that enrichment feeds (title/tags/content
      // for A/C-content come from the existing row). Merge over current values.
      const current = await service.getById(id);
      const tokens = kbTokens({
        title: current?.title,
        tagsText: jsonArrayToText(current?.tags),
        summary: data._summary,
        questionsText: data._questions.join(' '),
        content: current?.content,
        topicsText: data._topics.join(' '),
      });
      await db
        .update(knowledgeBase)
        .set({
          _summary: data._summary,
          _questions: JSON.stringify(data._questions),
          _topics: JSON.stringify(data._topics),
          _enriched_at: data._enriched_at ?? nowIso(),
          updated_at: nowIso(),
          ...tokens,
        })
        .where(eq(knowledgeBase.id, id));
    },

    // ─── Private ─────────────────────────────────────────

    async createVersion(doc: KnowledgeDocRow, changedBy: string | null, reason: string): Promise<void> {
      const row = await db.execute(
        sql`SELECT COALESCE(MAX(version), 0)::int + 1 as next_version FROM knowledge_base_versions WHERE doc_id = ${doc.id}`,
      );
      const version = Number((row as any[])[0]?.next_version ?? 1);
      await db.insert(knowledgeBaseVersions).values({
        doc_id: doc.id,
        version,
        title: doc.title,
        content: doc.content,
        content_json: doc.content_json ?? '{}',
        summary: doc._summary ?? '',
        changed_by: changedBy,
        change_reason: reason,
        created_at: nowIso(),
      });
    },

    async searchLike(query: string, opts: KnowledgeSearchOpts, limit: number): Promise<KnowledgeSearchResult[]> {
      const like = `%${query}%`;
      const scope = opts.scope ?? 'shared';
      const status = opts.status ?? 'published';
      const ownerClause = opts.ownerUserId ? sql`AND owner_user_id = ${opts.ownerUserId}` : sql``;
      const visibilityClause = opts.visibility ? sql`AND visibility = ${opts.visibility}` : sql``;
      const folderClause = folderFilter(opts.folderIds, '');
      const result = await db.execute(sql`
        SELECT id, doc_id, title, _summary, tags, folder_id,
               SUBSTRING(content, 1, 240) as snippet, 1.0 as relevance
        FROM knowledge_base
        WHERE scope = ${scope}
        AND status = ${status}
        ${ownerClause}
        ${visibilityClause}
        ${folderClause}
        AND (
          title ILIKE ${like} OR content ILIKE ${like}
          OR _summary ILIKE ${like} OR _questions ILIKE ${like}
          OR _topics ILIKE ${like} OR tags ILIKE ${like}
        )
        ORDER BY CASE WHEN title ILIKE ${like} THEN 0 ELSE 1 END, updated_at DESC, title
        LIMIT ${limit}
      `);
      return result as unknown as KnowledgeSearchResult[];
    },
  };
  return service;
}

export type KnowledgeBaseService = ReturnType<typeof createKnowledgeBaseService>;
