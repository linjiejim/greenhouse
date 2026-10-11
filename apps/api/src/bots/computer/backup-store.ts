/**
 * Where Bot computer backups are kept — the deployment's own storage, never the
 * computer's provider (backups.ts):
 *
 * - local: a directory (BOTS_COMPUTER_BACKUP_DIR), e.g. data/bot-backups on the API's volume.
 * - s3: an S3-compatible bucket (BOTS_COMPUTER_BACKUP_S3_*: AWS, R2, MinIO, Tencent COS, …),
 *   written as a multipart upload of 16 MiB parts and read back as a stream.
 *
 * Objects arrive already encrypted (backup-format.ts): a store never sees a member's
 * files. Keys are `<user id>/<backup id>/<agent|browser>`. A write either stores the
 * whole object or leaves nothing behind (a temp file renamed into place; an aborted
 * multipart upload).
 */

import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createS3Client, type S3LiteClient } from '../../storage/s3-lite.js';
import { isVaultAvailable } from '../vault/crypto.js';

export interface BackupStore {
  readonly kind: 'local' | 's3';
  /** Where, for the admin page (never a secret). */
  readonly where: string;
  /** Store a whole object from a stream; resolves with its size once stored. */
  write(key: string, body: Readable): Promise<number>;
  /** The object as a stream; BackupStoreError('missing') when there is none. */
  read(key: string): Promise<Readable>;
  /** Idempotent. */
  remove(key: string): Promise<void>;
}

export class BackupStoreError extends Error {
  constructor(
    readonly code: 'missing' | 'invalid_key',
    message: string,
  ) {
    super(message);
    this.name = 'BackupStoreError';
  }
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.length > 300) throw new BackupStoreError('invalid_key', `Bad backup key: ${key}`);
}

/**
 * Hold on to an error the body emits while a write is still getting ready (a folder, an
 * upload id): unheard, it would be an unhandled 'error' event — a crashed API process.
 */
function holdEarlyError(body: Readable): () => void {
  let early: Error | null = null;
  const hold = (err: Error) => {
    early = err;
  };
  body.once('error', hold);
  return () => {
    body.off('error', hold);
    if (early) throw early;
  };
}

// ─── Local directory ──────────────────────────────────────

export function createLocalBackupStore(root: string): BackupStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    assertKey(key);
    return join(base, key);
  };
  return {
    kind: 'local',
    where: base,

    async write(key, body) {
      const ready = holdEarlyError(body);
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      ready();
      const partial = `${path}.partial-${randomBytes(4).toString('hex')}`;
      try {
        // `flush`: fsync before close — a backup that says it is complete is on disk.
        await pipeline(body, createWriteStream(partial, { mode: 0o600, flush: true }));
        await rename(partial, path);
      } catch (err) {
        await unlink(partial).catch(() => {});
        throw err;
      }
      return (await stat(path)).size;
    },

    async read(key) {
      const path = pathOf(key);
      try {
        await stat(path);
      } catch {
        throw new BackupStoreError('missing', `No backup object ${key}`);
      }
      return createReadStream(path);
    },

    async remove(key) {
      const path = pathOf(key);
      await unlink(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
      // Tidy the backup's and the member's now-empty folders (rmdir refuses non-empty ones).
      for (let dir = dirname(path); dir.startsWith(`${base}/`); dir = dirname(dir)) {
        if (
          !(await rmdir(dir)
            .then(() => true)
            .catch(() => false))
        )
          break;
      }
    },
  };
}

// ─── S3-compatible bucket ─────────────────────────────────

/** Every part but the last (S3: 5 MiB at least, 10,000 parts at most — 160 GiB). */
export const S3_PART_BYTES = 16 * 1024 * 1024;
const PART_ATTEMPTS = 3;

/** A stream cut into `size`-byte buffers (the last one shorter), read only as fast as they are used. */
async function* parts(body: Readable, size: number): AsyncGenerator<Buffer> {
  let chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of body) {
    let data = chunk as Buffer;
    while (length + data.length >= size) {
      const need = size - length;
      chunks.push(data.subarray(0, need));
      yield Buffer.concat(chunks, size);
      chunks = [];
      length = 0;
      data = data.subarray(need);
    }
    if (data.length > 0) {
      chunks.push(data);
      length += data.length;
    }
  }
  if (length > 0) yield Buffer.concat(chunks, length);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= PART_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

export function createS3BackupStore(client: S3LiteClient, opts: { prefix: string; where: string }): BackupStore {
  const objectKey = (key: string) => {
    assertKey(key);
    return `${opts.prefix}${key}`;
  };
  return {
    kind: 's3',
    where: opts.where,

    async write(key, body) {
      const ready = holdEarlyError(body);
      const name = objectKey(key);
      const uploadId = await client.createMultipartUpload(name, 'application/octet-stream');
      const uploaded: Array<{ partNumber: number; etag: string }> = [];
      let total = 0;
      try {
        ready();
        for await (const part of parts(body, S3_PART_BYTES)) {
          const partNumber = uploaded.length + 1;
          uploaded.push({
            partNumber,
            etag: await withRetry(() => client.uploadPart(name, uploadId, partNumber, part)),
          });
          total += part.length;
        }
        // An empty object is still one (empty) part.
        if (uploaded.length === 0) {
          uploaded.push({ partNumber: 1, etag: await client.uploadPart(name, uploadId, 1, Buffer.alloc(0)) });
        }
        await withRetry(() => client.completeMultipartUpload(name, uploadId, uploaded));
        return total;
      } catch (err) {
        body.destroy();
        await client.abortMultipartUpload(name, uploadId).catch(() => {});
        throw err;
      }
    },

    async read(key) {
      const stream = await client.getObjectStream(objectKey(key));
      if (!stream) throw new BackupStoreError('missing', `No backup object ${key}`);
      return stream;
    },

    async remove(key) {
      await client.deleteObject(objectKey(key));
    },
  };
}

