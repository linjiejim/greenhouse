/**
 * Forms. Building one is builder work; submitting still needs Base create
 * rights until slice Fm adds audiences (`openForm`, team / principals
 * submitters, defaults, `allowMultiple`) behind `/api/forms`.
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import type { TableFormConfig, TableRecordValues } from '@greenhouse/types/tables';
import { baseForForm, baseForTable, requireBase, requireTableData } from '../access.js';
import { publishRecordsChanged } from '../realtime.js';
import {
  fail,
  notImplemented,
  objectValue,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  writeMeta,
  type Handler,
  type TablesHandlers,
} from './shared.js';

const listForms: Handler = async (request, context) => {
  const tableId = positiveInt(payloadOf(request), 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'form', 'builder'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  return ok({ forms: await context.db.tables.listForms(tableId) });
};

const getForm: Handler = async (request, context) => {
  const formId = positiveInt(payloadOf(request), 'formId');
  if (!formId) return fail('INVALID_INPUT', 'formId is required');
  const form = await context.db.tables.getForm(formId);
  const base = await baseForForm(context.db, formId);
  if (!form || !base) return fail('NOT_FOUND', 'Form not found');
  // Built-in editors and up; a custom role only when it may create on the
  // form's table, and then it gets only the form fields it can edit (slice A).
  const grant = await requireBase(context, request.actor, base.id, 'form', 'viewer', { allowCustom: true });
  if (!grant) return fail('NOT_FOUND', 'Form not found');
  let writable: Set<number> | null = null;
  if (grant.access.level === 'custom') {
    const data = await requireTableData(request, context, form.table_id, 'create');
    if (!data || data.scope.kind !== 'scoped') return fail('NOT_FOUND', 'Form not found');
    writable = new Set(data.scope.editableFieldIds);
  } else if (!(await requireBase(context, request.actor, base.id, 'form', 'editor'))) {
    return fail('NOT_FOUND', 'Form not found');
  }
  const schema = await context.db.tables.getSchema(form.table_id, effectiveUserId(request.actor));
  if (!schema) return fail('NOT_FOUND', 'Form table not found');
  return ok({
    form,
    fields: schema.fields.filter(
      (field) => form.config.fieldIds.includes(field.id) && (!writable || writable.has(field.id)),
    ),
  });
};

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
  const form = await context.db.tables.createForm({
    table_id: tableId,
    name,
    status: payload.status === 'published' ? 'published' : 'draft',
    config,
    user_id: effectiveUserId(request.actor),
  });
  return ok({ form });
};

const updateForm: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const formId = positiveInt(payload, 'formId');
  const revision = positiveInt(payload, 'revision');
  if (!formId || !revision) return fail('INVALID_INPUT', 'formId and revision are required');
  const base = await baseForForm(context.db, formId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'form', 'builder'))) {
    return fail('NOT_FOUND', 'Form not found');
  }
  const result = await context.db.tables.updateForm(formId, {
    revision,
    name: stringValue(payload, 'name'),
    status: payload.status === 'draft' || payload.status === 'published' ? payload.status : undefined,
    config: objectValue<TableFormConfig>(payload, 'config'),
    user_id: effectiveUserId(request.actor),
  });
  if (result.ok) return ok({ form: result.value });
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Form revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Form not found');
};

/**
 * Today: a Base member with create rights submits. Returns the record (the
 * `/api/tables` route) and the form's success copy (the `/api/forms` route,
 * which never echoes record data).
 */
const submitForm: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const formId = positiveInt(payload, 'formId');
  const values = objectValue<TableRecordValues>(payload, 'values');
  if (!formId || !values) return fail('INVALID_INPUT', 'formId and values are required');
  const form = await context.db.tables.getForm(formId);
  const data = form ? await requireTableData(request, context, form.table_id, 'create') : undefined;
  if (!form || !data) return fail('NOT_FOUND', 'Form not found');
  const record = await context.db.tables.submitForm(
    formId,
    values,
    data.scope,
    writeMeta(request.actor, { actorKind: 'form', source: { formId } }),
  );
  await publishRecordsChanged(context, data.base, record.table_id, [record.id]);
  return ok({ record: data.project(record), successMessage: form.config.successMessage ?? null });
};

export const formHandlers = {
  listForms,
  getForm,
  createForm,
  updateForm,
  submitForm,
  // Slice Fm.
  openForm: notImplemented,
} satisfies TablesHandlers;
