/**
 * Report templates rendered into Files as PDF / DOCX / PPTX. Visibility and
 * editing rules live in `./templates.ts`. `owner_user_id` is
 * a loose reference (team templates outlive their author); null = built-in.
 * Deleting stamps `deleted_at`.
 *
 * Tables: report_templates
 */

import { boolean, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import type { ReportFormat, ReportTemplateCoverField, ReportTemplateSection } from '@greenhouse/types/reports';
import { at, createdAt, id, json, oneOf, updatedAt } from '@greenhouse/api/extension-kit';

export const REPORT_TEMPLATE_KINDS = ['report', 'presentation'] as const;
export const REPORT_TEMPLATE_VISIBILITIES = ['team', 'personal'] as const;

export const reportTemplates = pgTable(
  'report_templates',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    kind: text('kind', { enum: REPORT_TEMPLATE_KINDS }).notNull(),
    formats: json<ReportFormat[]>('formats', []),
    sections: json<ReportTemplateSection[]>('sections', []),
    cover_fields: json<ReportTemplateCoverField[]>('cover_fields', []),
    visibility: text('visibility', { enum: REPORT_TEMPLATE_VISIBILITIES }).notNull().default('personal'),
    owner_user_id: text('owner_user_id'),
    is_default: boolean('is_default').notNull().default(false),
    version: integer('version').notNull().default(1),
    created_by: text('created_by'),
    updated_by: text('updated_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
    deleted_at: at('deleted_at'),
  },
  (table) => [
    index('idx_report_templates_visibility').on(table.visibility, table.updated_at),
    index('idx_report_templates_owner').on(table.owner_user_id, table.updated_at),
    oneOf('chk_report_templates_kind', table.kind, REPORT_TEMPLATE_KINDS),
    oneOf('chk_report_templates_visibility', table.visibility, REPORT_TEMPLATE_VISIBILITIES),
  ],
);

export type ReportTemplateRow = typeof reportTemplates.$inferSelect;
