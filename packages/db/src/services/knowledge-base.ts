/**
 * Knowledge base service — internal knowledge base (PostgreSQL).
 *
 * Isolated from the public-facing `sources` table.
 * Supports editable team docs, Tiptap JSON state, Markdown canonical content,
 * versions, FTS, and incremental ingest via content_hash.
 */

import { eq, and, sql, isNull, ilike, or, desc, inArray } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { knowledgeBase, knowledgeBaseVersions } from '../schema/index.js';
import type { KnowledgeDocRow, KnowledgeDocVersionRow } from '../schema/knowledge-base.js';
import { buildPrefixTsQuery } from './fts.js';

export interface KnowledgeDocInput {
  doc_id: string;
  scope?: string;
  title: string;
  content: string;
  content_json?: string | null;
  content_hash?: string | null;
  visibility?: string;
  status?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  file_path?: string | null;
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
  tags?: string[];
  meta?: Record<string, unknown>;
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
}

export interface KnowledgeListOpts {
  scope?: string;
  /** Filter by the `owner_user_id` column (the document creator). */
  ownerUserId?: string | null;
  visibility?: string;
  status?: string;
  space?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface KnowledgeSearchOpts {
  scope?: string;
  /** Filter by the `owner_user_id` column (the document creator). */
  ownerUserId?: string | null;
  visibility?: string;
  status?: string;
  limit?: number;
}

export function createKnowledgeBaseService(db: Db) {
  const service = {
    async upsert(doc: KnowledgeDocInput): Promise<void> {
      const now = nowIso();
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
        owner_user_id: doc.owner_user_id ?? doc.created_by ?? null,
        created_by: doc.created_by ?? null,
        updated_by: doc.updated_by ?? doc.created_by ?? null,
        _summary: doc._summary ?? '',
        _questions: JSON.stringify(doc._questions ?? []),
        _topics: JSON.stringify(doc._topics ?? []),
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
          },
        });
    },

    async create(doc: KnowledgeDocInput): Promise<KnowledgeDocRow> {
      const now = nowIso();
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
          tags: JSON.stringify(doc.tags ?? []),
          meta: JSON.stringify(doc.meta ?? {}),
          file_path: doc.file_path ?? null,
          owner_user_id: doc.owner_user_id ?? doc.created_by ?? null,
          created_by: doc.created_by ?? null,
          updated_by: doc.updated_by ?? doc.created_by ?? null,
          _summary: doc._summary ?? '',
          _questions: JSON.stringify(doc._questions ?? []),
          _topics: JSON.stringify(doc._topics ?? []),
          _enriched_at: doc._summary || doc._questions || doc._topics ? now : null,
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
      if (updates.tags !== undefined) setValues.tags = JSON.stringify(updates.tags);
      if (updates.meta !== undefined) setValues.meta = JSON.stringify(updates.meta);
      if (updates.owner_user_id !== undefined) setValues.owner_user_id = updates.owner_user_id;
      if (updates._summary !== undefined) setValues._summary = updates._summary;
      if (updates._questions !== undefined) setValues._questions = JSON.stringify(updates._questions);
      if (updates._topics !== undefined) setValues._topics = JSON.stringify(updates._topics);
      if (updates._summary !== undefined || updates._questions !== undefined || updates._topics !== undefined) {
        setValues._enriched_at = nowIso();
      } else if (updates.content !== undefined) {
        setValues._enriched_at = null;
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

    /**
     * Bulk-rename a team "space" (KB category) and every nested descendant.
     * Space is a `/`-delimited path stored in `meta.space`; renaming `eng` →
     * `engineering` also re-paths `eng/backend` → `engineering/backend` so the
     * subtree moves as a whole.
     *
     * Metadata-only by design: it does NOT snapshot a version per doc (versions
     * track title/content, not meta — a rename would only add identical-content
     * noise). Scoped to team docs (`visibility='team'`); personal spaces are
     * never touched. Docs with no explicit space are treated as `general`.
     * Returns the number of documents moved.
     */
    async renameSpace(from: string, to: string, changedBy?: string | null): Promise<number> {
      const currentSpace = sql`COALESCE(meta::jsonb ->> 'space', 'general')`;
      const result = await db.execute(sql`
        UPDATE knowledge_base
        SET meta = jsonb_set(
              meta::jsonb,
              '{space}',
              to_jsonb(
                CASE
                  WHEN ${currentSpace} = ${from} THEN ${to}::text
                  ELSE ${to} || substring(${currentSpace} from length(${from}::text) + 1)
                END
              )
            )::text,
            updated_at = ${nowIso()},
            updated_by = ${changedBy ?? null}
        WHERE scope = 'shared'
          AND visibility = 'team'
          AND (
            ${currentSpace} = ${from}
            OR left(${currentSpace}, length(${from}::text) + 1) = ${from} || '/'
          )
        RETURNING id
      `);
      return (result as any[]).length;
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
      const tsQuery = buildPrefixTsQuery(query);

      if (!tsQuery) {
        return service.searchLike(query, { ...opts, scope, status }, limit);
      }

      try {
        const ownerClause = opts?.ownerUserId ? sql`AND kb.owner_user_id = ${opts.ownerUserId}` : sql``;
        const visibilityClause = opts?.visibility ? sql`AND kb.visibility = ${opts.visibility}` : sql``;

        const weightedTsVector = sql`(
          setweight(to_tsvector('simple', coalesce(kb.title, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(kb._summary, '') || ' ' || coalesce(kb._questions, '')), 'B') ||
          setweight(to_tsvector('simple', coalesce(kb.content, '') || ' ' || coalesce(kb._topics, '')), 'C')
        )`;

        const result = await db.execute(sql`
          SELECT kb.id, kb.doc_id, kb.title, kb._summary, kb.tags,
                 ts_headline('simple', kb.content, to_tsquery('simple', ${tsQuery}),
                   'StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=15'
                 ) as snippet,
                 ts_rank(${weightedTsVector}, to_tsquery('simple', ${tsQuery})) as relevance
          FROM knowledge_base kb
          WHERE ${weightedTsVector} @@ to_tsquery('simple', ${tsQuery})
            AND kb.scope = ${scope}
            AND kb.status = ${status}
          ${ownerClause}
          ${visibilityClause}
          ORDER BY relevance DESC
          LIMIT ${limit}
        `);

        if ((result as any[]).length === 0) {
          return service.searchLike(query, { ...opts, scope, status }, limit);
        }
        return result as unknown as KnowledgeSearchResult[];
      } catch {
        return service.searchLike(query, { ...opts, scope, status }, limit);
      }
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

    async listUnenriched(limit = 20): Promise<KnowledgeDocRow[]> {
      return db
        .select()
        .from(knowledgeBase)
        .where(and(isNull(knowledgeBase._enriched_at), eq(knowledgeBase.status, 'published')))
        .limit(limit);
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
      await db
        .update(knowledgeBase)
        .set({
          _summary: data._summary,
          _questions: JSON.stringify(data._questions),
          _topics: JSON.stringify(data._topics),
          _enriched_at: data._enriched_at ?? nowIso(),
          updated_at: nowIso(),
        })
        .where(eq(knowledgeBase.id, id));
    },

    async ensureFtsIndex(): Promise<void> {
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_kb_fts ON knowledge_base USING GIN((
          setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(_summary, '') || ' ' || coalesce(_questions, '')), 'B') ||
          setweight(to_tsvector('simple', coalesce(content, '') || ' ' || coalesce(_topics, '')), 'C')
        ))
      `);
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
      const result = await db.execute(sql`
        SELECT id, doc_id, title, _summary, tags,
               SUBSTRING(content, 1, 240) as snippet, 1.0 as relevance
        FROM knowledge_base
        WHERE scope = ${scope}
        AND status = ${status}
        ${ownerClause}
        ${visibilityClause}
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
