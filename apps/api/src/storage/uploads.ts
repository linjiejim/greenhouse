/**
 * Upload storage abstraction — Tencent Cloud COS with local-disk fallback.
 *
 * All upload/generated images flow through here so the rest of the app never
 * touches a storage backend directly. Callers work with a flat, server-issued
 * `id`; the COS object key is `${PREFIX}${id}`.
 *
 * Backend selection (decided once, lazily, at first use):
 *   - COS    — when TENCENT_CLOUD_COS_SECRET_ID/SECRET_KEY/BUCKET/REGION are all set.
 *   - local  — otherwise, writes to data/uploads (UPLOADS_DIR), for local dev.
 *
 * `getUpload` always falls back to the local disk when an object is absent from
 * COS (statusCode 404). This keeps legacy local files serveable during/after a
 * storage-backend migration.
 *
 * Config (env):
 *   TENCENT_CLOUD_COS_SECRET_ID   — CAM sub-user SecretId
 *   TENCENT_CLOUD_COS_SECRET_KEY  — CAM sub-user SecretKey
 *   TENCENT_CLOUD_COS_BUCKET      — bucket name incl. -APPID (e.g. my-bucket-1250000000)
 *   TENCENT_CLOUD_COS_REGION      — e.g. ap-guangzhou
 *   TENCENT_CLOUD_COS_PREFIX      — key prefix (default: uploads/)
 */

import COS from 'cos-nodejs-sdk-v5';
import { logger } from '@greenhouse/utils/logger';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UPLOADS_DIR } from '../paths.js';
import { validateMagicBytes } from '../security/security.js';

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

const SUPPORTED_IMAGE_TYPES = Object.keys(MIME_BY_EXT).reduce<Set<string>>((types, ext) => {
  types.add(MIME_BY_EXT[ext]);
  return types;
}, new Set());
const MAX_STORED_UPLOAD_BYTES = 25 * 1024 * 1024;

// Existing objects used an 8-hex UUID prefix and copied the original extension;
// keep those flat IDs readable because MIME is re-derived from magic bytes.
// New IDs use a full UUID and only server-selected supported extensions.
const LEGACY_UPLOAD_ID_PATTERN = /^(?:gen-)?\d{10,16}-[0-9a-f]{8}\.[a-z0-9]{1,10}$/i;
const CURRENT_UPLOAD_ID_PATTERN =
  /^(?:gen-)?\d{10,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpe?g|png|webp|gif)$/i;

/** Only server-generated, flat image IDs may cross the storage boundary. */
export function isValidUploadId(id: string): boolean {
  return id.length <= 128 && (LEGACY_UPLOAD_ID_PATTERN.test(id) || CURRENT_UPLOAD_ID_PATTERN.test(id));
}

function assertValidUploadId(id: string): void {
  if (!isValidUploadId(id)) throw new Error('Invalid upload ID');
}

function localUploadPath(id: string): string {
  assertValidUploadId(id);
  const root = resolve(UPLOADS_DIR);
  const filePath = resolve(root, id);
  if (dirname(filePath) !== root) throw new Error('Invalid upload path');
  return filePath;
}

/** Detect the supported image MIME from bytes rather than trusting metadata. */
export function detectImageContentType(buffer: Buffer): string | null {
  for (const contentType of SUPPORTED_IMAGE_TYPES) {
    if (validateMagicBytes(buffer, contentType)) return contentType;
  }
  return null;
}

function verifiedStoredObject(buffer: Buffer): StoredObject {
  if (buffer.length > MAX_STORED_UPLOAD_BYTES) {
    throw new Error(`Stored image exceeds ${MAX_STORED_UPLOAD_BYTES} bytes`);
  }
  const contentType = detectImageContentType(buffer);
  if (!contentType) throw new Error('Stored object is not a supported image');
  return { buffer, contentType };
}

/** Derive a Content-Type from a file id's extension (octet-stream fallback). */
export function contentTypeForId(id: string): string {
  return MIME_BY_EXT[extname(id).toLowerCase()] || 'application/octet-stream';
}

interface CosConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  prefix: string;
}

