/**
 * Knowledge base: documents (canonical Markdown + Tiptap JSON) and their
 * immutable version history.
 *
 * Tables: kb_documents, kb_versions
 *
 * A document lives in a `folders` row of scope `kb` (null = root). Per-person
 * sharing is in `shares` (resource_type = 'kb_document'). Full-text search uses
 * the jieba-segmented `search_a/b/c` columns and the generated `search_tsv`
 * (A = title + tags, B = summary + questions, C = content + topics).
 */

import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, oneOf, searchColumns, updatedAt } from '@greenhouse/api/extension-kit';
import { folders } from '@greenhouse/api/extension-kit';

export const KB_VISIBILITIES = ['team', 'private'] as const;
export const KB_STATUSES = ['draft', 'published', 'archived'] as const;

export const kbDocuments = pgTable(
  'kb_documents',
  {
    id: id(),
    /** Stable slug (system-assigned, never title-derived). */
    doc_id: text('doc_id').notNull(),
    scope: text('scope').notNull().default('shared'),
    title: text('title').notNull(),
    /** Canonical Markdown. */
    content: text('content').notNull(),
    /** Tiptap JSON state; `{}` is legal (Markdown is canonical). */
    content_json: json<Record<string, unknown>>('content_json', {}),
    content_hash: text('content_hash'),
    /** `team`, or `private` + owner_user_id = personal. */
    visibility: text('visibility', { enum: KB_VISIBILITIES }).notNull().default('team'),
    status: text('status', { enum: KB_STATUSES }).notNull().default('published'),
    is_template: boolean('is_template').notNull().default(false),
    tags: json<string[]>('tags', []),
    meta: json<Record<string, unknown>>('meta', {}),
    file_path: text('file_path'),
    folder_id: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    sort_order: integer('sort_order').notNull().default(0),
    owner_user_id: text('owner_user_id'),
    created_by: text('created_by'),
    updated_by: text('updated_by'),
    _summary: text('_summary').notNull().default(''),
    _questions: json<string[]>('_questions', []),
    _topics: json<string[]>('_topics', []),
    _enriched_at: at('_enriched_at'),
    ...searchColumns(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_kb_documents_doc_scope').on(table.doc_id, table.scope),
    index('idx_kb_documents_visibility').on(table.visibility, table.owner_user_id),
    index('idx_kb_documents_status').on(table.status),
    index('idx_kb_documents_updated_at').on(table.updated_at),
    index('idx_kb_documents_folder').on(table.folder_id),
    index('idx_kb_documents_search').using('gin', sql`${table.search_tsv}`),
    oneOf('chk_kb_documents_visibility', table.visibility, KB_VISIBILITIES),
    oneOf('chk_kb_documents_status', table.status, KB_STATUSES),
  ],
);

export const kbVersions = pgTable(
  'kb_versions',
  {
    id: id(),
    doc_id: text('doc_id')
      .notNull()
      .references(() => kbDocuments.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    content_json: json<Record<string, unknown>>('content_json', {}),
    summary: text('summary').notNull().default(''),
    changed_by: text('changed_by'),
    change_reason: text('change_reason'),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_kb_versions_doc_version').on(table.doc_id, table.version),
    index('idx_kb_versions_created_at').on(table.created_at),
  ],
);

export type KnowledgeDocRow = typeof kbDocuments.$inferSelect;
export type KnowledgeDocVersionRow = typeof kbVersions.$inferSelect;
