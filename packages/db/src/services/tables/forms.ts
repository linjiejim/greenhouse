/**
 * Forms: configuration, audiences and submission (spec 20261011-tables-foundation §3).
 *
 * - **Config** (`normalizeFormConfig`): shown fields (`fieldIds`, never computed;
 *   no relation unless the audience is the Base), hidden locked `defaults`
 *   (`[{fieldId, value}]`, values may be `$me` / `$today` / `$now`; the legacy
 *   `{<fieldId>: value}` object is read as the array), `allowMultiple` (default
 *   true). A field is either shown or prefilled, never both.
 * - **Audience** (`normalizeFormAudience`): `{type:'base'}` (Base members with
 *   create rights), `{type:'team'}` (every active internal user) or
 *   `{type:'principals', userIds, groupIds}`. Whether the granter may name a
 *   group is the caller's check (the db does not know who is granting).
 * - **Submission** (`submitForm`): a record write (`actorKind: 'form'`,
 *   `source.formId`) plus a `table_form_submissions` row in the same
 *   transaction — for `allowMultiple: false` forms the partial unique index
 *   makes concurrent double submits succeed once. Defaults are resolved here
 *   and win over anything the client sent for those fields. Attachment values
 *   must be files the submitter staged through this form (`POST
 *   /api/forms/:id/uploads`): `pending` drive rows in the Base's tables scope,
 *   uploaded by them, under the form's key segment (`FORM_UPLOAD_KEY_SEGMENT`).
 *   They are claimed (pending → active) before the write and released if it
 *   fails; never-submitted ones are expired by the upkeep sweep.
 */

