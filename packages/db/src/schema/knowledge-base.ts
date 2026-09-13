/**
 * Drizzle schema — Internal knowledge base (PostgreSQL).
 *
 * Tables: knowledge_base, knowledge_base_versions
 *
 * Isolated from the public-facing `sources` table.
 * Stores internal team documentation and future personal notes.
 *
 * MVP editor model:
 * - `content` is the canonical Markdown content for AI/search/export.
 * - `content_json` stores Tiptap JSON editor state for editing UX.
 * - versions keep snapshots for audit/history.
 */

import { integer, pgTable, text, serial, timestamp, index, uniqueIndex, boolean } from 'drizzle-orm/pg-core';
import { driveFolders } from './drive.js';

// ─── knowledge_base ───────────────────────────────────────

export const knowledgeBase = pgTable(
  'knowledge_base',
  {
    id: serial('id').primaryKey(),
    doc_id: text('doc_id').notNull(), // document identifier / slug
    // SCOPE MODEL: every KB doc is created with scope='shared'. Team vs personal is
    // expressed by visibility, NOT scope: team = visibility='team', personal =
    // visibility='private' + owner_user_id=<user>.
    scope: text('scope').notNull().default('shared'), // 'shared' (effectively always)
    title: text('title').notNull(),
    content: text('content').notNull(), // canonical Markdown
    content_json: text('content_json').notNull().default('{}'), // Tiptap JSON state
    content_hash: text('content_hash'), // SHA-256 hash for incremental ingest
    visibility: text('visibility').notNull().default('team'), // 'team' | 'private' (private + owner_user_id = personal)
    status: text('status').notNull().default('published'), // 'draft' | 'published' | 'archived'
    is_template: boolean('is_template').notNull().default(false), // "new from template" source
    tags: text('tags').notNull().default('[]'), // JSON array
    meta: text('meta').notNull().default('{}'), // JSON object
    file_path: text('file_path'), // source file relative path (if ingested)
    // Directory placement: a scope='kb' drive folder (null = root). Docs are never
    // cascade-deleted by a folder op — the folder-delete guard requires empty first.
    folder_id: integer('folder_id').references(() => driveFolders.id, { onDelete: 'set null' }),
    // Manual order among siblings in the sidebar tree, ascending. Same contract as
    // drive_folders.sort_order: 0 = never dragged, readers sort by (sort_order, title).
    sort_order: integer('sort_order').notNull().default(0),
    owner_user_id: text('owner_user_id'), // personal-ownership key (loose ref); scopes private docs to one user
    created_by: text('created_by'),
    updated_by: text('updated_by'),
    // ─── AI enrichment fields ──
    _summary: text('_summary').notNull().default(''),
    _questions: text('_questions').notNull().default('[]'),
    _topics: text('_topics').notNull().default('[]'),
    _enriched_at: timestamp('_enriched_at', { withTimezone: true, mode: 'string' }),
    // ─── Segmented FTS tokens (jieba, weight A/B/C) ──
    // Space-joined jieba tokens recomputed on every write; the weighted GIN
    // expression index lives in the migration chain (drizzle can't track it).
    // A = title + tags, B = _summary + _questions, C = content + _topics.
    _tokens_a: text('_tokens_a').notNull().default(''),
    _tokens_b: text('_tokens_b').notNull().default(''),
    _tokens_c: text('_tokens_c').notNull().default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('uq_kb_doc_scope').on(table.doc_id, table.scope),
    index('idx_kb_scope').on(table.scope),
    index('idx_kb_visibility').on(table.visibility),
    index('idx_kb_status').on(table.status),
    index('idx_kb_updated_at').on(table.updated_at),
    index('idx_kb_folder').on(table.folder_id),
  ],
);

// ─── knowledge_base_versions ─────────────────────────────

export const knowledgeBaseVersions = pgTable(
  'knowledge_base_versions',
  {
    id: serial('id').primaryKey(),
    doc_id: integer('doc_id')
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    content_json: text('content_json').notNull().default('{}'),
    summary: text('summary').notNull().default(''),
    changed_by: text('changed_by'),
    change_reason: text('change_reason'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('uq_kb_versions_doc_version').on(table.doc_id, table.version),
    index('idx_kb_versions_doc').on(table.doc_id),
    index('idx_kb_versions_created_at').on(table.created_at),
  ],
);

// ─── knowledge_base_shares ───────────────────────────────
//
// Granular sharing for PRIVATE docs (whole-team stays visibility='team').
// `shared_with` is a user_id, or 'group:<groupId>' to grant a whole group.
// `role` = 'reader' (read-only) | 'editor' (read + write). The owner is never a
// row here — ownership is on knowledge_base.owner_user_id and always wins.

export const knowledgeBaseShares = pgTable(
  'knowledge_base_shares',
  {
    id: serial('id').primaryKey(),
    doc_id: integer('doc_id')
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: 'cascade' }),
    shared_with: text('shared_with').notNull(), // user_id OR 'group:<groupId>'
    role: text('role', { enum: ['reader', 'editor'] })
      .notNull()
      .default('reader'), // 'reader' | 'editor'
    shared_by: text('shared_by').notNull(),
    message: text('message'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_kb_shares_doc_target').on(table.doc_id, table.shared_with),
    index('idx_kb_shares_target').on(table.shared_with),
    index('idx_kb_shares_doc').on(table.doc_id),
  ],
);

// ─── kb_links (backlinks) ────────────────────────────────
//
// One row per canonical internal link `#/knowledge/doc/<id>-<slug>` found in a
// doc's Markdown. Rebuilt on every save (outlinks of `from_doc_id`). Both ends
// cascade-delete so a removed doc leaves no dangling links. The detail page reads
// the reverse direction (who links TO me) and access-filters per caller.

export const kbLinks = pgTable(
  'kb_links',
  {
    id: serial('id').primaryKey(),
    from_doc_id: integer('from_doc_id')
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: 'cascade' }),
    to_doc_id: integer('to_doc_id')
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_kb_links_from_to').on(table.from_doc_id, table.to_doc_id),
    index('idx_kb_links_to').on(table.to_doc_id),
    index('idx_kb_links_from').on(table.from_doc_id),
  ],
);

// ─── kb_comments ─────────────────────────────────────────
//
// Document-level comments (no inline anchors). Soft-deleted (deleted_at) so an
// author/super can remove one without breaking @-notification history. Read
// access follows the doc (resolveKbAccess). Comments deliberately do NOT enter
// FTS / knowledge_query / /search (spec D10) — they're discussion, not knowledge.

export const kbComments = pgTable(
  'kb_comments',
  {
    id: serial('id').primaryKey(),
    doc_id: integer('doc_id')
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: 'cascade' }),
    author_user_id: text('author_user_id').notNull(),
    content: text('content').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }),
    deleted_at: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [index('idx_kb_comments_doc').on(table.doc_id), index('idx_kb_comments_created').on(table.created_at)],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type KnowledgeDocRow = typeof knowledgeBase.$inferSelect;
export type KnowledgeDocVersionRow = typeof knowledgeBaseVersions.$inferSelect;
export type KnowledgeShareRow = typeof knowledgeBaseShares.$inferSelect;
export type KnowledgeShareRole = KnowledgeShareRow['role'];
export type KbLinkRow = typeof kbLinks.$inferSelect;
export type KbCommentRow = typeof kbComments.$inferSelect;
