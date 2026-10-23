/**
 * Drizzle schema — report templates (PostgreSQL, migration 0013, v1.7).
 *
 * The team's required shape for reports and presentations: ordered sections
 * with guidance, cover fields and allowed output formats. Managed in SkillHub ›
 * Report templates; agents read them over MCP (`report_templates`) and render
 * content against them (`report_render`, files land in Files).
 *
 * - `sections` / `cover_fields` / `formats` are JSON-as-text (NOT NULL), shaped
 *   and checked by `checkReportTemplateDefinition` in @greenhouse/types/reports.
 * - `visibility='team'` is visible to every member; `personal` is a draft only
 *   its owner sees.
 * - `owner_user_id` is a loose ref (no FK), like agent_skills: a team template
 *   outlives the member who wrote it. NULL = shipped with Greenhouse (seeded on
 *   first boot), which only a super may change.
 * - Deleting stamps `deleted_at`; the row stays so the first-boot seed (which
 *   runs only while the table has never had a row) does not bring deleted
 *   defaults back.
 */

import { boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const reportTemplates = pgTable(
  'report_templates',
  {
    /** `rtpl_<hex>` — system-assigned. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    kind: text('kind', { enum: ['report', 'presentation'] }).notNull(),
    /** JSON array of output formats, canonical order. */
    formats: text('formats').notNull().default('[]'),
    /** JSON array of { key, title, guidance, required, content }. */
    sections: text('sections').notNull().default('[]'),
    /** JSON array of { key, required }. */
    cover_fields: text('cover_fields').notNull().default('[]'),
    visibility: text('visibility', { enum: ['team', 'personal'] })
      .notNull()
      .default('personal'),
    owner_user_id: text('owner_user_id'),
    is_default: boolean('is_default').notNull().default(false),
    version: integer('version').notNull().default(1),
    created_by: text('created_by'),
    updated_by: text('updated_by'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
    deleted_at: ts('deleted_at'),
  },
  (table) => [
    index('idx_report_templates_visibility').on(table.visibility, table.updated_at),
    index('idx_report_templates_owner').on(table.owner_user_id, table.updated_at),
  ],
);

export type ReportTemplateRow = typeof reportTemplates.$inferSelect;
