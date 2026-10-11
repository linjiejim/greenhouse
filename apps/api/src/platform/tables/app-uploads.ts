/**
 * Attachments through an app (docs/specs/20261011-tables-apps.md §3 附件) —
 * the Phase 0 form-upload pattern, per app:
 *
 * - `POST /api/apps/:id/uploads {pageId, cardId, fieldId}` stages the bytes in
 *   the Base's tables scope as a `pending` drive row (never listed or served),
 *   uploaded by the viewer, under the app's key segment — only for a card that
 *   lets the role create or edit that attachment field (form, create spec,
 *   drawer edit, an action input, a `create_record` button), and only up to
 *   `MAX_PENDING_APP_UPLOADS` waiting files per person and app;
 * - the write that attaches them claims them first (pending → active), checks
 *   every new id is the viewer's own app upload that no other record holds
 *   (D15 for every caller, managers included), and releases the claim if the
 *   write fails;
 * - uploads nobody attached expire with the hourly form-upload sweep.
 * Same policy as Drive: `validateDriveUpload` and metadata from the validated name.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { TableFormUploadView, TableRecordValues } from '@greenhouse/types/tables';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeDriveContentType, validateDriveUpload } from '../../drive/upload-policy.js';
import { deleteObjectAtKey, driveKeyFor, putObjectAtKey } from '../../storage/uploads.js';
import type { AppSession } from './app-session.js';

/** Unattached app uploads live this long. */
export const APP_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** Staged, unattached files one person may hold in one app. */
export const MAX_PENDING_APP_UPLOADS = 20;

export type StageAppUploadResult =
  | { ok: true; file: TableFormUploadView }
  | { ok: false; status: 400 | 429; error: string; reason?: 'too_many_uploads' };

/** Store one file for a later app write (the caller has checked the card covers the field). */
export async function stageAppUpload(
  db: DatabaseProvider,
  session: AppSession,
  file: File,
): Promise<StageAppUploadResult> {
  if (
    (await db.tables.countPendingAppUploads(session.app.id, session.base.id, session.userId)) >= MAX_PENDING_APP_UPLOADS
  ) {
    return { ok: false, status: 429, error: 'Too many files waiting to be saved', reason: 'too_many_uploads' };
  }
  const name = file.name.trim();
  const valid = validateDriveUpload({ name, size: file.size, content_type: file.type });
  if (!valid.ok) return { ok: false, status: 400, error: valid.error };
  const contentType = safeDriveContentType(name);
  const row = await db.drive.initFile({
    scope: 'tables',
    folder_id: null,
    name,
    cos_key: driveKeyFor({ scope: 'tables', baseId: session.base.id, appId: session.app.id, filename: name }),
    content_type: contentType,
    size: file.size,
    base_id: session.base.id,
    owner_key: null,
    visibility: null,
    owner_user_id: null,
    uploaded_by: session.userId,
  });
  // Row first, bytes second: a failed write leaves a pending row the sweep removes.
  await putObjectAtKey(row.cos_key, Buffer.from(await file.arrayBuffer()), contentType);
  return { ok: true, file: { id: row.id, name: row.name, size: row.size } };
}

function fileIds(value: unknown): number[] | undefined {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'number' && Number.isInteger(id) && id > 0)) {
    return undefined;
  }
  return value as number[];
}

export type ClaimAttachmentsResult = { ok: true; claimed: number[] } | { ok: false; error: string };

/**
 * Before an app write: the attachment ids it adds (not already on the record's
 * field) must be the viewer's own uploads through this app, held by no other
 * record. Claims the pending ones; on refusal nothing stays claimed.
 */
export async function claimAppAttachments(
  db: DatabaseProvider,
  session: AppSession,
  input: {
    attachmentFieldIds: ReadonlySet<number>;
    values: TableRecordValues;
    current: TableRecordValues | null;
    recordId: number | null;
  },
): Promise<ClaimAttachmentsResult> {
  const added: number[] = [];
  for (const [key, value] of Object.entries(input.values)) {
    if (!input.attachmentFieldIds.has(Number(key))) continue;
    const ids = fileIds(value);
    if (!ids) return { ok: false, error: 'Attachments must be uploaded files' };
    const before = new Set(fileIds(input.current?.[key]) ?? []);
    added.push(...ids.filter((id) => !before.has(id)));
  }
  if (added.length === 0) return { ok: true, claimed: [] };
  const target = { appId: session.app.id, baseId: session.base.id, userId: session.userId };
  const claimed = await db.tables.claimAppUploads({ ...target, fileIds: added });
  if (!(await db.tables.appUploadsAttachable({ ...target, fileIds: added, recordId: input.recordId }))) {
    await db.tables.releaseAppUploads(claimed);
    return { ok: false, error: 'An attachment is not available — upload it again' };
  }
  return { ok: true, claimed };
}

/** Upkeep: expire app uploads nobody attached and delete their objects. */
export async function sweepStaleAppUploads(db: DatabaseProvider, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - APP_UPLOAD_TTL_MS).toISOString();
  let expired = 0;
  for (let batch = 0; batch < 50; batch += 1) {
    const rows = await db.tables.expireStaleAppUploads(before);
    expired += rows.length;
    for (const row of rows) {
      await deleteObjectAtKey(row.cos_key).catch((error) =>
        logger.warn(`[TablesApps] object GC failed for ${row.cos_key}: ${toErrorMessage(error)}`),
      );
    }
    if (rows.length === 0) break;
  }
  return expired;
}
