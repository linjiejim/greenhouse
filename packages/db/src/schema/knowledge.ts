import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, searchColumns, updatedAt } from './_columns.js';
import { agents } from './agents.js';
import { members } from './identity.js';

/** The team's space (every member reads and writes) or one member's own. */
export const KNOWLEDGE_SPACES = ['team', 'personal'] as const;
export type KnowledgeSpace = (typeof KNOWLEDGE_SPACES)[number];

/** Search metadata of a doc: never shown as part of it. */
export type DocMeta = { summary?: string; questions?: string[]; topics?: string[] };

/**
 * The knowledge tree: folders, with docs and files in the same tree. A personal item has its
 * owner; a team item has none. Access beyond the owner comes only from `shares`, inherited down
 * the tree. An Agent's private reference folder is a root folder of its owner's space.
 */
export const folders = pgTable(
  'folders',
  {
    id: id(),
    parentId: text('parent_id').references((): AnyPgColumn => folders.id, { onDelete: 'cascade' }),
    space: text('space', { enum: KNOWLEDGE_SPACES }).notNull(),
    ownerId: text('owner_id').references(() => members.id, { onDelete: 'cascade' }),
    /**
     * Set on the root of an Agent's private reference folder. While it exists the Agent cannot
     * be deleted (no action): a cascade would drop the folder and move what is in it to its
     * owner's root, where the owner's other Agents see it. Whatever deletes an Agent first deletes
     * the folder's docs and files (bytes through the storage job). Deleting the owner still takes
     * all of it, both rows going with them.
     */
    agentId: text('agent_id').references(() => agents.id),
    name: text('name').notNull(),
    /** 0 until someone put it in order by hand. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: text('created_by'),
    /** Archiving a folder stamps everything in it with the same time; restoring brings back exactly those. */
    archivedAt: at('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('folders_parent_idx').on(t.parentId),
    index('folders_owner_idx').on(t.ownerId),
    uniqueIndex('folders_agent_key').on(t.agentId),
    check('folders_owner_by_space', sql`(${t.space} = 'personal') = (${t.ownerId} IS NOT NULL)`),
  ],
);

/** A doc: Markdown is its only content. `version` grows with every save and guards concurrent ones. */
export const docs = pgTable(
  'docs',
  {
    id: id(),
    folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    space: text('space', { enum: KNOWLEDGE_SPACES }).notNull(),
    ownerId: text('owner_id').references(() => members.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    isTemplate: boolean('is_template').notNull().default(false),
    tags: json<string[]>('tags', []),
    meta: json<DocMeta>('meta', {}),
    version: integer('version').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
    ...searchColumns(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    archivedAt: at('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('docs_folder_idx').on(t.folderId),
    index('docs_owner_idx').on(t.ownerId),
    index('docs_updated_idx').on(t.updatedAt, t.id),
    index('docs_search_idx').using('gin', t.searchTsv),
    check('docs_owner_by_space', sql`(${t.space} = 'personal') = (${t.ownerId} IS NOT NULL)`),
  ],
);

/** Every save of a doc, immutable. */
export const docVersions = pgTable(
  'doc_versions',
  {
    id: id(),
    docId: text('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    changeNote: text('change_note').notNull().default(''),
    createdBy: text('created_by'),
    /** The Agent that wrote this version for `created_by`. */
    agentId: text('agent_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('doc_versions_version_key').on(t.docId, t.version)],
);

/** Links between docs, rebuilt from the Markdown on every save; read with the reader's access. */
export const docLinks = pgTable(
  'doc_links',
  {
    fromDocId: text('from_doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    toDocId: text('to_doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.fromDocId, t.toDocId] }), index('doc_links_to_idx').on(t.toDocId)],
);

export const COMMENT_TARGETS = ['doc', 'record'] as const;

/** Comments on docs and records; reading them follows the target. Deleting keeps the row. */
export const comments = pgTable(
  'comments',
  {
    id: id(),
    targetType: text('target_type', { enum: COMMENT_TARGETS }).notNull(),
    targetId: text('target_id').notNull(),
    /** The base of a record comment. */
    baseId: text('base_id'),
    createdBy: text('created_by'),
    /** The Agent that wrote it for `created_by`. */
    agentId: text('agent_id'),
    body: text('body').notNull(),
    mentions: json<string[]>('mentions', []),
    deletedAt: at('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('comments_target_idx').on(t.targetType, t.targetId, t.id)],
);

export type FolderRow = typeof folders.$inferSelect;
export type DocRow = typeof docs.$inferSelect;
export type DocVersionRow = typeof docVersions.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
