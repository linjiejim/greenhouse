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

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  // Generated exports (see tools/files/export-table.ts).
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Derive a Content-Type from a file id's extension (octet-stream fallback). */
export function contentTypeForId(id: string): string {
  return MIME_BY_EXT[extname(id).toLowerCase()] || 'application/octet-stream';
}

/** Extensions viewed inline in the browser (images, pdf); everything else downloads. */
const INLINE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf']);

/** Whether an object should render inline vs. download as an attachment. */
export function isInlineId(id: string): boolean {
  return INLINE_EXTS.has(extname(id).toLowerCase());
}

// ─── Expiring ids ────────────────────────────────────────
//
// Generated exports carry their own expiry IN the id: `exp_<epochSec>_<uuid>.<ext>`.
// This keeps expiry enforcement STATELESS (no metadata store) and identical across
// the local-disk default and any object-storage driver — the GET route parses the
// id and refuses (410) once past the deadline. Tamper-proof by construction:
// editing the epoch yields a different id that points at a file which doesn't exist.

const EXPIRING_RE = /^exp_(\d+)_[0-9a-f]{8}\.[a-z0-9]+$/i;

/** Mint an id encoding an absolute expiry (now + ttlMs). */
export function makeExpiringId(ext: string, ttlMs: number, now: number = Date.now()): string {
  const clean = ext.replace(/^\./, '').toLowerCase();
  const expSec = Math.floor((now + ttlMs) / 1000);
  return `exp_${expSec}_${randomUUID().slice(0, 8)}.${clean}`;
}

/** Absolute expiry (ms) encoded in an id, or null when the id has no expiry. */
export function expiryOf(id: string): number | null {
  const m = EXPIRING_RE.exec(id);
  return m ? Number(m[1]) * 1000 : null;
}

/** True if `id` is an expiring id whose deadline has passed. */
export function isExpired(id: string, now: number = Date.now()): boolean {
  const exp = expiryOf(id);
  return exp !== null && now > exp;
}

function ensureLocalDir(): void {
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ─── Local disk backend ──────────────────────────────────
//
// The default when no driver is registered. Exported so the optional local
// object-storage driver (storage/local-driver.ts) can reuse the EXACT same disk
// I/O behind the StorageDriver interface — the difference there is only that it
// also implements presignGet.

/** Write an object to local disk (creating the dir on first use). */
export function writeLocal(id: string, buffer: Buffer): void {
  ensureLocalDir();
  writeFileSync(resolve(UPLOADS_DIR, id), buffer);
}

/** Read an object from local disk, or null if it does not exist. */
export function readLocal(id: string): StoredObject | null {
  const filePath = resolve(UPLOADS_DIR, id);
  if (!existsSync(filePath)) return null;
  return { buffer: readFileSync(filePath), contentType: contentTypeForId(id) };
}

/** Delete an object from local disk (no-op if absent). */
export function deleteLocal(id: string): void {
  const filePath = resolve(UPLOADS_DIR, id);
  if (existsSync(filePath)) unlinkSync(filePath);
}

/** Persist an object — via the registered storage driver if any, else local disk. */
export async function putUpload(id: string, buffer: Buffer, contentType: string): Promise<void> {
  const driver = getStorageDriver();
  if (driver) return driver.put(id, buffer, contentType);
  writeLocal(id, buffer);
}

/** Fetch an object, or null if it does not exist. */
export async function getUpload(id: string): Promise<StoredObject | null> {
  const driver = getStorageDriver();
  if (driver) return driver.get(id);
  return readLocal(id);
}

/** Delete an object (no-op if absent). */
export async function deleteUpload(id: string): Promise<void> {
  const driver = getStorageDriver();
  if (driver) return driver.delete(id);
  deleteLocal(id);
}

/** A presigned URL for direct client access, when the driver supports it (else null). */
export async function presignUpload(id: string): Promise<string | null> {
  const driver = getStorageDriver();
  return (await driver?.presignGet?.(id)) ?? null;
}

/**
 * Delete every expired export (`exp_<epoch>_…`) under `dir`; returns the count removed.
 *
 * The GET route enforces expiry on access and lazily reaps the file it serves
 * (routes/upload.ts), but an export minted and never re-fetched would otherwise
 * linger on local disk forever — a slow leak. A periodic + startup sweep (see
 * scheduler/uploads-sweep-job.ts) reclaims those up front.
 *
 * No-op when a storage driver is registered: the object store owns its own
 * lifecycle cleanup (bucket expiry rules) then. `isExpired` is true ONLY for
 * expiring ids past their deadline, so image / gen-* uploads (no encoded expiry)
 * are never touched. `dir` is a test seam — production sweeps UPLOADS_DIR.
 */
export function sweepExpiredUploads(dir: string = UPLOADS_DIR, now: number = Date.now()): number {
  if (getStorageDriver()) return 0;
  if (!existsSync(dir)) return 0;
  let deleted = 0;
  for (const name of readdirSync(dir)) {
    if (!isExpired(name, now)) continue;
    try {
      unlinkSync(resolve(dir, name));
      deleted++;
    } catch {
      // Raced with the GET route's lazy reap or a manual delete — already gone.
    }
  }
  return deleted;
}