import { and, asc, eq, inArray, isNull, lt, notExists, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { expandDateToken } from '@greenhouse/types/date-tokens';
import type {
  TableFieldValueEntry,
  TableFormAudience,
  TableFormConfig,
  TableRecordValues,
  TableRecordWriteMeta,
} from '@greenhouse/types/tables';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import type { Db } from '../../client.js';
import {
  driveFiles,
  groupMembers,
  tableFields,
  tableFormSubmissions,
  tableForms,
  tableRecordAttachments,
  tableTables,
  userGroups,
  users,
} from '../../schema/index.js';
import type { TableFieldRow, TableFormRow, TableRecordRow } from '../../schema/tables.js';
import { resolveTableEvaluation, type TableQueryEvaluation } from './query.js';
import type { TablesRecordInternals } from './records.js';
import {
  isComputedField,
  isPlainObject,
  isPositiveInteger,
  MAX_FIELDS,
  TablesValidationError,
  trimmed,
  validateTableFieldValue,
  type TableRevisionResult,
} from './shared.js';

export interface CreateTableFormInput {
  table_id: number;
  name: string;
  status?: 'draft' | 'published';
  config: TableFormConfig;
  audience?: TableFormAudience;
  user_id: string;
}

export interface UpdateTableFormInput {
  revision: number;
  name?: string;
  status?: 'draft' | 'published';
  config?: TableFormConfig;
  audience?: TableFormAudience;
  user_id: string;
}

export interface SubmitTableFormOptions {
  /** `$today` / `$now` defaults resolve at this instant, in this zone (the submitter's). */
  evaluation?: TableQueryEvaluation;
}

/** A staged upload the sweep expired: the caller removes the stored object. */
export interface ExpiredFormUpload {
  id: number;
  cos_key: string;
}

const MAX_AUDIENCE_USERS = 500;
const MAX_AUDIENCE_GROUPS = 100;

/**
 * Where a form upload's object key lives, below the drive prefix:
 * `tables/<baseId>/forms/<formId>/<uuid><ext>` (the API's `driveKeyFor({formId})`
 * writes exactly this). The segment is what marks a pending drive row as "staged
 * through form N", so only those are bound on submit or expired by the sweep.
 */
export function formUploadKeySegment(baseId: number, formId: number): string {
  return `tables/${baseId}/forms/${formId}/`;
}

/** Field types a default may hold a token for, and the token each takes. */
const DEFAULT_TOKEN_TYPES: Readonly<Record<string, ReadonlySet<TableFieldRow['type']>>> = {
  $me: new Set(['user', 'multi_user']),
  $today: new Set(['date']),
  $now: new Set(['datetime']),
};

function isDefaultToken(field: Pick<TableFieldRow, 'type'>, value: unknown): value is string {
  return typeof value === 'string' && DEFAULT_TOKEN_TYPES[value]?.has(field.type) === true;
}

/** The array form of `config.defaults`, accepting the legacy `{<fieldId>: value}` object. */
export function formDefaultEntries(config: Pick<TableFormConfig, 'defaults'> | undefined): TableFieldValueEntry[] {
  const raw: unknown = config?.defaults;
  if (Array.isArray(raw)) {
    return raw.filter(
      (entry): entry is TableFieldValueEntry => isPlainObject(entry) && isPositiveInteger(entry.fieldId),
    );
  }
  if (isPlainObject(raw)) {
    return Object.entries(raw)
      .filter(([key]) => /^\d+$/.test(key))
      .map(([key, value]) => ({ fieldId: Number(key), value }));
  }
  return [];
}

/** Every field a submission writes: the shown ones, then the prefilled ones. */
export function formWritableFieldIds(config: TableFormConfig): number[] {
  return [...new Set([...config.fieldIds, ...formDefaultEntries(config).map((entry) => entry.fieldId)])];
}

/** Shape-check an audience. Group visibility to the granter is the caller's check. */
export function normalizeFormAudience(raw: unknown): TableFormAudience {
  if (raw === undefined || raw === null) return { type: 'base' };
  if (!isPlainObject(raw)) throw new TablesValidationError('Form audience must be an object');
  if (raw.type === 'base' || raw.type === 'team') return { type: raw.type };
  if (raw.type !== 'principals') throw new TablesValidationError('Form audience type must be base, team or principals');
  const userIds = Array.isArray(raw.userIds) ? raw.userIds : [];
  const groupIds = Array.isArray(raw.groupIds) ? raw.groupIds : [];
  if (!userIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
    throw new TablesValidationError('Form audience userIds must be user ids');
  }
  if (!groupIds.every(isPositiveInteger)) throw new TablesValidationError('Form audience groupIds must be group ids');
  const audience = {
    type: 'principals' as const,
    userIds: [...new Set(userIds as string[])],
    groupIds: [...new Set(groupIds as number[])],
  };
  if (audience.userIds.length === 0 && audience.groupIds.length === 0) {
    throw new TablesValidationError('Choose at least one person or group for this form');
  }
  if (audience.userIds.length > MAX_AUDIENCE_USERS || audience.groupIds.length > MAX_AUDIENCE_GROUPS) {
    throw new TablesValidationError(
      `A form audience lists up to ${MAX_AUDIENCE_USERS} people and ${MAX_AUDIENCE_GROUPS} groups`,
    );
  }
  return audience;
}

export function createTablesForms(db: Db, deps: { records: TablesRecordInternals }) {
  const activeFieldsOf = async (tableId: number, fieldIds: number[]): Promise<TableFieldRow[]> =>
    fieldIds.length === 0
      ? []
      : db
          .select()
          .from(tableFields)
          .where(
            and(eq(tableFields.table_id, tableId), inArray(tableFields.id, fieldIds), isNull(tableFields.archived_at)),
          );

  const activeInternalUserIds = async (ids?: readonly string[]): Promise<Set<string>> => {
    if (ids && ids.length === 0) return new Set();
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.status, 'active'),
          inArray(users.role, ['team', 'super']),
          ids ? inArray(users.id, [...ids]) : undefined,
        ),
      );
    return new Set(rows.map((row) => row.id));
  };

  /**
   * The audience, where every newly named person must be an active internal
   * user and every newly named group must exist. Entries already on the form
   * (`current`) stay as they are — someone deactivated since, or a deleted
   * group, admits nobody and must not block editing the rest of the form.
   */
  const validateAudience = async (raw: unknown, current?: TableFormAudience): Promise<TableFormAudience> => {
    const audience = normalizeFormAudience(raw);
    if (audience.type !== 'principals') return audience;
    const kept: { userIds: readonly string[]; groupIds: readonly number[] } =
      current?.type === 'principals' ? current : { userIds: [], groupIds: [] };
    const addedUsers = audience.userIds.filter((id) => !kept.userIds.includes(id));
    const addedGroups = audience.groupIds.filter((id) => !kept.groupIds.includes(id));
    const active = await activeInternalUserIds(addedUsers);
    if (addedUsers.some((id) => !active.has(id))) {
      throw new TablesValidationError('Form audience lists someone who is not an active internal user');
    }
    if (addedGroups.length > 0) {
      const found = await db.select({ id: userGroups.id }).from(userGroups).where(inArray(userGroups.id, addedGroups));
      if (found.length !== addedGroups.length) {
        throw new TablesValidationError('Form audience lists a group that does not exist');
      }
    }
    return audience;
  };

  const normalizeDefaults = async (
    raw: TableFormConfig,
    fieldsById: Map<number, TableFieldRow>,
    shown: ReadonlySet<number>,
  ): Promise<TableFieldValueEntry[]> => {
    const entries = formDefaultEntries(raw);
    if (raw.defaults !== undefined && !Array.isArray(raw.defaults) && !isPlainObject(raw.defaults)) {
      throw new TablesValidationError('Form defaults must be a list of {fieldId, value}');
    }
    if (entries.length > MAX_FIELDS) throw new TablesValidationError(`A form prefills up to ${MAX_FIELDS} fields`);
    const seen = new Set<number>();
    const needsUsers = entries.some((entry) => {
      const field = fieldsById.get(entry.fieldId);
      return (field?.type === 'user' || field?.type === 'multi_user') && entry.value !== '$me';
    });
    const activeUserIds = needsUsers ? await activeInternalUserIds() : new Set<string>();
    return entries.map((entry) => {
      const field = fieldsById.get(entry.fieldId);
      if (!field) throw new TablesValidationError('Form defaults must name active fields on the target table');
      if (seen.has(field.id)) throw new TablesValidationError(`Field "${field.name}" is prefilled twice`);
      seen.add(field.id);
      if (shown.has(field.id)) {
        throw new TablesValidationError(`Field "${field.name}" is both shown and prefilled; choose one`);
      }
      if (isComputedField(field) || field.type === 'attachment') {
        throw new TablesValidationError(`Field "${field.name}" cannot be prefilled`);
      }
      if (isDefaultToken(field, entry.value)) return { fieldId: field.id, value: entry.value };
      if (entry.value === null || entry.value === undefined || entry.value === '') {
        throw new TablesValidationError(`Field "${field.name}" needs a prefilled value`);
      }
      return { fieldId: field.id, value: validateTableFieldValue(field, entry.value, activeUserIds) };
    });
  };

  const normalizeFormConfig = async (
    tableId: number,
    input: TableFormConfig,
    audience: TableFormAudience,
  ): Promise<TableFormConfig> => {
    if (!input || typeof input !== 'object' || !Array.isArray(input.fieldIds)) {
      throw new TablesValidationError('Form config requires fieldIds');
    }
    const fieldIds = [...new Set(input.fieldIds)];
    if (fieldIds.length < 1 || fieldIds.length > MAX_FIELDS || !fieldIds.every(isPositiveInteger)) {
      throw new TablesValidationError(`Form requires 1-${MAX_FIELDS} valid field ids`);
    }
    const defaultIds = formDefaultEntries(input).map((entry) => entry.fieldId);
    const fields = await activeFieldsOf(tableId, [...new Set([...fieldIds, ...defaultIds])]);
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    const shown = fieldIds.map((id) => fieldsById.get(id));
    if (shown.some((field) => !field || isComputedField(field))) {
      throw new TablesValidationError('Form fields must be active, writable fields on the target table');
    }
    if (audience.type !== 'base') {
      const relation = shown.find((field) => field?.type === 'relation');
      if (relation) {
        throw new TablesValidationError(
          `Field "${relation.name}" links other records; only forms for Base members can show relation fields`,
        );
      }
    }
    const defaults = await normalizeDefaults(input, fieldsById, new Set(fieldIds));
    if (input.allowMultiple !== undefined && typeof input.allowMultiple !== 'boolean') {
      throw new TablesValidationError('allowMultiple must be a boolean');
    }
    const text = (value: string | undefined, fallback: string, max: number) =>
      typeof value !== 'string' ? fallback : value.trim().slice(0, max);
    return {
      version: 1,
      title: text(input.title, '', 120),
      description: text(input.description, '', 2_000),
      fieldIds,
      submitLabel: text(input.submitLabel, 'Submit', 60),
      successMessage: text(input.successMessage, 'Submitted successfully.', 500),
      defaults,
      allowMultiple: input.allowMultiple !== false,
    };
  };

  /** Resolve a stored default for one submission (`$me` / `$today` / `$now`, else the stored value). */
  const resolveDefault = (
    field: TableFieldRow,
    value: unknown,
    actorId: string,
    evaluation: { now: Date; timeZone: string },
  ): unknown => {
    if (!isDefaultToken(field, value)) return value;
    if (value === '$me') return field.type === 'multi_user' ? [actorId] : actorId;
    if (value === '$now') return evaluation.now.toISOString();
    return expandDateToken('$today', evaluation.now, evaluation.timeZone);
  };

  const formBaseId = async (tableId: number): Promise<number> => {
    const [table] = await db
      .select({ base_id: tableTables.base_id })
      .from(tableTables)
      .where(eq(tableTables.id, tableId))
      .limit(1);
    if (!table) throw new TablesValidationError('Form table not found');
    return table.base_id;
  };

  /** Put claimed form uploads back to pending (nothing bound them). */
  const releaseUploads = async (fileIds: number[]): Promise<void> => {
    if (fileIds.length === 0) return;
    await db
      .update(driveFiles)
      .set({ status: 'pending', updated_at: nowIso() })
      .where(
        and(
          inArray(driveFiles.id, fileIds),
          eq(driveFiles.status, 'active'),
          notExists(
            db
              .select({ id: tableRecordAttachments.id })
              .from(tableRecordAttachments)
              .where(eq(tableRecordAttachments.drive_file_id, driveFiles.id)),
          ),
        ),
      );
  };

  /**
   * Claim the submitter's staged uploads for this form (pending → active, one
   * atomic UPDATE). All or nothing: an id that is not theirs, not this form's,
   * already bound or expired fails the whole submission.
   */
  const claimUploads = async (
    form: TableFormRow,
    attachmentFields: TableFieldRow[],
    values: TableRecordValues,
    actorId: string,
  ): Promise<number[]> => {
    const requested = new Map<number, TableFieldRow>();
    for (const field of attachmentFields) {
      const value = values[String(field.id)];
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value) || !value.every(isPositiveInteger)) {
        throw new TablesValidationError(`Field "${field.name}" expects uploaded files`);
      }
      for (const id of value) {
        if (requested.has(id)) throw new TablesValidationError(`Field "${field.name}" lists a file twice`);
        requested.set(id, field);
      }
    }
    if (requested.size === 0) return [];
    const baseId = await formBaseId(form.table_id);
    const claimed = await db
      .update(driveFiles)
      .set({ status: 'active', updated_at: nowIso() })
      .where(
        and(
          inArray(driveFiles.id, [...requested.keys()]),
          eq(driveFiles.scope, 'tables'),
          eq(driveFiles.base_id, baseId),
          eq(driveFiles.status, 'pending'),
          eq(driveFiles.uploaded_by, actorId),
          sql`${driveFiles.cos_key} LIKE ${`%${formUploadKeySegment(baseId, form.id)}%`}`,
        ),
      )
      .returning({ id: driveFiles.id });
    if (claimed.length !== requested.size) {
      const claimedIds = new Set(claimed.map((row) => row.id));
      await releaseUploads([...claimedIds]);
      const missing = [...requested.entries()].find(([id]) => !claimedIds.has(id));
      throw new TablesValidationError(`Field "${missing?.[1].name ?? ''}" references a file that is not available`);
    }
    return claimed.map((row) => row.id);
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
      const audience = await validateAudience(input.audience);
      const config = await normalizeFormConfig(input.table_id, input.config, audience);
      const [row] = await db
        .insert(tableForms)
        .values({
          table_id: input.table_id,
          name: trimmed(input.name, 'Form name', 120),
          status: input.status ?? 'draft',
          config,
          audience,
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
      const audience =
        patch.audience !== undefined ? await validateAudience(patch.audience, current.audience) : current.audience;
      if (patch.audience !== undefined) values.audience = audience;
      // A new audience re-checks the stored config (a relation field cannot go public).
      if (patch.config !== undefined || patch.audience !== undefined) {
        values.config = await normalizeFormConfig(current.table_id, patch.config ?? current.config, audience);
      }
      const rows = await db
        .update(tableForms)
        .set(values)
        .where(and(eq(tableForms.id, id), eq(tableForms.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await service.getForm(id);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    /** The shown fields of a form, in form order (active ones only). */
    async listFormFields(form: Pick<TableFormRow, 'table_id' | 'config'>): Promise<TableFieldRow[]> {
      const byId = new Map(
        (await activeFieldsOf(form.table_id, form.config.fieldIds)).map((field) => [field.id, field]),
      );
      return form.config.fieldIds
        .map((id) => byId.get(id))
        .filter((field): field is TableFieldRow => field !== undefined && !isComputedField(field));
    },

    /** Is `userId` named by a principals audience — directly, or through a `group_members` row (never as a group's creator)? */
    async formAudienceIncludes(audience: TableFormAudience, userId: string): Promise<boolean> {
      if (audience.type !== 'principals') return false;
      if (audience.userIds.includes(userId)) return true;
      if (audience.groupIds.length === 0) return false;
      const rows = await db
        .select({ id: groupMembers.id })
        .from(groupMembers)
        .where(and(eq(groupMembers.user_id, userId), inArray(groupMembers.group_id, audience.groupIds)))
        .limit(1);
      return rows.length > 0;
    },

    /** Has `userId` already used their one submission of a single-submit form? */
    async hasSubmittedForm(formId: number, userId: string): Promise<boolean> {
      const rows = await db
        .select({ id: tableFormSubmissions.id })
        .from(tableFormSubmissions)
        .where(
          and(
            eq(tableFormSubmissions.form_id, formId),
            eq(tableFormSubmissions.user_id, userId),
            eq(tableFormSubmissions.single_submit, true),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    /**
     * Submit a published form as `meta.actorId`. Only the shown fields come from
     * `values`; the prefilled ones are resolved here and replace anything sent
     * for them; attachments must be this person's staged uploads for this form.
     * `meta.source.formId` is forced to this form. A second submission of a
     * single-submit form fails on the unique index (a pg unique violation).
     */
    async submitForm(
      formId: number,
      values: TableRecordValues,
      scope: TableAccessScope,
      meta: TableRecordWriteMeta,
      options: SubmitTableFormOptions = {},
    ): Promise<TableRecordRow> {
      const form = await service.getForm(formId);
      if (!form || form.status !== 'published') throw new TablesValidationError('Form is not published');
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new TablesValidationError('values must be an object keyed by field id');
      }
      const defaults = formDefaultEntries(form.config);
      const prefilled = new Set(defaults.map((entry) => String(entry.fieldId)));
      const shown = new Set(form.config.fieldIds.map(String));
      const submitted: TableRecordValues = {};
      for (const [fieldId, value] of Object.entries(values)) {
        if (prefilled.has(fieldId)) continue; // locked: the resolved default wins
        if (!shown.has(fieldId)) {
          throw new TablesValidationError('Form submission contains a field that is not published');
        }
        submitted[fieldId] = value;
      }
      const fields = await activeFieldsOf(form.table_id, formWritableFieldIds(form.config));
      const fieldsById = new Map(fields.map((field) => [field.id, field]));
      const evaluation = resolveTableEvaluation(options.evaluation);
      for (const entry of defaults) {
        const field = fieldsById.get(entry.fieldId);
        if (!field) continue; // archived since the form was saved
        submitted[String(field.id)] = resolveDefault(field, entry.value, meta.actorId, evaluation);
      }

      const attachmentFields = fields.filter((field) => field.type === 'attachment' && shown.has(String(field.id)));
      const claimed = await claimUploads(form, attachmentFields, submitted, meta.actorId);
      const formMeta: TableRecordWriteMeta = { ...meta, source: { ...meta.source, formId: form.id } };
      try {
        return await deps.records.createRecord({ table_id: form.table_id, values: submitted }, scope, formMeta, {
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
      } catch (error) {
        await releaseUploads(claimed);
        throw error;
      }
    },

    /** Uploads one person has staged for one form and not yet submitted (the upload route caps them). */
    async countPendingFormUploads(formId: number, baseId: number, userId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(driveFiles)
        .where(
          and(
            eq(driveFiles.scope, 'tables'),
            eq(driveFiles.base_id, baseId),
            eq(driveFiles.status, 'pending'),
            eq(driveFiles.uploaded_by, userId),
            sql`${driveFiles.cos_key} LIKE ${`%${formUploadKeySegment(baseId, formId)}%`}`,
          ),
        );
      return row?.count ?? 0;
    },

    /**
     * Upkeep: expire form uploads nobody submitted — `pending` tables-scope rows
     * under a form key segment, created before `before`. Returns them so the
     * caller removes the stored objects.
     */
    async expireStaleFormUploads(before: string, limit = 200): Promise<ExpiredFormUpload[]> {
      const stale = db
        .select({ id: driveFiles.id })
        .from(driveFiles)
        .where(
          and(
            eq(driveFiles.scope, 'tables'),
            eq(driveFiles.status, 'pending'),
            lt(driveFiles.created_at, before),
            sql`${driveFiles.cos_key} LIKE '%tables/' || ${driveFiles.base_id} || '/forms/%'`,
          ),
        )
        .limit(limit);
      return db
        .update(driveFiles)
        .set({ status: 'deleted', updated_at: nowIso() })
        .where(and(inArray(driveFiles.id, stale), eq(driveFiles.status, 'pending')))
        .returning({ id: driveFiles.id, cos_key: driveFiles.cos_key });
    },
  };

  return service;
}
