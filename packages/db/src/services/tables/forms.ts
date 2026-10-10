/**
 * Forms: configuration and submission. A submission is a record write
 * (`actorKind: 'form'`, `source.formId`) plus a `table_form_submissions` row in
 * the same transaction — for `allowMultiple: false` forms the partial unique
 * index makes concurrent double submits succeed once.
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { TableFormConfig, TableRecordValues, TableRecordWriteMeta } from '@greenhouse/types/tables';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import type { Db } from '../../client.js';
import { tableFields, tableFormSubmissions, tableForms } from '../../schema/index.js';
import type { TableFormRow, TableRecordRow } from '../../schema/tables.js';
import type { TablesRecordInternals } from './records.js';
import {
  isComputedField,
  isPositiveInteger,
  MAX_FIELDS,
  TablesValidationError,
  trimmed,
  type TableRevisionResult,
} from './shared.js';

export interface CreateTableFormInput {
  table_id: number;
  name: string;
  status?: 'draft' | 'published';
  config: TableFormConfig;
  user_id: string;
}

export interface UpdateTableFormInput {
  revision: number;
  name?: string;
  status?: 'draft' | 'published';
  config?: TableFormConfig;
  user_id: string;
}

export function createTablesForms(db: Db, deps: { records: TablesRecordInternals }) {
  const normalizeFormConfig = async (tableId: number, input: TableFormConfig): Promise<TableFormConfig> => {
    if (!input || typeof input !== 'object' || !Array.isArray(input.fieldIds)) {
      throw new TablesValidationError('Form config requires fieldIds');
    }
    const fieldIds = [...new Set(input.fieldIds)];
    if (fieldIds.length < 1 || fieldIds.length > MAX_FIELDS || !fieldIds.every(isPositiveInteger)) {
      throw new TablesValidationError(`Form requires 1-${MAX_FIELDS} valid field ids`);
    }
    const fields = await db
      .select()
      .from(tableFields)
      .where(
        and(eq(tableFields.table_id, tableId), inArray(tableFields.id, fieldIds), isNull(tableFields.archived_at)),
      );
    if (
      fields.length !== fieldIds.length ||
      fields.some((field) => isComputedField(field) || field.type === 'attachment')
    ) {
      throw new TablesValidationError(
        'Form fields must be active, writable, non-attachment fields on the target table',
      );
    }
    const text = (value: string | undefined, fallback: string, max: number) =>
      value === undefined ? fallback : value.trim().slice(0, max);
    return {
      version: 1,
      title: text(input.title, '', 120),
      description: text(input.description, '', 2_000),
      fieldIds,
      submitLabel: text(input.submitLabel, 'Submit', 60),
      successMessage: text(input.successMessage, 'Submitted successfully.', 500),
    };
  };

  const service = {
    async listForms(tableId: number): Promise<TableFormRow[]> {
      return db.select().from(tableForms).where(eq(tableForms.table_id, tableId)).orderBy(asc(tableForms.id));
    },

    async getForm(id: number): Promise<TableFormRow | undefined> {
      const rows = await db.select().from(tableForms).where(eq(tableForms.id, id)).limit(1);
      return rows[0];
    },

    async createForm(input: CreateTableFormInput): Promise<TableFormRow> {
      const now = nowIso();
      const config = await normalizeFormConfig(input.table_id, input.config);
      const [row] = await db
        .insert(tableForms)
        .values({
          table_id: input.table_id,
          name: trimmed(input.name, 'Form name', 120),
          status: input.status ?? 'draft',
          config,
          revision: 1,
          created_by: input.user_id,
          updated_by: input.user_id,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateForm(id: number, patch: UpdateTableFormInput): Promise<TableRevisionResult<TableFormRow>> {
      const current = await service.getForm(id);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const values: Partial<TableFormRow> = {
        revision: patch.revision + 1,
        updated_by: patch.user_id,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Form name', 120);
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.config !== undefined) values.config = await normalizeFormConfig(current.table_id, patch.config);
      const rows = await db
        .update(tableForms)
        .set(values)
        .where(and(eq(tableForms.id, id), eq(tableForms.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await service.getForm(id);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    /**
     * Submit a published form as `meta.actorId`. Only the form's fields may be
     * written; `meta.source.formId` is forced to this form.
     */
    async submitForm(
      formId: number,
      values: TableRecordValues,
      scope: TableAccessScope,
      meta: TableRecordWriteMeta,
    ): Promise<TableRecordRow> {
      const form = await service.getForm(formId);
      if (!form || form.status !== 'published') throw new TablesValidationError('Form is not published');
      const allowed = new Set(form.config.fieldIds.map(String));
      if (Object.keys(values).some((fieldId) => !allowed.has(fieldId))) {
        throw new TablesValidationError('Form submission contains a field that is not published');
      }
      const formMeta: TableRecordWriteMeta = { ...meta, source: { ...meta.source, formId: form.id } };
      return deps.records.createRecord({ table_id: form.table_id, values }, scope, formMeta, {
        inTransaction: async (tx, record) => {
          await tx.insert(tableFormSubmissions).values({
            form_id: form.id,
            user_id: meta.actorId,
            record_id: record.id,
            single_submit: form.config.allowMultiple === false,
            created_at: nowIso(),
          });
        },
      });
    },
  };

  return service;
}
