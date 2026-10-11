/**
 * Drizzle schema — Apps (应用) built on a Tables Base (Tables → Apps Phase 1,
 * docs/specs/20261011-tables-apps.md §1).
 *
 * Tables: table_apps, table_app_versions, table_app_audiences, table_app_pins,
 *         table_app_action_requests, table_app_templates, table_app_template_versions
 *
 * An app belongs to one Base. Its draft spec is edited in place
 * (`draft_revision` CAS); publishing appends an immutable version whose spec is
 * stored as TEXT — the exact bytes that were hashed (jsonb would reorder keys
 * and the hash would no longer match, D7). Audiences point at a role key of the
 * published spec; one row per person, per group, and at most one team row.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  AppAccent,
  AppCustomReviewStatus,
  AppIconName,
  AppStatus,
  AppTemplateReviewStatus,
  AppTemplateScanStatus,
  AppTemplateSource,
  AppTemplateStatus,
} from '@greenhouse/types/apps';
import { userGroups } from './groups.js';
import { tableBases } from './tables.js';

export const tableApps = pgTable(
  'table_apps',
  {
    id: serial('id').primaryKey(),
    base_id: integer('base_id')
      .notNull()
      .references(() => tableBases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon').$type<AppIconName>().notNull().default('app'),
    accent: text('accent').$type<AppAccent>().notNull().default('brand'),
    /** The person responsible (logical → users). Managing rights still come from the Base (D2). */
    owner_id: text('owner_id').notNull(),
    status: text('status', { enum: ['draft', 'published', 'archived'] })
      .$type<AppStatus>()
      .notNull()
      .default('draft'),
    /** The draft `AppSpec` as JSON text; parsed and validated by the API. */
    draft_spec: text('draft_spec').notNull(),
    draft_revision: integer('draft_revision').notNull().default(1),
    /** The live version number; null until the first publish. */
    published_version: integer('published_version'),
    audiences_revision: integer('audiences_revision').notNull().default(1),
    /** Recommended to its audience (super only). */
    featured: boolean('featured').notNull().default(false),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_table_apps_base').on(table.base_id),
    index('idx_table_apps_owner').on(table.owner_id),
    index('idx_table_apps_featured')
      .on(table.id)
      .where(sql`${table.featured}`),
  ],
);

