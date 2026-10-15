import { integer, boolean, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { at, createdAt, id, updatedAt } from './_columns.js';
import { bases } from './tables.js';
import { members } from './identity.js';

export const apps = pgTable(
  'apps',
  {
    id: id(),
    baseId: text('base_id')
      .notNull()
      .references(() => bases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    icon: text('icon').notNull().default('layout-grid'),
    accent: text('accent').notNull().default('green'),
    ownerId: text('owner_id')
      .notNull()
      .references(() => members.id),
    status: text('status', { enum: ['draft', 'published'] })
      .notNull()
      .default('draft'),
    draftSpec: text('draft_spec').notNull(),
    draftRevision: integer('draft_revision').notNull().default(1),
    publishedVersion: integer('published_version'),
    featured: boolean('featured').notNull().default(false),
    archivedAt: at('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('apps_base_idx').on(t.baseId), index('apps_owner_idx').on(t.ownerId)],
);

export const appVersions = pgTable(
  'app_versions',
  {
    id: id(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    spec: text('spec').notNull(),
    specHash: text('spec_hash').notNull(),
    reviewStatus: text('review_status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: at('reviewed_at'),
    draftRevision: integer('draft_revision').notNull(),
    notes: text('notes').notNull().default(''),
    publishedBy: text('published_by').notNull(),
    publishedAt: at('published_at').notNull().defaultNow(),
  },
  (t) => [unique('app_versions_number_key').on(t.appId, t.version)],
);

export const baseTemplates = pgTable(
  'base_templates',
  {
    id: id(),
    key: text('key').notNull().unique(),
    source: text('source', { enum: ['builtin', 'published'] }).notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    ownerId: text('owner_id').notNull(),
    latestVersion: text('latest_version').notNull(),
    sourceAppId: text('source_app_id'),
    sourceBaseId: text('source_base_id'),
    archivedAt: at('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [index('base_templates_owner_idx').on(t.ownerId)],
);

export const baseTemplateVersions = pgTable(
  'base_template_versions',
  {
    id: id(),
    templateId: text('template_id')
      .notNull()
      .references(() => baseTemplates.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    changelog: text('changelog').notNull().default(''),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    scanStatus: text('scan_status', { enum: ['passed', 'blocked'] })
      .notNull()
      .default('passed'),
    reviewStatus: text('review_status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: at('reviewed_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('base_template_versions_number_key').on(t.templateId, t.version)],
);

export type AppRow = typeof apps.$inferSelect;
export type AppVersionRow = typeof appVersions.$inferSelect;
export type BaseTemplateRow = typeof baseTemplates.$inferSelect;
