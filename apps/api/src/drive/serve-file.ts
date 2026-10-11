/**
 * Serve a Drive file's bytes to a caller whose access was already checked —
 * one implementation for every download route (`/api/drive/files/:id/content`,
 * the apps gateway's `/api/apps/:id/files/:fileId`).
 *
 * Never cacheable (authed bytes, and the presigned redirect would replay one
 * person's download to the next on a shared browser); COS answers with a
 * 120-second presigned URL, local storage streams the bytes behind auth as a
 * forced attachment with a sniff-proof content type derived from the name.
 */

import type { Context } from 'hono';
import type { DriveFileRow } from '@greenhouse/db';
import { contentDisposition } from '../http/content-disposition.js';
import { getObjectAtKey, presignGetUrl } from '../storage/uploads.js';
import { safeDriveContentType } from './upload-policy.js';

export async function serveDriveFileContent(c: Context, file: Pick<DriveFileRow, 'name' | 'cos_key'>) {
  c.header('Cache-Control', 'no-store');
  const contentType = safeDriveContentType(file.name);
  const signed = await presignGetUrl(file.cos_key, 120, { filename: file.name, contentType });
  if (signed) return c.redirect(signed, 302);

  const obj = await getObjectAtKey(file.cos_key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  c.header('Content-Type', contentType);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Disposition', contentDisposition(file.name));
  return c.body(Uint8Array.from(obj.buffer).buffer);
}