/** Immutable published versions. `spec` is the exact text `spec_hash` (sha256 hex) was computed over. */
export const tableAppVersions = pgTable(
  'table_app_versions',
  {
    id: serial('id').primaryKey(),
    app_id: integer('app_id')
      .notNull()
      .references(() => tableApps.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    spec: text('spec').notNull(),
    spec_hash: text('spec_hash').notNull(),
    /** The draft revision this version was published from. */
    draft_revision: integer('draft_revision').notNull(),
    notes: text('notes'),
    published_by: text('published_by').notNull(),
    published_at: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull(),
    /**
     * Phase 2 (custom components, D10): the super's review of this version's
     * sandboxed code, for exactly `hash` (= `spec_hash`). Null = the version has
     * no custom cards, or nobody asked yet.
     */
    custom_review: jsonb('custom_review').$type<TableAppCustomReviewRecord>(),
  },
  (table) => [uniqueIndex('uq_table_app_versions_app_version').on(table.app_id, table.version)],
);

/**
 * Who an app is shared with, and as which role. One row per person / group,
 * at most one team row per app; the "shared with me" lookups use the partial
 * indexes (the team lookup reads `uq_table_app_audiences_team`).
 */
export const tableAppAudiences = pgTable(
  'table_app_audiences',
  {
    id: serial('id').primaryKey(),
    app_id: integer('app_id')
      .notNull()
      .references(() => tableApps.id, { onDelete: 'cascade' }),
    principal_type: text('principal_type', { enum: ['user', 'group', 'team'] }).notNull(),
    /** principal_type = user (logical → users). */
    user_id: text('user_id'),
    /** principal_type = group; membership is `group_members` rows only. */
    group_id: integer('group_id').references(() => userGroups.id, { onDelete: 'cascade' }),
    /** A role key of the app's spec (a key the live version no longer has grants nothing). */
    role_key: text('role_key').notNull(),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check(
      'chk_table_app_audiences_principal',
      sql`(${table.principal_type} = 'user' AND ${table.user_id} IS NOT NULL AND ${table.group_id} IS NULL)
        OR (${table.principal_type} = 'group' AND ${table.group_id} IS NOT NULL AND ${table.user_id} IS NULL)
        OR (${table.principal_type} = 'team' AND ${table.user_id} IS NULL AND ${table.group_id} IS NULL)`,
    ),
    uniqueIndex('uq_table_app_audiences_user')
      .on(table.app_id, table.user_id)
      .where(sql`${table.principal_type} = 'user'`),
    uniqueIndex('uq_table_app_audiences_group')
      .on(table.app_id, table.group_id)
      .where(sql`${table.principal_type} = 'group'`),
    uniqueIndex('uq_table_app_audiences_team')
      .on(table.app_id)
      .where(sql`${table.principal_type} = 'team'`),
    index('idx_table_app_audiences_user')
      .on(table.user_id)
      .where(sql`${table.principal_type} = 'user'`),
    index('idx_table_app_audiences_group')
      .on(table.group_id)
      .where(sql`${table.principal_type} = 'group'`),
  ],
);

/** A person's pinned apps, in their sidebar order (server-side, D9). */
export const tableAppPins = pgTable(
  'table_app_pins',
  {
    user_id: text('user_id').notNull(),
    app_id: integer('app_id')
      .notNull()
      .references(() => tableApps.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.app_id] }), index('idx_table_app_pins_app').on(table.app_id)],
);

/**
 * The app gateway's action ledger: one row per app write a person asked for,
 * keyed by their `requestId`. A repeated request replays the first result
 * instead of writing twice (`status = 'done'` keeps it); a request that was
 * refused leaves no row, so a retry runs again. The rows also count usage —
 * runs per action id in the managers' summary.
 */