/**
 * Validate an object-key prefix from the environment.
 *
 * A missing trailing slash is a harmless typo, so it is normalised. Anything else
 * outside `[A-Za-z0-9._-]` and `/` is refused loudly: a `.env` line that lost its
 * newline silently glues the *next* assignment onto this value, and the result was
 * a real prefix of `uploads/TOKEN_SIGNING_KEY=<hex>` that filed every upload under a
 * junk path and printed the swallowed value into the startup log. Failing at boot
 * turns a silent six-week data-placement bug into an obvious one.
 */
export function normalizeKeyPrefix(raw: string | undefined, envVar: string, fallback: string): string {
  const value = raw?.trim();
  if (!value) return fallback;
  const segments = value.replace(/\/$/, '').split('/');
  const wellFormed =
    /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/.test(value) &&
    // `.` / `..` are legal characters but never a legal segment — a traversal in a
    // key prefix is always a mistake, and COS would happily create the literal path.
    segments.every((s) => s !== '.' && s !== '..');
  if (!wellFormed) {
    throw new Error(
      `${envVar} is not a valid object-key prefix: ${JSON.stringify(value)}. ` +
        `Expected something like "uploads/". A stray "=" or space usually means the .env line above it is missing its newline.`,
    );
  }
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Validated at module load, NOT inside getCosConfig() — the point of the guard is to
 * turn a misconfigured prefix into a startup failure. Resolving it lazily meant a bad
 * value stayed invisible until someone happened to open an image, which surfaced as a
 * mystery 500 rather than a config error, and only on the paths that touch storage.
 * Unconditional, so the mistake is caught even where COS credentials aren't set.
 */
const KEY_PREFIX = normalizeKeyPrefix(process.env.TENCENT_CLOUD_COS_PREFIX, 'TENCENT_CLOUD_COS_PREFIX', 'uploads/');

// undefined = not yet resolved, null = disabled (incomplete config)
let cachedConfig: CosConfig | null | undefined;

function getCosConfig(): CosConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const secretId = process.env.TENCENT_CLOUD_COS_SECRET_ID?.trim();
  const secretKey = process.env.TENCENT_CLOUD_COS_SECRET_KEY?.trim();
  const bucket = process.env.TENCENT_CLOUD_COS_BUCKET?.trim();
  const region = process.env.TENCENT_CLOUD_COS_REGION?.trim();
  if (!secretId || !secretKey || !bucket || !region) {
    cachedConfig = null;
    return null;
  }
  cachedConfig = { secretId, secretKey, bucket, region, prefix: KEY_PREFIX };
  logger.info(`[Storage] ☁️  COS backend enabled (bucket=${bucket}, region=${region}, prefix=${KEY_PREFIX})`);
  return cachedConfig;
}

let cosClient: COS | null = null;
function getClient(cfg: CosConfig): COS {
  // Force https so presigned upload/download URLs work from an HTTPS deployment —
  // an http presigned URL would be blocked as mixed content.
  if (!cosClient) cosClient = new COS({ SecretId: cfg.secretId, SecretKey: cfg.secretKey, Protocol: 'https:' });
  return cosClient;
}

/** COS folder for AI-generated images (generate_image), kept separate from chat uploads. */
const GENERATE_PREFIX = 'generate/';

/**
 * Map a flat id to its COS key. Generated images (filename `gen-*`) live under
 * `generate/`; everything else uses the configured upload prefix. The id stays
 * flat in URLs (`/api/upload/<id>`) so this is the single source of truth for
 * which folder an id belongs to — keep put/get consistent by routing
 * through here.
 */
function keyFor(cfg: CosConfig, id: string): string {
  if (id.startsWith('gen-')) return `${GENERATE_PREFIX}${id}`;
  return `${cfg.prefix}${id}`;
}

function ensureLocalDir(): void {
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
}

