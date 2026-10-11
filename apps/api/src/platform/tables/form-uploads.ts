/**
 * Attachments on submit-only forms (spec 20261011-tables-foundation §3).
 *
 * A form's audience usually cannot browse the Base's Drive, so they upload
 * through the form: `POST /api/forms/:id/uploads` stores the bytes in the Base's
 * tables scope as a `pending` drive row (never listed or served), uploaded by
 * the submitter, under the form's key segment (`driveKeyFor({formId})` ↔ the
 * db's `formUploadKeySegment`). `submitForm` binds only those — this person's,
 * this form's, still pending — and flips them to active in the same request.
 * Uploads nobody submits are expired by `sweepStaleFormUploads` (upkeep, hourly)
 * after `FORM_UPLOAD_TTL_MS`.
 *
 * Same policy as Drive: `validateDriveUpload` (size cap `MAX_DRIVE_FILE_SIZE`,
 * no executables / active content) and response metadata derived from the
 * validated name only.
 */

import type { ActorContext } from '@greenhouse/platform-kernel';
import type { DatabaseProvider } from '@greenhouse/db';
import type { TableFormUploadView } from '@greenhouse/types/tables';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeDriveContentType, validateDriveUpload } from '../../drive/upload-policy.js';
import { deleteObjectAtKey, driveKeyFor, putObjectAtKey } from '../../storage/uploads.js';
import { getPlatformRuntime } from '../runtime.js';
import { resolveFormSubmitter } from './form-access.js';

/** Unsubmitted uploads live this long. */
export const FORM_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** Staged, unsubmitted files one person may hold on one form. */
export const MAX_PENDING_FORM_UPLOADS = 20;

export type StageFormUploadResult =
  | { ok: true; file: TableFormUploadView }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 429;
      error: string;
      reason?: 'not_published' | 'already_submitted' | 'no_attachment_field' | 'too_many_uploads';
    };

export async function stageFormUpload(
  ctx: { db: DatabaseProvider },
  actor: ActorContext,
  formId: number,
  file: File,
): Promise<StageFormUploadResult> {
  // The capability dispatch would check for openForm / submitForm.
  if (!(await getPlatformRuntime().authorize(actor, 'tables.data.submitForm')).allowed) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const notFound = { ok: false, status: 404, error: 'Form not found' } as const;
  const gate = await resolveFormSubmitter(ctx, actor, formId);
  if (!gate.ok) {
    return gate.reason === 'not_published'
      ? { ok: false, status: 404, error: 'Form is not published', reason: 'not_published' }
      : notFound;
  }
  const { form, base, userId } = gate;
  const fields = await ctx.db.tables.listFormFields(form);
  if (!fields.some((field) => field.type === 'attachment' && gate.scope.editableFieldIds.includes(field.id))) {
    return { ok: false, status: 400, error: 'This form does not take files', reason: 'no_attachment_field' };
  }
  if (form.config.allowMultiple === false && (await ctx.db.tables.hasSubmittedForm(form.id, userId))) {
    return { ok: false, status: 409, error: 'already_submitted', reason: 'already_submitted' };
  }
  if ((await ctx.db.tables.countPendingFormUploads(form.id, base.id, userId)) >= MAX_PENDING_FORM_UPLOADS) {
    return { ok: false, status: 429, error: 'Too many files waiting to be submitted', reason: 'too_many_uploads' };
  }
  const name = file.name.trim();
  const valid = validateDriveUpload({ name, size: file.size, content_type: file.type });
  if (!valid.ok) return { ok: false, status: 400, error: valid.error };

  const contentType = safeDriveContentType(name);
  const row = await ctx.db.drive.initFile({
    scope: 'tables',
    folder_id: null,
    name,
    cos_key: driveKeyFor({ scope: 'tables', baseId: base.id, formId: form.id, filename: name }),
    content_type: contentType,
    size: file.size,
    base_id: base.id,
    owner_key: null,
    visibility: null,
    owner_user_id: null,
    uploaded_by: userId,
  });
  // Row first, bytes second: a failed write leaves a pending row the sweep
  // removes, never an object no row points at.
  await putObjectAtKey(row.cos_key, Buffer.from(await file.arrayBuffer()), contentType);
  return { ok: true, file: { id: row.id, name: row.name, size: row.size } };
}

/** Upkeep: expire unsubmitted form uploads older than the TTL and delete their objects. */
export async function sweepStaleFormUploads(db: DatabaseProvider, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - FORM_UPLOAD_TTL_MS).toISOString();
  let expired = 0;
  // Bounded batches so one sweep never holds a long transaction.
  for (let batch = 0; batch < 50; batch += 1) {
    const rows = await db.tables.expireStaleFormUploads(before);
    expired += rows.length;
    for (const row of rows) {
      await deleteObjectAtKey(row.cos_key).catch((error) =>
        logger.warn(`[TablesForms] object GC failed for ${row.cos_key}: ${toErrorMessage(error)}`),
      );
    }
    if (rows.length === 0) break;
  }
  return expired;
}
