/**
 * Upload storage abstraction — local disk (data/uploads).
 *
 * All upload/generated images flow through here so the rest of the app never
 * touches the filesystem directly. Callers work with a bare `id`
 * (e.g. `1715-abcd.jpg`); the file lives at `${UPLOADS_DIR}/${id}`.
 *
 * This single-backend implementation is fine for single-instance deploys. For
 * multi-instance / horizontally-scaled deploys you'd put an object-storage
 * backend behind this same put/get/delete interface.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { UPLOADS_DIR } from '../paths.js';
import { getStorageDriver } from './extensions.js';

export interface StoredObject {
  buffer: Buffer;
  contentType: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Derive a Content-Type from a file id's extension (octet-stream fallback). */
export function contentTypeForId(id: string): string {
  return MIME_BY_EXT[extname(id).toLowerCase()] || 'application/octet-stream';
}

function ensureLocalDir(): void {
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
}

/** Persist an object — via the registered storage driver if any, else local disk. */
export async function putUpload(id: string, buffer: Buffer, contentType: string): Promise<void> {
  const driver = getStorageDriver();
  if (driver) return driver.put(id, buffer, contentType);
  ensureLocalDir();
  writeFileSync(resolve(UPLOADS_DIR, id), buffer);
}

/** Fetch an object, or null if it does not exist. */
export async function getUpload(id: string): Promise<StoredObject | null> {
  const driver = getStorageDriver();
  if (driver) return driver.get(id);
  const filePath = resolve(UPLOADS_DIR, id);
  if (!existsSync(filePath)) return null;
  return { buffer: readFileSync(filePath), contentType: contentTypeForId(id) };
}

/** Delete an object (no-op if absent). */
export async function deleteUpload(id: string): Promise<void> {
  const driver = getStorageDriver();
  if (driver) return driver.delete(id);
  const filePath = resolve(UPLOADS_DIR, id);
  if (existsSync(filePath)) unlinkSync(filePath);
}

/** A presigned URL for direct client access, when the driver supports it (else null). */
export async function presignUpload(id: string): Promise<string | null> {
  const driver = getStorageDriver();
  return (await driver?.presignGet?.(id)) ?? null;
}