/** Persist an object. Writes to COS when enabled, otherwise to local disk. */
export async function putUpload(id: string, buffer: Buffer, contentType: string): Promise<void> {
  assertValidUploadId(id);
  if (buffer.length > MAX_STORED_UPLOAD_BYTES) {
    throw new Error(`Image exceeds ${MAX_STORED_UPLOAD_BYTES} bytes`);
  }
  const detectedType = detectImageContentType(buffer);
  if (!detectedType || detectedType !== contentType) {
    throw new Error('Image bytes do not match the declared content type');
  }

  const cfg = getCosConfig();
  if (cfg) {
    const cos = getClient(cfg);
    await new Promise<void>((res, rej) =>
      cos.putObject(
        { Bucket: cfg.bucket, Region: cfg.region, Key: keyFor(cfg, id), Body: buffer, ContentType: contentType },
        (err) => (err ? rej(err) : res()),
      ),
    );
    return;
  }
  ensureLocalDir();
  writeFileSync(localUploadPath(id), buffer);
}

/** Fetch an object, or null if it exists in neither COS nor local disk. */
export async function getUpload(id: string): Promise<StoredObject | null> {
  assertValidUploadId(id);
  const cfg = getCosConfig();
  if (cfg) {
    const cos = getClient(cfg);
    try {
      const data = await new Promise<COS.GetObjectResult>((res, rej) =>
        cos.getObject({ Bucket: cfg.bucket, Region: cfg.region, Key: keyFor(cfg, id) }, (err, d) =>
          err ? rej(err) : res(d),
        ),
      );
      const body = data.Body as Buffer | Uint8Array | string;
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array);
      return verifiedStoredObject(buffer);
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      // 404 → fall through to local disk (legacy / locally-written files).
      // Any other error (auth, network) is a real failure — surface it.
      if (status !== 404) throw err;
    }
  }
  const filePath = localUploadPath(id);
  if (!existsSync(filePath)) return null;
  return verifiedStoredObject(readFileSync(filePath));
}

// ─── Drive object storage ──────────────────────────
//
// The drive works with full, server-generated object keys (e.g.
// `drive/tables/42/<uuid>.pdf`) rather than the flat chat-upload ids above, so
// these helpers take an explicit `key`. Keys are never derived from user input,
// so they can't traverse outside the drive namespace. When COS is configured,
// uploads go direct via a presigned PUT and downloads via a short-lived presigned
// GET; otherwise everything proxies through the API onto local disk (dev parity).

const DRIVE_PREFIX = normalizeKeyPrefix(
  process.env.TENCENT_CLOUD_COS_DRIVE_PREFIX,
  'TENCENT_CLOUD_COS_DRIVE_PREFIX',
  'drive/',
);

/** Build the server-owned COS key for a drive file. Namespaced by scope + owner. */
export function driveKeyFor(opts: {
  scope: 'kb' | 'tables';
  baseId?: number | null;
  visibility?: string | null;
  filename: string;
}): string {
  const ext = extname(opts.filename).toLowerCase();
  const uid = randomUUID();
  if (opts.scope === 'tables') return `${DRIVE_PREFIX}tables/${opts.baseId ?? 'none'}/${uid}${ext}`;
  return `${DRIVE_PREFIX}kb/${opts.visibility ?? 'team'}/${uid}${ext}`;
}

/** Build a server-owned key for a generated file attached to a chat session. */
export function chatFileKeyFor(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext !== '.csv' && ext !== '.xlsx') throw new Error('Unsupported chat file extension');
  return `${DRIVE_PREFIX}chat/${randomUUID()}${ext}`;
}

/** Local-disk path for a drive key, guarded to stay within UPLOADS_DIR. */
function driveLocalPath(key: string): string {
  const root = resolve(UPLOADS_DIR);
  const p = resolve(UPLOADS_DIR, key);
  if (p !== root && !p.startsWith(root + '/')) throw new Error('Invalid drive key');
  return p;
}

/**
 * Presigned PUT URL for a browser-direct upload, or null when COS is disabled
 * (caller falls back to the proxy upload endpoint).
 */