// ─── Configuration ────────────────────────────────────────

export const BACKUP_HOURS_RANGE = { min: 1, max: 168, fallback: 24 } as const;
export const BACKUP_KEEP_RANGE = { min: 1, max: 10, fallback: 2 } as const;

export interface BackupSettings {
  /** null = backups off (not configured, or `problem`). */
  store: BackupStore | null;
  /** A computer is backed up at most this often (as it goes to sleep). */
  hours: number;
  /** Complete backups kept per member. */
  keep: number;
  /** Why backups are off although configured (shown on the admin page). */
  problem: string | null;
}

const S3_REQUIRED = [
  'BOTS_COMPUTER_BACKUP_S3_ENDPOINT',
  'BOTS_COMPUTER_BACKUP_S3_BUCKET',
  'BOTS_COMPUTER_BACKUP_S3_ACCESS_KEY_ID',
  'BOTS_COMPUTER_BACKUP_S3_SECRET_ACCESS_KEY',
] as const;

function wholeNumber(raw: string | undefined, range: { min: number; max: number; fallback: number }): number | null {
  const value = raw?.trim();
  if (!value) return range.fallback;
  const n = Number(value);
  return /^\d+$/.test(value) && n >= range.min && n <= range.max ? n : null;
}

/** BOTS_COMPUTER_BACKUP_*: off unless a directory or a bucket is set; never throws (a bad value turns backups off with a `problem`). */
export function loadBackupSettings(env: NodeJS.ProcessEnv = process.env): BackupSettings {
  const hours = wholeNumber(env.BOTS_COMPUTER_BACKUP_HOURS, BACKUP_HOURS_RANGE);
  const keep = wholeNumber(env.BOTS_COMPUTER_BACKUP_KEEP, BACKUP_KEEP_RANGE);
  const off = (problem: string | null): BackupSettings => ({
    store: null,
    hours: hours ?? BACKUP_HOURS_RANGE.fallback,
    keep: keep ?? BACKUP_KEEP_RANGE.fallback,
    problem,
  });
  const s3Set = S3_REQUIRED.filter((name) => env[name]?.trim());
  const dir = env.BOTS_COMPUTER_BACKUP_DIR?.trim();
  if (s3Set.length === 0 && !dir) return off(null);
  if (hours === null) {
    return off(
      `BOTS_COMPUTER_BACKUP_HOURS must be a whole number from ${BACKUP_HOURS_RANGE.min} to ${BACKUP_HOURS_RANGE.max}`,
    );
  }
  if (keep === null) {
    return off(
      `BOTS_COMPUTER_BACKUP_KEEP must be a whole number from ${BACKUP_KEEP_RANGE.min} to ${BACKUP_KEEP_RANGE.max}`,
    );
  }
  if (!isVaultAvailable()) {
    return off(
      "Backups need VAULT_ENCRYPTION_KEY (or PROVIDER_TOKEN_ENCRYPTION_KEY): each backup's own key is sealed with it",
    );
  }
  if (s3Set.length > 0) {
    const missing = S3_REQUIRED.filter((name) => !env[name]?.trim());
    if (missing.length > 0)
      return off(`Partial BOTS_COMPUTER_BACKUP_S3_* configuration — missing ${missing.join(', ')}`);
    const rawPrefix = env.BOTS_COMPUTER_BACKUP_S3_PREFIX?.trim() || 'bot-backups/';
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/.test(rawPrefix) || rawPrefix.split('/').some((s) => s === '..')) {
      return off('BOTS_COMPUTER_BACKUP_S3_PREFIX must look like bot-backups/');
    }
    const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
    const bucket = env.BOTS_COMPUTER_BACKUP_S3_BUCKET!.trim();
    let client: S3LiteClient;
    try {
      client = createS3Client({
        endpoint: env.BOTS_COMPUTER_BACKUP_S3_ENDPOINT!.trim(),
        region: env.BOTS_COMPUTER_BACKUP_S3_REGION?.trim() || 'us-east-1',
        bucket,
        accessKeyId: env.BOTS_COMPUTER_BACKUP_S3_ACCESS_KEY_ID!.trim(),
        secretAccessKey: env.BOTS_COMPUTER_BACKUP_S3_SECRET_ACCESS_KEY!.trim(),
        forcePathStyle: env.BOTS_COMPUTER_BACKUP_S3_FORCE_PATH_STYLE?.trim().toLowerCase() !== 'false',
      });
    } catch (err) {
      return off(`BOTS_COMPUTER_BACKUP_S3_ENDPOINT: ${(err as Error).message}`);
    }
    const host = new URL(env.BOTS_COMPUTER_BACKUP_S3_ENDPOINT!.trim()).host;
    return {
      store: createS3BackupStore(client, { prefix, where: `s3://${bucket}/${prefix} (${host})` }),
      hours: hours,
      keep: keep,
      problem: null,
    };
  }
  return { store: createLocalBackupStore(dir!), hours, keep, problem: null };
}