export const tableAppActionRequests = pgTable(
  'table_app_action_requests',
  {
    id: serial('id').primaryKey(),
    app_id: integer('app_id')
      .notNull()
      .references(() => tableApps.id, { onDelete: 'cascade' }),
    /** Who asked (logical → users). */
    user_id: text('user_id').notNull(),
    /** The client's idempotency key. */
    request_id: text('request_id').notNull(),
    /** A spec action id, or `$submit` / `$create` / `$move` / `$edit`. */
    action_id: text('action_id').notNull(),
    page_id: text('page_id').notNull(),
    card_id: text('card_id').notNull(),
    record_id: integer('record_id'),
    status: text('status', { enum: ['running', 'done'] }).notNull(),
    /** The `AppActionResult` answered the first time (replayed as is). */
    result: jsonb('result').$type<Record<string, unknown>>(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_table_app_action_requests_request').on(table.app_id, table.user_id, table.request_id),
    index('idx_table_app_action_requests_app_created').on(table.app_id, table.created_at),
  ],
);

/** `table_app_versions.custom_review` (stored with snake_case keys, as the rest of the row). */
export interface TableAppCustomReviewRecord {
  status: AppCustomReviewStatus;
  /** The `spec_hash` the review is for; a different hash is not reviewed. */
  hash: string;
  reviewed_by?: string;
  reviewed_at?: string;
  note?: string;
}

/**
 * App templates (Phase 2, docs/specs/20261011-tables-apps-advanced.md §6, D9):
 * built-in templates synced from the repo at boot (`source = 'builtin'`, no
 * owner) and templates members publish from an app they manage. Modelled on
 * the skill center's lifecycle without reusing it. `latest_version` is the
 * newest version, denormalized for lists; `source_app_id` / `source_base_id`
 * say where a published template was saved from (null once those are gone).
 */
export const tableAppTemplates = pgTable(
  'table_app_templates',
  {
    id: serial('id').primaryKey(),
    /** Stable slug (`APP_ID_PATTERN`); built-ins keep their file key (`procurement`, `it-tickets`…). */
    key: text('key').notNull(),
    source: text('source', { enum: ['builtin', 'published'] })
      .$type<AppTemplateSource>()
      .notNull(),
    /** As published (built-ins: English; the localized words live in the version content). */
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    icon: text('icon').$type<AppIconName>().notNull().default('app'),
    accent: text('accent').$type<AppAccent>().notNull().default('brand'),
    /** The publisher (logical → users); null for built-ins. */
    owner_id: text('owner_id'),
    status: text('status', { enum: ['active', 'archived'] })
      .$type<AppTemplateStatus>()
      .notNull()
      .default('active'),
    latest_version: text('latest_version'),
    source_app_id: integer('source_app_id').references(() => tableApps.id, { onDelete: 'set null' }),
    source_base_id: integer('source_base_id').references(() => tableBases.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('uq_table_app_templates_key').on(table.key),
    index('idx_table_app_templates_status').on(table.status, table.updated_at),
    index('idx_table_app_templates_owner').on(table.owner_id),
  ],
);

/**
 * Immutable template versions: strict semver per template, a changelog,
 * `content` = the template JSON (a fixed schema plan + app spec, sample rows
 * only as hand-written in the template editor) stored as the exact text
 * `content_hash` (sha256 hex) was computed over. `custom_cards` /
 * `automations` say what it carries — either one makes `review_status`
 * `pending` until a super approves; `scan_status` is the content scan's verdict
 * (`blocked` sticks). `reviewed_by` / `reviewed_at` / `review_note` record the
 * super's one decision on both.
 */
export const tableAppTemplateVersions = pgTable(
  'table_app_template_versions',
  {
    id: serial('id').primaryKey(),
    template_id: integer('template_id').notNull(),
    version: text('version').notNull(),
    changelog: text('changelog').notNull().default(''),
    content: text('content').notNull(),
    content_hash: text('content_hash').notNull(),
    custom_cards: integer('custom_cards').notNull().default(0),
    automations: integer('automations').notNull().default(0),
    scan_status: text('scan_status', { enum: ['pending', 'clean', 'suspicious', 'blocked'] })
      .$type<AppTemplateScanStatus>()
      .notNull()
      .default('pending'),
    scan_findings: jsonb('scan_findings').$type<unknown[]>(),
    scanned_at: timestamp('scanned_at', { withTimezone: true, mode: 'string' }),
    review_status: text('review_status', { enum: ['not_required', 'pending', 'approved', 'rejected'] })
      .$type<AppTemplateReviewStatus>()
      .notNull()
      .default('pending'),
    /** The super who ruled (logical → users). */
    reviewed_by: text('reviewed_by'),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
    review_note: text('review_note'),
    /** The app version it was generated from (published templates). */
    source_app_version: integer('source_app_version'),
    /** Null for built-ins (logical → users). */
    published_by: text('published_by'),
    published_at: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    // Named by hand: the generated name would pass Postgres' 63-character limit.
    foreignKey({
      name: 'table_app_template_versions_template_fk',
      columns: [table.template_id],
      foreignColumns: [tableAppTemplates.id],
    }).onDelete('cascade'),
    uniqueIndex('uq_table_app_template_versions_version').on(table.template_id, table.version),
    index('idx_table_app_template_versions_review').on(table.review_status, table.published_at),
  ],
);

export type TableAppRow = typeof tableApps.$inferSelect;
export type TableAppVersionRow = typeof tableAppVersions.$inferSelect;
export type TableAppAudienceRow = typeof tableAppAudiences.$inferSelect;
export type TableAppPinRow = typeof tableAppPins.$inferSelect;
export type TableAppActionRequestRow = typeof tableAppActionRequests.$inferSelect;
export type TableAppTemplateRow = typeof tableAppTemplates.$inferSelect;
export type TableAppTemplateVersionRow = typeof tableAppTemplateVersions.$inferSelect;