export async function presignPutUrl(key: string, expiresSec = 600): Promise<string | null> {
  const cfg = getCosConfig();
  if (!cfg) return null;
  const cos = getClient(cfg);
  return new Promise<string>((res, rej) =>
    cos.getObjectUrl(
      { Bucket: cfg.bucket, Region: cfg.region, Key: key, Method: 'PUT', Sign: true, Expires: expiresSec },
      (err, data) => (err ? rej(err) : res((data as { Url: string }).Url)),
    ),
  );
}

/**
 * Short-lived presigned GET URL (default 120s), or null when COS is disabled.
 * Drive objects are always attachments: none of their bytes or COS metadata may
 * become active content in the application's browser session.
 */
export async function presignGetUrl(
  key: string,
  expiresSec = 120,
  opts?: { filename?: string; contentType?: string },
): Promise<string | null> {
  const cfg = getCosConfig();
  if (!cfg) return null;
  const cos = getClient(cfg);
  const query: Record<string, string> = {};
  if (opts?.filename) {
    query['response-content-disposition'] = `attachment; filename="${encodeURIComponent(opts.filename)}"`;
  }
  if (opts?.contentType) query['response-content-type'] = opts.contentType;
  return new Promise<string>((res, rej) =>
    cos.getObjectUrl(
      {
        Bucket: cfg.bucket,
        Region: cfg.region,
        Key: key,
        Method: 'GET',
        Sign: true,
        Expires: expiresSec,
        Query: query,
      },
      (err, data) => (err ? rej(err) : res((data as { Url: string }).Url)),
    ),
  );
}

/** Verified byte size of an uploaded object, or null if it isn't there yet. */
export async function headObjectSize(key: string): Promise<number | null> {
  const cfg = getCosConfig();
  if (cfg) {
    const cos = getClient(cfg);
    try {
      const data = await new Promise<COS.HeadObjectResult>((res, rej) =>
        cos.headObject({ Bucket: cfg.bucket, Region: cfg.region, Key: key }, (err, d) => (err ? rej(err) : res(d))),
      );
      const len = data.headers?.['content-length'];
      return len != null ? Number(len) : null;
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) return null;
      throw err;
    }
  }
  const p = driveLocalPath(key);
  return existsSync(p) ? statSync(p).size : null;
}

/** Store bytes at an explicit key (proxy-upload path; COS or local). */
export async function putObjectAtKey(key: string, buffer: Buffer, contentType: string): Promise<void> {
  const cfg = getCosConfig();
  if (cfg) {
    const cos = getClient(cfg);
    await new Promise<void>((res, rej) =>
      cos.putObject(
        { Bucket: cfg.bucket, Region: cfg.region, Key: key, Body: buffer, ContentType: contentType },
        (err) => (err ? rej(err) : res()),
      ),
    );
    return;
  }
  const p = driveLocalPath(key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buffer);
}

/** Fetch bytes at an explicit key, or null if absent (proxy-download path). */
export async function getObjectAtKey(key: string): Promise<StoredObject | null> {
  const cfg = getCosConfig();
  if (cfg) {
    const cos = getClient(cfg);
    try {
      const data = await new Promise<COS.GetObjectResult>((res, rej) =>
        cos.getObject({ Bucket: cfg.bucket, Region: cfg.region, Key: key }, (err, d) => (err ? rej(err) : res(d))),
      );
      const body = data.Body as Buffer | Uint8Array;
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const headerType = (data.headers?.['content-type'] as string | undefined)?.split(';')[0].trim();
      return { buffer, contentType: headerType || contentTypeForId(key) };
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) return null;
      throw err;
    }
  }
  const p = driveLocalPath(key);
  if (!existsSync(p)) return null;
  return { buffer: readFileSync(p), contentType: contentTypeForId(key) };
}

/** Delete an object by key (best-effort on local). */
export async function deleteObjectAtKey(key: string): Promise<void> {
  const cfg = getCosConfig();
  if (cfg) {
    const cos = getClient(cfg);
    await new Promise<void>((res, rej) =>
      cos.deleteObject({ Bucket: cfg.bucket, Region: cfg.region, Key: key }, (err) => (err ? rej(err) : res())),
    );
    return;
  }
  const p = driveLocalPath(key);
  if (existsSync(p)) unlinkSync(p);
}
