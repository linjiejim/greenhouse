/**
 * The asset library: one row per distinct file (by sha256), who uploaded it, collections,
 * admin-configured facets and near-duplicate pairs.
 *
 * Tables: ext_assets_assets, ext_assets_uploads, ext_assets_collections,
 * ext_assets_collection_items, ext_assets_facets, ext_assets_similar
 *
 * Bytes live in the plugin object store under `assets/<sha256>/` (original, thumb,
 * preview, frame-<n>); rows never hold storage keys. Human fields and AI fields are kept
 * apart: AI never overwrites what a member wrote. `display_title` is the title a list
 * shows (member title, else AI title, else the file name). Full-text search uses the
 * jieba-segmented `search_a/b/c` columns (A = titles, tags, facet values; B = descriptions
 * and AI captions; C = visible text, file name, source).
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, oneOf, searchColumns, updatedAt } from '@greenhouse/api/extension-kit';

export const ASSET_KINDS = ['image', 'video'] as const;
export const ASSET_STATUSES = ['uploading', 'active', 'invalid', 'deleted'] as const;
export const AI_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
export const SIMILAR_STATUSES = ['open', 'dismissed', 'merged'] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export type AiStatus = (typeof AI_STATUSES)[number];
/** Facet key → chosen values. */
export type FacetValues = Record<string, string[]>;

export const assets = pgTable(
  'ext_assets_assets',
  {
    id: id(),
    kind: text('kind', { enum: ASSET_KINDS }).notNull(),
    status: text('status', { enum: ASSET_STATUSES }).notNull().default('uploading'),
    sha256: text('sha256').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    content_type: text('content_type').notNull(),
    /** Lower-case extension of the original (`jpg`, `mp4`), part of its object key. */
    ext: text('ext').notNull(),
    original_name: text('original_name').notNull(),
    width: integer('width'),
    height: integer('height'),
    duration_ms: integer('duration_ms'),
    /** 64-bit dHash of the preview, 16 hex characters (browser-computed; a hint only). */
    phash: text('phash'),
    /** Whether thumb/preview objects exist (a browser that cannot decode the file sends none). */
    has_preview: boolean('has_preview').notNull().default(false),
    frame_count: integer('frame_count').notNull().default(0),

    title: text('title'),
    description: text('description'),
    tags: json<string[]>('tags', []),
    source: text('source'),
    facets: json<FacetValues>('facets', {}),
    display_title: text('display_title').notNull(),

    ai_status: text('ai_status', { enum: AI_STATUSES }).notNull().default('pending'),
    ai_title: text('ai_title'),
    ai_caption: text('ai_caption'),
    ai_tags: json<string[]>('ai_tags', []),
    ai_text: text('ai_text'),
    ai_facets: json<FacetValues>('ai_facets', {}),
    ai_people: boolean('ai_people'),
    ai_model: text('ai_model'),
    ai_error: text('ai_error'),
    ai_attempts: integer('ai_attempts').notNull().default(0),
    ai_started_at: at('ai_started_at'),
    ai_at: at('ai_at'),

    /** When the server re-hashed the stored original and it matched `sha256`. */
    verified_at: at('verified_at'),
    uploaded_by: text('uploaded_by').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
    deleted_at: at('deleted_at'),
    deleted_by: text('deleted_by'),
    ...searchColumns(),
  },
  (table) => [
    uniqueIndex('uq_ext_assets_assets_sha256').on(table.sha256),
    index('idx_ext_assets_assets_status_created').on(table.status, table.created_at),
    index('idx_ext_assets_assets_uploaded_by').on(table.uploaded_by),
    index('idx_ext_assets_assets_ai_queue').on(table.ai_status, table.created_at),
    index('idx_ext_assets_assets_search').using('gin', table.search_tsv),
    oneOf('chk_ext_assets_assets_kind', table.kind, ASSET_KINDS),
    oneOf('chk_ext_assets_assets_status', table.status, ASSET_STATUSES),
    oneOf('chk_ext_assets_assets_ai_status', table.ai_status, AI_STATUSES),
  ],
);

export const assetUploads = pgTable(
  'ext_assets_uploads',
  {
    asset_id: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    original_name: text('original_name').notNull(),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.asset_id, table.user_id] }),
    index('idx_ext_assets_uploads_user').on(table.user_id),
  ],
);

export const collections = pgTable('ext_assets_collections', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  created_by: text('created_by').notNull(),
  created_at: createdAt(),
  updated_at: updatedAt(),
});

export const collectionItems = pgTable(
  'ext_assets_collection_items',
  {
    collection_id: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    asset_id: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    added_by: text('added_by').notNull(),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.collection_id, table.asset_id] }),
    index('idx_ext_assets_collection_items_asset').on(table.asset_id),
  ],
);

export interface FacetValue {
  value: string;
  zh?: string;
}

export const facets = pgTable('ext_assets_facets', {
  /** Stable key (`product_line`), never renamed: stored on every asset. */
  key: text('key').primaryKey(),
  label_en: text('label_en').notNull(),
  label_zh: text('label_zh').notNull(),
  values: json<FacetValue[]>('values', []),
  multiple: boolean('multiple').notNull().default(true),
  sort_order: integer('sort_order').notNull().default(0),
  created_at: createdAt(),
  updated_at: updatedAt(),
});

export const similar = pgTable(
  'ext_assets_similar',
  {
    /** The pair is stored once, `asset_id` < `other_id`. */
    asset_id: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    other_id: text('other_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    distance: integer('distance').notNull(),
    status: text('status', { enum: SIMILAR_STATUSES }).notNull().default('open'),
    resolved_by: text('resolved_by'),
    resolved_at: at('resolved_at'),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.asset_id, table.other_id] }),
    index('idx_ext_assets_similar_other').on(table.other_id),
    oneOf('chk_ext_assets_similar_status', table.status, SIMILAR_STATUSES),
    // Keeps each pair in one orientation.
    check('chk_ext_assets_similar_order', sql`${table.asset_id} < ${table.other_id}`),
  ],
);

export type AssetRow = typeof assets.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;
export type FacetRow = typeof facets.$inferSelect;
