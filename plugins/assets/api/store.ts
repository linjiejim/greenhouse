/**
 * Asset library data access. Every write that touches a human or AI field recomputes the
 * derived columns (`display_title`, `search_a/b/c`) in the same statement, so search never
 * lags behind an edit. Authorization happens in the routes and tools before these run.
 */
import { and, asc, desc, eq, inArray, isNotNull, lt, notInArray, sql, type SQL } from 'drizzle-orm';
import { buildSegmentedTsQuery, isUniqueViolation, nowIso, type Db } from '@greenhouse/api/extension-kit';
import {
  assetUploads,
  assets,
  collectionItems,
  collections,
  facets,
  similar,
  type AiStatus,
  type AssetKind,
  type AssetRow,
  type AssetStatus,
  type CollectionRow,
  type FacetRow,
  type FacetValue,
  type FacetValues,
} from './schema.js';
import {
  displayTitleFor,
  hammingDistance,
  mergeFacets,
  newAssetId,
  normalizeFacets,
  normalizeTags,
  searchColumnsFor,
  SIMILAR_DISTANCE,
} from './model.js';

export interface HumanFields {
  title?: string | null;
  description?: string | null;
  source?: string | null;
  tags?: string[];
  facets?: FacetValues;
}

export interface AiFields {
  title: string | null;
  caption: string | null;
  tags: string[];
  text: string | null;
  facets: FacetValues;
  people: boolean | null;
  model: string;
}

export interface NewAsset extends HumanFields {
  kind: AssetKind;
  sha256: string;
  size: number;
  content_type: string;
  ext: string;
  original_name: string;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  phash?: string | null;
  has_preview: boolean;
  frame_count: number;
  uploaded_by: string;
}

export interface AssetListQuery {
  q?: string;
  kind?: AssetKind;
  facets?: FacetValues;
  uploadedBy?: string;
  from?: string;
  to?: string;
  orientation?: 'landscape' | 'portrait' | 'square';
  collectionId?: string;
  ai?: 'done' | 'none';
  duplicates?: boolean;
  status?: Extract<AssetStatus, 'active' | 'deleted'>;
  sort?: 'new' | 'old' | 'relevance';
  offset?: number;
  limit?: number;
}

export interface FacetInput {
  key: string;
  label_en: string;
  label_zh: string;
  values: FacetValue[];
  multiple: boolean;
}

const nullable = (value: string | null | undefined, max: number) => {
  const text = value?.trim();
  return text ? text.slice(0, max) : null;
};

