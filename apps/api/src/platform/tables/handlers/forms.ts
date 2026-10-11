/**
 * Forms (spec 20261011-tables-foundation §3). Building one is builder work
 * (`listForms` / `createForm` / `updateForm`; `getForm` is the editor-side
 * read). Submitting is `openForm` / `submitForm` behind `/api/forms`: who may
 * is the form's audience (`../form-access.ts`), not Base membership, and the
 * response never carries Base data — the submit view, then only the success
 * copy.
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import { parseTableFieldConfig, type TableFieldRow, type TableFormRow } from '@greenhouse/db';
import type { TableFormConfig, TableFormSubmitView, TableRecordValues } from '@greenhouse/types/tables';
import { isUniqueViolation } from '@greenhouse/utils/error';
import { baseForForm, baseForTable, requireBase, requireTableData } from '../access.js';
import { grantableFormAudience, resolveFormSubmitter, type FormSubmitterGate } from '../form-access.js';
import { publishRecordsChanged } from '../realtime.js';
import {
  fail,
  objectValue,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  writeMeta,
  type Handler,
  type TablesHandlers,
} from './shared.js';
import type { PlatformHandlerContext } from '../../runtime.js';

const listForms: Handler = async (request, context) => {
  const tableId = positiveInt(payloadOf(request), 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'form', 'builder'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  return ok({ forms: await context.db.tables.listForms(tableId) });
};

/**
 * The form row as a custom role receives it: shown fields cut to what it can
 * edit, prefilled values kept only on fields it can read, and no audience (who
 * may submit is the builders' business).
 */
function formForCustomRole(
  form: TableFormRow,
  writable: ReadonlySet<number>,
  readable: ReadonlySet<number>,
): Omit<TableFormRow, 'audience'> {
  const { audience: _audience, ...rest } = form;
  const { defaults, ...config } = form.config;
  const kept = (defaults ?? []).filter((entry) => readable.has(entry.fieldId));
  return {
    ...rest,
    config: {
      ...config,
      fieldIds: form.config.fieldIds.filter((id) => writable.has(id)),
      ...(kept.length > 0 ? { defaults: kept } : {}),
    },
  };
}

const getForm: Handler = async (request, context) => {
  const formId = positiveInt(payloadOf(request), 'formId');
  if (!formId) return fail('INVALID_INPUT', 'formId is required');
  const form = await context.db.tables.getForm(formId);
  const base = await baseForForm(context.db, formId);
  if (!form || !base) return fail('NOT_FOUND', 'Form not found');
  // Built-in editors and up; a custom role only when it may create on the
  // form's table, and then it gets the form cut to its access (slice A).
  const grant = await requireBase(context, request.actor, base.id, 'form', 'viewer', { allowCustom: true });
  if (!grant) return fail('NOT_FOUND', 'Form not found');
  let custom: { writable: ReadonlySet<number>; readable: ReadonlySet<number> } | null = null;
  if (grant.access.level === 'custom') {
    const data = await requireTableData(request, context, form.table_id, 'create');
    if (!data || data.scope.kind !== 'scoped') return fail('NOT_FOUND', 'Form not found');
    custom = { writable: new Set(data.scope.editableFieldIds), readable: new Set(data.scope.readableFieldIds) };
  } else if (!(await requireBase(context, request.actor, base.id, 'form', 'editor'))) {
    return fail('NOT_FOUND', 'Form not found');
  }
  const schema = await context.db.tables.getSchema(form.table_id, effectiveUserId(request.actor));
  if (!schema) return fail('NOT_FOUND', 'Form table not found');
  return ok({
    form: custom ? formForCustomRole(form, custom.writable, custom.readable) : form,
    fields: schema.fields.filter(
      (field) => form.config.fieldIds.includes(field.id) && (!custom || custom.writable.has(field.id)),
    ),
  });
};

const GROUP_NOT_FOUND = () => fail('NOT_FOUND', 'Group not found', { reason: 'group_not_found' });

const createForm: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const name = stringValue(payload, 'name');
  const config = objectValue<TableFormConfig>(payload, 'config');
  if (!tableId || !name || !config) return fail('INVALID_INPUT', 'tableId, name, and config are required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'form', 'builder'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const audience = await grantableFormAudience(context, request.actor, payload.audience);
  if (!audience.ok) return GROUP_NOT_FOUND();
  const form = await context.db.tables.createForm({
    table_id: tableId,
    name,
    status: payload.status === 'published' ? 'published' : 'draft',
    config,
    audience: audience.audience,
    user_id: effectiveUserId(request.actor),
  });
  return ok({ form });
};

