/**
 * Local object-storage driver — a disk-backed StorageDriver that ALSO implements
 * presignGet, so the full object-storage code path (driver routing + presigned
 * direct links + the export_table large-file branch) can be exercised locally
 * WITHOUT wiring a real S3/COS backend.
 *
 * Opt-in for verification: `maybeRegisterLocalStorageDriver()` (called from
 * index.ts after the fork hook) registers it only when `STORAGE_DRIVER=local` and
 * no real driver was already registered by a fork. Upstream default (no env) is
 * unchanged — the driver-less local-disk fallback in uploads.ts.
 */

import { logger } from '@greenhouse/utils/logger';
import type { StorageDriver } from './extensions.js';
import { registerStorageDriver, getStorageDriver } from './extensions.js';
import { writeLocal, readLocal, deleteLocal, expiryOf } from './uploads.js';
import { signObjectPath } from './presign.js';

/** Presigned-link lifetime for objects that carry no expiry of their own (e.g. images). */
const DEFAULT_PRESIGN_TTL_MS = 15 * 60 * 1000; // 15 min

/**
 * A StorageDriver backed by the same local disk as the default, plus presignGet.
 * put/get/delete are identical to the driver-less fallback; the only new capability
 * is minting a signed, expiring URL served by `GET /api/upload/signed/:id`.
 */
export function createLocalStorageDriver(): StorageDriver {
  return {
    put: async (id, buffer) => writeLocal(id, buffer),
    get: async (id) => readLocal(id),
    delete: async (id) => deleteLocal(id),
    presignGet: async (id) => {
      // Match the link's deadline to the object's own encoded expiry when it has
      // one (export files do); otherwise a short default TTL — like an S3 presign.
      const own = expiryOf(id);
      const expMs = own ?? Date.now() + DEFAULT_PRESIGN_TTL_MS;
      return signObjectPath(id, Math.floor(expMs / 1000));
    },
  };
}

/**
 * Register the local object-storage driver for verification when `STORAGE_DRIVER=local`.
 * No-op when the env isn't set, or when a fork already registered a real driver
 * (that always wins — this is only a local stand-in).
 */
export function maybeRegisterLocalStorageDriver(): void {
  if ((process.env.STORAGE_DRIVER || '').toLowerCase() !== 'local') return;
  if (getStorageDriver()) {
    logger.warn('[Storage] STORAGE_DRIVER=local ignored — a storage driver is already registered.');
    return;
  }
  registerStorageDriver(createLocalStorageDriver());
  logger.info('[Storage] 🗄️ Local object-storage driver active — presigned URLs enabled (disk-backed).');
}
