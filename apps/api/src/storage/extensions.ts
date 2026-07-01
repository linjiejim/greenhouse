/**
 * Fork extension point for the upload storage backend.
 *
 * Upstream stores uploads on local disk (see uploads.ts). A downstream fork that
 * needs object storage (S3 / Tencent COS / …) registers a driver at startup via
 * registerStorageDriver() — from bootstrap.extensions.ts — WITHOUT editing
 * uploads.ts. When a driver is registered, put/get/delete route through it;
 * otherwise the local-disk default applies. No driver upstream.
 *
 * Fork example (called from bootstrapForkExtensions()):
 *   registerStorageDriver({
 *     put: (id, buf, ct) => cos.putObject(id, buf, ct),
 *     get: (id) => cos.getObject(id),
 *     delete: (id) => cos.deleteObject(id),
 *     presignGet: (id) => cos.getPresignedUrl(id),
 *   });
 */

import type { StoredObject } from './uploads.js';

export interface StorageDriver {
  put(id: string, buffer: Buffer, contentType: string): Promise<void>;
  get(id: string): Promise<StoredObject | null>;
  delete(id: string): Promise<void>;
  /** Optional: a presigned URL for direct client access (object stores). */
  presignGet?(id: string): Promise<string | null>;
}

let driver: StorageDriver | null = null;

/** Register the storage backend (call once at startup). Replaces the local default. */
export function registerStorageDriver(d: StorageDriver): void {
  driver = d;
}

export function getStorageDriver(): StorageDriver | null {
  return driver;
}
