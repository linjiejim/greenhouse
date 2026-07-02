/**
 * Presigned-URL signing for the local object-storage driver.
 *
 * Mimics an S3/COS presigned GET: a short-lived, HMAC-signed URL that grants
 * direct, auth-free read access to ONE object until a deadline. The local driver
 * (storage/local-driver.ts) mints these; `GET /api/upload/signed/:id` verifies +
 * serves them. Pure crypto here — no fs, no driver state.
 *
 * Secret resolution reuses the app's `TOKEN_SIGNING_KEY` so signatures survive
 * restarts and are as strong as auth tokens. A dev fallback keeps it working when
 * auth is disabled (no key set); that path logs a one-time warning.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';

const DEV_FALLBACK_SECRET = 'greenhouse-dev-presign-secret-DO-NOT-USE-IN-PROD';
let warned = false;

function secret(): string {
  const key = process.env.STORAGE_PRESIGN_SECRET || process.env.TOKEN_SIGNING_KEY;
  if (key) return key;
  if (!warned) {
    warned = true;
    logger.warn(
      '[Storage] ⚠️ Presign secret unset (STORAGE_PRESIGN_SECRET / TOKEN_SIGNING_KEY) — using an insecure dev fallback. Set one before relying on signed URLs.',
    );
  }
  return DEV_FALLBACK_SECRET;
}

function sign(id: string, expSec: number): string {
  return createHmac('sha256', `${secret()}:storage-presign`).update(`${id}:${expSec}`).digest('hex');
}

/** A signed, expiring path granting direct read access to `id` until `expSec` (unix seconds). */
export function signObjectPath(id: string, expSec: number): string {
  return `/api/upload/signed/${encodeURIComponent(id)}?exp=${expSec}&sig=${sign(id, expSec)}`;
}

/** Constant-time check that `sig` is a valid signature for (`id`, `expSec`). */
export function verifyObjectSignature(id: string, expSec: number, sig: string): boolean {
  if (!Number.isFinite(expSec) || !sig) return false;
  const expected = sign(id, expSec);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
