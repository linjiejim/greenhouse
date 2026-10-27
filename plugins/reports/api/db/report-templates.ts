import { reportTemplates } from '../schema.js';
/**
 * Report templates service — persistence only (migration 0013, v1.7).
 *
 * Who may see or change a template, and whether a definition is well formed,
 * is decided in the API layer (../templates.ts); this
 * service stores already-checked definitions (jsonb) and reads them back
 * with the owner's nickname. Deletes are soft (`deleted_at`), so a seed that
 * runs "only while there has never been a template" stays a one-time event.
 */

import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/api/extension-kit';

import type { Db } from '@greenhouse/api/extension-kit';
import type { ReportFormat, ReportTemplateCoverField, ReportTemplateSection } from '@greenhouse/types/reports';
import { newId } from '@greenhouse/api/extension-kit';
import { users } from '@greenhouse/api/extension-kit';
import type { ReportTemplateRow } from '../schema.js';

export type ReportTemplateVisibilityValue = ReportTemplateRow['visibility'];
export type ReportTemplateKindValue = ReportTemplateRow['kind'];

export interface ReportTemplateWriteInput {
  name: string;
  description: string;
  kind: ReportTemplateKindValue;
  /** Already-checked values (jsonb). */
  formats: readonly ReportFormat[];
  sections: readonly ReportTemplateSection[];
  cover_fields: readonly ReportTemplateCoverField[];
  visibility: ReportTemplateVisibilityValue;
}

export interface ReportTemplateCreateInput extends ReportTemplateWriteInput {
  /** NULL = shipped with Greenhouse (the first-boot defaults). */
  owner_user_id: string | null;
  is_default?: boolean;
  created_by: string | null;
}

export interface ReportTemplateWithOwner extends ReportTemplateRow {
  owner_name: string | null;
}

function newTemplateId(): string {
  return newId('reportTemplate');
}

export function createReportTemplateService(db: Db) {
  const live = isNull(reportTemplates.deleted_at);
  const withOwner = {
    template: reportTemplates,
    owner_name: users.nickname,
  };
  const flatten = (row: { template: ReportTemplateRow; owner_name: string | null }): ReportTemplateWithOwner => ({
    ...row.template,
    owner_name: row.owner_name,
  });

  const service = {
    async create(input: ReportTemplateCreateInput): Promise<ReportTemplateRow> {
      const at = nowIso();
      const [row] = await db
        .insert(reportTemplates)
        .values({
          id: newTemplateId(),
          name: input.name,
          description: input.description,
          kind: input.kind,
          formats: [...input.formats],
          sections: [...input.sections],
          cover_fields: [...input.cover_fields],
          visibility: input.visibility,
          owner_user_id: input.owner_user_id,
          is_default: input.is_default ?? false,
          version: 1,
          created_by: input.created_by,
          updated_by: input.created_by,
          created_at: at,
          updated_at: at,
        })
        .returning();
      return row!;
    },

    /** A live template by id, whoever owns it (visibility is the caller's check). */
    async get(id: string): Promise<ReportTemplateWithOwner | null> {
      const rows = await db
        .select(withOwner)
        .from(reportTemplates)
        .leftJoin(users, eq(users.id, reportTemplates.owner_user_id))
        .where(and(eq(reportTemplates.id, id), live))
        .limit(1);
      return rows[0] ? flatten(rows[0]) : null;
    },

    /** Every team template plus the viewer's own drafts, team first, then by name. */
    async listVisible(viewerId: string): Promise<ReportTemplateWithOwner[]> {
      const rows = await db
        .select(withOwner)
        .from(reportTemplates)
        .leftJoin(users, eq(users.id, reportTemplates.owner_user_id))
        .where(
          and(
            live,
            or(
              eq(reportTemplates.visibility, 'team'),
              and(eq(reportTemplates.visibility, 'personal'), eq(reportTemplates.owner_user_id, viewerId)),
            ),
          ),
        )
        .orderBy(desc(sql`${reportTemplates.visibility} = 'team'`), asc(reportTemplates.name), asc(reportTemplates.id));
      return rows.map(flatten);
    },

    /** Replace the definition and bump the version. Null when the template is gone. */
    async update(id: string, input: ReportTemplateWriteInput, by: string): Promise<ReportTemplateRow | null> {
      const [row] = await db
        .update(reportTemplates)
        .set({
          name: input.name,
          description: input.description,
          kind: input.kind,
          formats: [...input.formats],
          sections: [...input.sections],
          cover_fields: [...input.cover_fields],
          visibility: input.visibility,
          version: sql`${reportTemplates.version} + 1`,
          updated_by: by,
          updated_at: nowIso(),
        })
        .where(and(eq(reportTemplates.id, id), live))
        .returning();
      return row ?? null;
    },

    async softDelete(id: string, by: string): Promise<boolean> {
      const rows = await db
        .update(reportTemplates)
        .set({ deleted_at: nowIso(), updated_by: by, updated_at: nowIso() })
        .where(and(eq(reportTemplates.id, id), live))
        .returning({ id: reportTemplates.id });
      return rows.length > 0;
    },

    /**
     * Insert `rows` only while the table has never held a template (deleted
     * ones count), under a transaction-scoped advisory lock so two API
     * processes booting together seed once. Returns how many were inserted.
     */
    async seedIfNeverUsed(rows: readonly ReportTemplateCreateInput[]): Promise<number> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('report_templates:seed', 0))`);
        const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(reportTemplates);
        if (Number(row?.n ?? 0) > 0) return 0;
        const at = nowIso();
        for (const input of rows) {
          await tx.insert(reportTemplates).values({
            id: newTemplateId(),
            name: input.name,
            description: input.description,
            kind: input.kind,
            formats: [...input.formats],
            sections: [...input.sections],
            cover_fields: [...input.cover_fields],
            visibility: input.visibility,
            owner_user_id: input.owner_user_id,
            is_default: input.is_default ?? false,
            version: 1,
            created_by: input.created_by,
            updated_by: input.created_by,
            created_at: at,
            updated_at: at,
          });
        }
        return rows.length;
      });
    },
  };
  return service;
}