const updateForm: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const formId = positiveInt(payload, 'formId');
  const revision = positiveInt(payload, 'revision');
  if (!formId || !revision) return fail('INVALID_INPUT', 'formId and revision are required');
  const form = await context.db.tables.getForm(formId);
  const base = await baseForForm(context.db, formId);
  if (!form || !base || !(await requireBase(context, request.actor, base.id, 'form', 'builder'))) {
    return fail('NOT_FOUND', 'Form not found');
  }
  const audience = await grantableFormAudience(context, request.actor, payload.audience, form.audience);
  if (!audience.ok) return GROUP_NOT_FOUND();
  const result = await context.db.tables.updateForm(formId, {
    revision,
    name: stringValue(payload, 'name'),
    status: payload.status === 'draft' || payload.status === 'published' ? payload.status : undefined,
    config: objectValue<TableFormConfig>(payload, 'config'),
    audience: audience.audience,
    user_id: effectiveUserId(request.actor),
  });
  if (result.ok) return ok({ form: result.value });
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Form revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Form not found');
};

/** A refused gate: only an audience member learns that the form is a draft. */
function formGateFailure(gate: Extract<FormSubmitterGate, { ok: false }>) {
  return gate.reason === 'not_published'
    ? fail('NOT_FOUND', 'Form is not published', { reason: 'not_published' })
    : fail('NOT_FOUND', 'Form not found');
}

const ALREADY_SUBMITTED = () => fail('CONFLICT', 'already_submitted', { reason: 'already_submitted' });

function submitField(field: TableFieldRow): TableFormSubmitView['fields'][number] {
  const config = parseTableFieldConfig(field);
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    required: field.required,
    ...(field.type === 'single_select' || field.type === 'multi_select' ? { options: config.options ?? [] } : {}),
    ...(field.type === 'relation' ? { multiple: config.relation?.multiple === true } : {}),
  };
}

async function submitView(
  context: PlatformHandlerContext,
  form: TableFormRow,
  userId: string,
  editableFieldIds: readonly number[],
): Promise<TableFormSubmitView> {
  const fields = (await context.db.tables.listFormFields(form)).filter((field) => editableFieldIds.includes(field.id));
  const allowMultiple = form.config.allowMultiple !== false;
  const hasUserField = fields.some((field) => field.type === 'user' || field.type === 'multi_user');
  const userOptions = hasUserField
    ? (await context.db.users.list())
        .filter((user) => user.status === 'active' && (user.role === 'team' || user.role === 'super'))
        .map((user) => ({ id: user.id, name: user.nickname, email: user.email }))
    : undefined;
  return {
    id: form.id,
    name: form.name,
    title: form.config.title || form.name,
    description: form.config.description || null,
    submitLabel: form.config.submitLabel || null,
    successMessage: form.config.successMessage || null,
    fields: fields.map(submitField),
    ...(userOptions ? { userOptions } : {}),
    alreadySubmitted: !allowMultiple && (await context.db.tables.hasSubmittedForm(form.id, userId)),
    allowMultiple,
  };
}

/** The submit view of a form for someone in its audience (no Base data, no hidden defaults). */
const openForm: Handler = async (request, context) => {
  const formId = positiveInt(payloadOf(request), 'formId');
  if (!formId) return fail('INVALID_INPUT', 'formId is required');
  const gate = await resolveFormSubmitter(context, request.actor, formId);
  if (!gate.ok) return formGateFailure(gate);
  return ok({ form: await submitView(context, gate.form, gate.userId, gate.scope.editableFieldIds) });
};

/**
 * Submit as the signed-in person. The record is written with the form's scope
 * (`actorKind: 'form'`, `source.formId`, automations enqueued) and never
 * returned — the submitter may not be able to read the table at all.
 */
const submitForm: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const formId = positiveInt(payload, 'formId');
  const values = objectValue<TableRecordValues>(payload, 'values');
  if (!formId || !values) return fail('INVALID_INPUT', 'formId and values are required');
  const gate = await resolveFormSubmitter(context, request.actor, formId);
  if (!gate.ok) return formGateFailure(gate);
  const { form, base, userId, scope } = gate;
  if (form.config.allowMultiple === false && (await context.db.tables.hasSubmittedForm(form.id, userId))) {
    return ALREADY_SUBMITTED();
  }
  let record: Awaited<ReturnType<typeof context.db.tables.submitForm>>;
  try {
    record = await context.db.tables.submitForm(
      form.id,
      values,
      scope,
      writeMeta(request.actor, { actorKind: 'form', source: { formId: form.id } }),
      { evaluation: { timeZone: stringValue(payload, 'timeZone') } },
    );
  } catch (error) {
    // The single-submit partial unique index: the other of two concurrent submits won.
    if (isUniqueViolation(error)) return ALREADY_SUBMITTED();
    throw error;
  }
  await publishRecordsChanged(context, base, record.table_id, [record.id]);
  return ok({ successMessage: form.config.successMessage || null });
};

export const formHandlers = {
  listForms,
  getForm,
  createForm,
  updateForm,
  openForm,
  submitForm,
} satisfies TablesHandlers;