export function createAssetStore(db: Db) {
  async function facetDefs(): Promise<FacetRow[]> {
    return db.select().from(facets).orderBy(asc(facets.sort_order), asc(facets.key));
  }

  /** The derived columns for a row as it will be after `patch`. */
  function derived(row: AssetRow, patch: Partial<AssetRow>, defs: readonly FacetRow[]) {
    const next = { ...row, ...patch };
    return { display_title: displayTitleFor(next), ...searchColumnsFor(next, defs) };
  }

  async function writeFields(id: string, patch: Partial<AssetRow>): Promise<AssetRow | undefined> {
    const current = await get(id);
    if (!current) return undefined;
    const defs = await facetDefs();
    const [row] = await db
      .update(assets)
      .set({ ...patch, ...derived(current, patch, defs), updated_at: nowIso() })
      .where(eq(assets.id, id))
      .returning();
    return row;
  }

  async function get(id: string): Promise<AssetRow | undefined> {
    const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    return row;
  }

  function listWhere(query: AssetListQuery, tsQuery: string | null): SQL {
    const parts: SQL[] = [sql`${assets.status} = ${query.status ?? 'active'}`];
    if (query.kind) parts.push(sql`${assets.kind} = ${query.kind}`);
    if (query.uploadedBy) parts.push(sql`${assets.uploaded_by} = ${query.uploadedBy}`);
    if (query.from) parts.push(sql`${assets.created_at} >= ${query.from}`);
    if (query.to) parts.push(sql`${assets.created_at} < ${query.to}`);
    if (query.orientation === 'landscape') parts.push(sql`${assets.width} > ${assets.height} * 1.05`);
    if (query.orientation === 'portrait') parts.push(sql`${assets.height} > ${assets.width} * 1.05`);
    if (query.orientation === 'square')
      parts.push(sql`${assets.width} > 0 AND abs(${assets.width} - ${assets.height}) <= ${assets.width} * 0.05`);
    if (query.ai === 'done') parts.push(sql`${assets.ai_status} = 'done'`);
    if (query.ai === 'none') parts.push(sql`${assets.ai_status} <> 'done'`);
    if (query.collectionId)
      parts.push(
        sql`EXISTS (SELECT 1 FROM ${collectionItems} ci WHERE ci.asset_id = ${assets.id} AND ci.collection_id = ${query.collectionId})`,
      );
    if (query.duplicates)
      parts.push(
        sql`EXISTS (SELECT 1 FROM ${similar} s WHERE s.status = 'open' AND (s.asset_id = ${assets.id} OR s.other_id = ${assets.id}))`,
      );
    for (const [key, values] of Object.entries(query.facets ?? {})) {
      if (!values.length) continue;
      const list = sql`ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;
      // A facet filter matches confirmed values and AI suggestions alike; the UI marks which is which.
      parts.push(
        sql`(jsonb_exists_any(${assets.facets} -> ${key}, ${list}) OR jsonb_exists_any(${assets.ai_facets} -> ${key}, ${list}))`,
      );
    }
    if (query.q?.trim()) {
      const like = `%${query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const textMatch = sql`(${assets.display_title} ILIKE ${like} OR ${assets.original_name} ILIKE ${like})`;
      parts.push(tsQuery ? sql`(${assets.search_tsv} @@ to_tsquery('simple', ${tsQuery}) OR ${textMatch})` : textMatch);
    }
    return sql.join(parts, sql` AND `);
  }

  async function count(where: SQL): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(assets)
      .where(where);
    return row?.n ?? 0;
  }

  return {
    facetDefs,
    get,

    async getMany(ids: string[]): Promise<AssetRow[]> {
      if (!ids.length) return [];
      return db.select().from(assets).where(inArray(assets.id, ids));
    },

    async bySha(shas: string[]): Promise<AssetRow[]> {
      if (!shas.length) return [];
      return db.select().from(assets).where(inArray(assets.sha256, shas));
    },

    /** A new row in `uploading`; null when the same content already has a row (raced or not). */
    async insertUploading(input: NewAsset): Promise<AssetRow | null> {
      const defs = await facetDefs();
      const base = {
        id: newAssetId('ast'),
        kind: input.kind,
        status: 'uploading' as const,
        sha256: input.sha256,
        size: input.size,
        content_type: input.content_type,
        ext: input.ext,
        original_name: input.original_name,
        width: input.width ?? null,
        height: input.height ?? null,
        duration_ms: input.duration_ms ?? null,
        phash: input.phash ?? null,
        has_preview: input.has_preview,
        frame_count: input.frame_count,
        title: nullable(input.title, 200),
        description: nullable(input.description, 4000),
        source: nullable(input.source, 500),
        tags: normalizeTags(input.tags),
        facets: normalizeFacets(input.facets, defs),
        ai_title: null,
        ai_tags: [],
        ai_facets: {},
        ai_caption: null,
        ai_text: null,
        uploaded_by: input.uploaded_by,
      };
      try {
        const [row] = await db
          .insert(assets)
          .values({ ...base, display_title: displayTitleFor(base), ...searchColumnsFor(base, defs) })
          .returning();
        return row ?? null;
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    /** Drop an abandoned or rejected row so the same content can be uploaded again. */
    async removeRow(id: string): Promise<void> {
      await db.delete(assets).where(eq(assets.id, id));
    },

    async recordUploader(assetId: string, userId: string, originalName: string): Promise<void> {
      await db
        .insert(assetUploads)
        .values({ asset_id: assetId, user_id: userId, original_name: originalName })
        .onConflictDoNothing();
    },

    async uploaders(assetId: string) {
      return db
        .select({
          user_id: assetUploads.user_id,
          original_name: assetUploads.original_name,
          created_at: assetUploads.created_at,
        })
        .from(assetUploads)
        .where(eq(assetUploads.asset_id, assetId))
        .orderBy(asc(assetUploads.created_at));
    },

    /** A later uploader's information fills what is still empty; tags and facets add up. */
    async contribute(asset: AssetRow, fields: HumanFields): Promise<AssetRow | undefined> {
      const defs = await facetDefs();
      const patch: Partial<AssetRow> = {};
      if (!asset.title && fields.title?.trim()) patch.title = nullable(fields.title, 200);
      if (!asset.description && fields.description?.trim()) patch.description = nullable(fields.description, 4000);
      if (!asset.source && fields.source?.trim()) patch.source = nullable(fields.source, 500);
      if (fields.tags?.length) patch.tags = normalizeTags([...asset.tags, ...fields.tags]);
      if (fields.facets) patch.facets = mergeFacets(asset.facets, normalizeFacets(fields.facets, defs), defs);
      return Object.keys(patch).length ? writeFields(asset.id, patch) : asset;
    },

    /** The browser promised derivatives it did not deliver: show no preview, skip AI. */
    async markPreviewMissing(id: string): Promise<void> {
      await db.update(assets).set({ has_preview: false, frame_count: 0 }).where(eq(assets.id, id));
    },

    async markActive(id: string, aiStatus: Extract<AiStatus, 'pending' | 'skipped'>): Promise<AssetRow | undefined> {
      const [row] = await db
        .update(assets)
        .set({ status: 'active', ai_status: aiStatus, updated_at: nowIso() })
        .where(and(eq(assets.id, id), eq(assets.status, 'uploading')))
        .returning();
      return row;
    },

    async update(id: string, fields: HumanFields): Promise<AssetRow | undefined> {
      const defs = await facetDefs();
      const patch: Partial<AssetRow> = {};
      if (fields.title !== undefined) patch.title = nullable(fields.title, 200);
      if (fields.description !== undefined) patch.description = nullable(fields.description, 4000);
      if (fields.source !== undefined) patch.source = nullable(fields.source, 500);
      if (fields.tags !== undefined) patch.tags = normalizeTags(fields.tags);
      if (fields.facets !== undefined) patch.facets = normalizeFacets(fields.facets, defs);
      return writeFields(id, patch);
    },

    /** Copy AI suggestions into the member's fields (title/description replace, tags/facets add). */
    async acceptAi(
      asset: AssetRow,
      which: ReadonlyArray<'title' | 'description' | 'tags' | 'facets'>,
    ): Promise<AssetRow | undefined> {
      const defs = await facetDefs();
      const patch: Partial<AssetRow> = {};
      if (which.includes('title') && asset.ai_title) patch.title = asset.ai_title;
      if (which.includes('description') && asset.ai_caption) patch.description = asset.ai_caption;
      if (which.includes('tags')) patch.tags = normalizeTags([...asset.tags, ...asset.ai_tags]);
      if (which.includes('facets')) patch.facets = mergeFacets(asset.facets, asset.ai_facets, defs);
      return writeFields(asset.id, patch);
    },

    async softDelete(id: string, userId: string): Promise<AssetRow | undefined> {
      const [row] = await db
        .update(assets)
        .set({ status: 'deleted', deleted_at: nowIso(), deleted_by: userId, updated_at: nowIso() })
        .where(and(eq(assets.id, id), eq(assets.status, 'active')))
        .returning();
      return row;
    },

    async restore(id: string): Promise<AssetRow | undefined> {
      const [row] = await db
        .update(assets)
        .set({ status: 'active', deleted_at: null, deleted_by: null, updated_at: nowIso() })
        .where(and(eq(assets.id, id), eq(assets.status, 'deleted')))
        .returning();
      return row;
    },

    async list(query: AssetListQuery): Promise<{ items: AssetRow[]; total: number }> {
      const limit = Math.min(Math.max(query.limit ?? 60, 1), 200);
      const offset = Math.max(query.offset ?? 0, 0);
      let tsQuery: string | null = null;
      if (query.q?.trim()) {
        // AND first (precision); when nothing matches every word, OR (recall).
        tsQuery = buildSegmentedTsQuery(query.q, '&');
        if (tsQuery && (await count(listWhere(query, tsQuery))) === 0) tsQuery = buildSegmentedTsQuery(query.q, '|');
      }
      const where = listWhere(query, tsQuery);
      const rank = tsQuery ? sql`ts_rank(${assets.search_tsv}, to_tsquery('simple', ${tsQuery}))` : null;
      const order =
        query.sort === 'old'
          ? [asc(assets.created_at), asc(assets.id)]
          : rank && query.sort !== 'new'
            ? [desc(rank), desc(assets.created_at)]
            : [desc(query.status === 'deleted' ? assets.deleted_at : assets.created_at), desc(assets.id)];
      const [items, total] = await Promise.all([
        db
          .select()
          .from(assets)
          .where(where)
          .orderBy(...order)
          .limit(limit)
          .offset(offset),
        count(where),
      ]);
      return { items, total };
    },

    // ── AI queue ──

    /** Claim up to `limit` pending rows (and rows stuck running since `staleBefore`). */
    async claimAi(limit: number, staleBefore: string): Promise<AssetRow[]> {
      return db.transaction(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT id FROM ${assets}
          WHERE status = 'active'
            AND (ai_status = 'pending' OR (ai_status = 'running' AND ai_started_at < ${staleBefore}))
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`);
        const ids = (rows as unknown as Array<{ id: string }>).map((r) => r.id);
        if (!ids.length) return [];
        return tx
          .update(assets)
          .set({ ai_status: 'running', ai_started_at: nowIso(), ai_attempts: sql`${assets.ai_attempts} + 1` })
          .where(inArray(assets.id, ids))
          .returning();
      });
    },

    async saveAi(id: string, ai: AiFields): Promise<AssetRow | undefined> {
      const defs = await facetDefs();
      return writeFields(id, {
        ai_status: 'done',
        ai_title: nullable(ai.title, 200),
        ai_caption: nullable(ai.caption, 4000),
        ai_tags: normalizeTags(ai.tags),
        ai_text: nullable(ai.text, 4000),
        ai_facets: normalizeFacets(ai.facets, defs),
        ai_people: ai.people,
        ai_model: ai.model,
        ai_error: null,
        ai_at: nowIso(),
      });
    },

    async failAi(id: string, error: string): Promise<void> {
      await db
        .update(assets)
        .set({ ai_status: 'failed', ai_error: error.slice(0, 500), ai_at: nowIso() })
        .where(eq(assets.id, id));
    },

    async requeueAi(id: string): Promise<AssetRow | undefined> {
      const [row] = await db
        .update(assets)
        .set({ ai_status: 'pending', ai_error: null, updated_at: nowIso() })
        .where(and(eq(assets.id, id), eq(assets.status, 'active'), eq(assets.has_preview, true)))
        .returning();
      return row;
    },

    // ── Verification ──

    async unverified(limit: number): Promise<AssetRow[]> {
      return db
        .select()
        .from(assets)
        .where(and(eq(assets.status, 'active'), sql`${assets.verified_at} IS NULL`))
        .orderBy(asc(assets.created_at))
        .limit(limit);
    },

    async markVerified(id: string): Promise<void> {
      await db.update(assets).set({ verified_at: nowIso() }).where(eq(assets.id, id));
    },

    async markInvalid(id: string): Promise<void> {
      await db.update(assets).set({ status: 'invalid', updated_at: nowIso() }).where(eq(assets.id, id));
    },

    // ── Near duplicates ──

    /** Record every active asset within SIMILAR_DISTANCE of this one; returns the pairs found. */
    async recordSimilar(asset: AssetRow): Promise<Array<{ id: string; distance: number }>> {
      if (!asset.phash) return [];
      const others = await db
        .select({ id: assets.id, phash: assets.phash })
        .from(assets)
        .where(and(eq(assets.status, 'active'), isNotNull(assets.phash), sql`${assets.id} <> ${asset.id}`));
      const hits = others
        .map((o) => ({ id: o.id, distance: hammingDistance(asset.phash!, o.phash!) }))
        .filter((o) => o.distance <= SIMILAR_DISTANCE);
      if (hits.length)
        await db
          .insert(similar)
          .values(
            hits.map((h) => ({
              asset_id: h.id < asset.id ? h.id : asset.id,
              other_id: h.id < asset.id ? asset.id : h.id,
              distance: h.distance,
            })),
          )
          .onConflictDoNothing();
      return hits;
    },

    async similarFor(assetId: string) {
      const rows = await db.execute(sql`
        SELECT CASE WHEN s.asset_id = ${assetId} THEN s.other_id ELSE s.asset_id END AS id, s.distance, s.status
        FROM ${similar} s
        WHERE (s.asset_id = ${assetId} OR s.other_id = ${assetId}) AND s.status = 'open'
        ORDER BY s.distance`);
      return rows as unknown as Array<{ id: string; distance: number; status: string }>;
    },

    async openPairs(limit: number, offset: number) {
      const rows = await db.execute(sql`
        SELECT s.asset_id, s.other_id, s.distance, s.created_at
        FROM ${similar} s
        JOIN ${assets} a ON a.id = s.asset_id AND a.status = 'active'
        JOIN ${assets} b ON b.id = s.other_id AND b.status = 'active'
        WHERE s.status = 'open'
        ORDER BY s.distance, s.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`);
      return rows as unknown as Array<{ asset_id: string; other_id: string; distance: number; created_at: string }>;
    },

    async resolvePair(a: string, b: string, status: 'dismissed' | 'merged', userId: string): Promise<boolean> {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const rows = await db
        .update(similar)
        .set({ status, resolved_by: userId, resolved_at: nowIso() })
        .where(and(eq(similar.asset_id, lo), eq(similar.other_id, hi), eq(similar.status, 'open')))
        .returning({ a: similar.asset_id });
      return rows.length > 0;
    },

    /** Keep one asset of a near-duplicate pair: uploaders and collections move over, the other goes to the bin. */
    async merge(keepId: string, dropId: string, userId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [lo, hi] = keepId < dropId ? [keepId, dropId] : [dropId, keepId];
        const pair = await tx
          .update(similar)
          .set({ status: 'merged', resolved_by: userId, resolved_at: nowIso() })
          .where(and(eq(similar.asset_id, lo), eq(similar.other_id, hi), eq(similar.status, 'open')))
          .returning({ a: similar.asset_id });
        if (!pair.length) return false;
        await tx.execute(sql`
          INSERT INTO ${assetUploads} (asset_id, user_id, original_name, created_at)
          SELECT ${keepId}, user_id, original_name, created_at FROM ${assetUploads} WHERE asset_id = ${dropId}
          ON CONFLICT DO NOTHING`);
        await tx.execute(sql`
          INSERT INTO ${collectionItems} (collection_id, asset_id, added_by, created_at)
          SELECT collection_id, ${keepId}, added_by, created_at FROM ${collectionItems} WHERE asset_id = ${dropId}
          ON CONFLICT DO NOTHING`);
        await tx
          .update(assets)
          .set({ status: 'deleted', deleted_at: nowIso(), deleted_by: userId, updated_at: nowIso() })
          .where(and(eq(assets.id, dropId), eq(assets.status, 'active')));
        return true;
      });
    },

    // ── Collections ──

    async listCollections(): Promise<Array<CollectionRow & { count: number }>> {
      const rows = await db.execute(sql`
        SELECT c.*, (SELECT count(*)::int FROM ${collectionItems} ci
                     JOIN ${assets} a ON a.id = ci.asset_id AND a.status = 'active'
                     WHERE ci.collection_id = c.id) AS count
        FROM ${collections} c
        ORDER BY c.updated_at DESC`);
      return rows as unknown as Array<CollectionRow & { count: number }>;
    },

    async getCollection(id: string): Promise<CollectionRow | undefined> {
      const [row] = await db.select().from(collections).where(eq(collections.id, id)).limit(1);
      return row;
    },

    async createCollection(name: string, description: string | null, userId: string): Promise<CollectionRow> {
      const [row] = await db
        .insert(collections)
        .values({ id: newAssetId('acl'), name, description, created_by: userId })
        .returning();
      return row!;
    },

    async updateCollection(id: string, fields: { name?: string; description?: string | null }) {
      const [row] = await db
        .update(collections)
        .set({ ...fields, updated_at: nowIso() })
        .where(eq(collections.id, id))
        .returning();
      return row;
    },

    async deleteCollection(id: string): Promise<boolean> {
      const rows = await db.delete(collections).where(eq(collections.id, id)).returning({ id: collections.id });
      return rows.length > 0;
    },

    async addToCollection(collectionId: string, assetIds: string[], userId: string): Promise<void> {
      if (!assetIds.length) return;
      await db
        .insert(collectionItems)
        .values(assetIds.map((asset_id) => ({ collection_id: collectionId, asset_id, added_by: userId })))
        .onConflictDoNothing();
      await db.update(collections).set({ updated_at: nowIso() }).where(eq(collections.id, collectionId));
    },

    async removeFromCollection(collectionId: string, assetIds: string[]): Promise<void> {
      if (!assetIds.length) return;
      await db
        .delete(collectionItems)
        .where(and(eq(collectionItems.collection_id, collectionId), inArray(collectionItems.asset_id, assetIds)));
    },

    async collectionsFor(assetId: string) {
      return db
        .select({ id: collections.id, name: collections.name })
        .from(collectionItems)
        .innerJoin(collections, eq(collections.id, collectionItems.collection_id))
        .where(eq(collectionItems.asset_id, assetId))
        .orderBy(asc(collections.name));
    },

    // ── Facets ──

    /** Replace the whole facet configuration; values removed from a facet stay on assets until edited. */
    async replaceFacets(input: FacetInput[]): Promise<FacetRow[]> {
      await db.transaction(async (tx) => {
        const keys = input.map((f) => f.key);
        if (keys.length) await tx.delete(facets).where(notInArray(facets.key, keys));
        else await tx.delete(facets);
        for (const [i, f] of input.entries())
          await tx
            .insert(facets)
            .values({ ...f, sort_order: i })
            .onConflictDoUpdate({
              target: facets.key,
              set: {
                label_en: f.label_en,
                label_zh: f.label_zh,
                values: f.values,
                multiple: f.multiple,
                sort_order: i,
                updated_at: nowIso(),
              },
            });
      });
      return facetDefs();
    },

    // ── Cleanup ──

    async staleUploads(before: string): Promise<AssetRow[]> {
      return db
        .select()
        .from(assets)
        .where(and(eq(assets.status, 'uploading'), lt(assets.created_at, before)))
        .limit(100);
    },

    async binnedBefore(before: string): Promise<AssetRow[]> {
      return db
        .select()
        .from(assets)
        .where(
          and(
            sql`${assets.status} IN ('deleted', 'invalid')`,
            lt(sql`coalesce(${assets.deleted_at}, ${assets.updated_at})`, before),
          ),
        )
        .limit(100);
    },

    async counts(): Promise<{ active: number; images: number; videos: number; bytes: number }> {
      const [row] = await db
        .select({
          active: sql<number>`count(*)::int`,
          images: sql<number>`count(*) FILTER (WHERE ${assets.kind} = 'image')::int`,
          videos: sql<number>`count(*) FILTER (WHERE ${assets.kind} = 'video')::int`,
          bytes: sql<number>`coalesce(sum(${assets.size}), 0)::bigint`,
        })
        .from(assets)
        .where(eq(assets.status, 'active'));
      return {
        active: row?.active ?? 0,
        images: row?.images ?? 0,
        videos: row?.videos ?? 0,
        bytes: Number(row?.bytes ?? 0),
      };
    },
  };
}

export type AssetStore = ReturnType<typeof createAssetStore>;
