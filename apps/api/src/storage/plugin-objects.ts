/**
 * Plugin objects — one namespaced object store per plugin, on whichever backend the
 * deployment configured (COS, S3, local disk), with the same behaviour on all three.
 *
 * A plugin names objects by a relative key (`assets/ab12…/original.mp4`); the store
 * files them under `<drive prefix>plugins/<plugin id>/` and never lets a key leave
 * that namespace. Browsers never get storage credentials:
 *   - uploads: `uploadUrl()` is a presigned PUT (COS; S3 with STORAGE_S3_PRESIGN), or an
 *     `/api/ext-objects/<ticket>` URL that streams the body to storage with a byte cap;
 *   - reads: `readUrl()` is a presigned GET, or a ticket URL that streams with Range.
 * Inline display is limited to raster images, video and audio; everything else is an
 * attachment served as application/octet-stream. A direct upload cannot be size-capped by
 * the bucket, so the plugin checks `head()` after the client reports completion.
 */
import { basename } from 'node:path';
import { contentDisposition } from '../http/content-disposition.js';
import { createObjectTicket } from '../auth/token.js';
import {
  deleteObjectAtKey,
  directObjectUrls,
  getObjectAtKey,
  headObjectSize,
  openObjectAtKey,
  pluginObjectPrefix,
  presignObjectUrl,
  putObjectAtKey,
  type ObjectStream,
  type StoredObject,
} from './uploads.js';

/** Content types a plugin object may be served inline as. */
export const INLINE_OBJECT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
]);

/** The largest single PUT the object stores accept (S3 / COS single-request ceiling). */
export const MAX_PLUGIN_OBJECT_BYTES = 5 * 1024 ** 3;

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export interface PluginUploadTarget {
  method: 'PUT';
  /** Absolute (presigned) or API-relative (`/api/ext-objects/…`) URL. */
  url: string;
  /** Headers the browser must send with the PUT. */
  headers: Record<string, string>;
  expiresAt: string;
  /** True when the bytes go straight to the bucket (the plugin must verify the size afterwards). */
  direct: boolean;
}

export interface PluginUploadOptions {
  key: string;
  contentType: string;
  /** Upper bound enforced on proxied uploads; verify direct uploads with `head()`. */
  maxBytes: number;
  /** 60–3600 seconds, default 900. */
  expiresInSec?: number;
}

export interface PluginReadOptions {
  /** `inline` applies only to INLINE_OBJECT_TYPES; anything else downloads. Default attachment. */
  disposition?: 'inline' | 'attachment';
  /** Attachment file name (default: the key's last segment). */
  filename?: string;
  /** The object's content type (default: guessed from the key's extension). */
  contentType?: string;
  /** 60–43200 seconds, default 3600. */
  expiresInSec?: number;
}

export interface PluginObjectStore {
  /** Whether URLs point straight at the bucket (else at the API). */
  readonly direct: boolean;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Whole object in memory; use `open` for large ones. */
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number } | null>;
  open(key: string, range?: { start: number; end?: number }): Promise<ObjectStream | 'unsatisfiable' | null>;
  delete(key: string): Promise<void>;
  uploadUrl(opts: PluginUploadOptions): Promise<PluginUploadTarget>;
  readUrl(key: string, opts?: PluginReadOptions): Promise<string>;
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

/** The content type a key's extension implies (octet-stream when unknown). */
export function contentTypeForObjectKey(key: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase();
  return (ext && TYPE_BY_EXTENSION[ext]) || 'application/octet-stream';
}

/** Validate a plugin-relative key; throws on anything that could leave the namespace. */
export function assertPluginObjectKey(key: string): void {
  if (typeof key !== 'string' || key.length > 200 || !KEY.test(key)) {
    throw new Error(`Invalid plugin object key: ${JSON.stringify(String(key).slice(0, 80))}`);
  }
}

/** The storage key of a plugin object. */
export function pluginObjectStorageKey(pluginId: string, key: string): string {
  if (!PLUGIN_ID.test(pluginId)) throw new Error(`Invalid plugin id: ${JSON.stringify(pluginId)}`);
  assertPluginObjectKey(key);
  return `${pluginObjectPrefix()}${pluginId}/${key}`;
}

function boundedSeconds(value: number | undefined, fallback: number, min: number, max: number): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`Expiry must be ${min}–${max} seconds`);
  return v;
}

export function pluginObjects(pluginId: string): PluginObjectStore {
  if (!PLUGIN_ID.test(pluginId)) throw new Error(`Invalid plugin id: ${JSON.stringify(pluginId)}`);
  const full = (key: string) => pluginObjectStorageKey(pluginId, key);
  return {
    get direct() {
      return directObjectUrls();
    },
    put: (key, bytes, contentType) => putObjectAtKey(full(key), bytes, contentType),
    get: (key) => getObjectAtKey(full(key)),
    head: async (key) => {
      const size = await headObjectSize(full(key));
      return size === null ? null : { size };
    },
    open: (key, range) => openObjectAtKey(full(key), range),
    delete: (key) => deleteObjectAtKey(full(key)),

    async uploadUrl(opts) {
      const storageKey = full(opts.key);
      if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1 || opts.maxBytes > MAX_PLUGIN_OBJECT_BYTES)
        throw new Error(`maxBytes must be 1–${MAX_PLUGIN_OBJECT_BYTES}`);
      if (!CONTENT_TYPE.test(opts.contentType)) throw new Error('Invalid upload content type');
      const expiresSec = boundedSeconds(opts.expiresInSec, 900, 60, 3600);
      const expiresAt = new Date(Date.now() + expiresSec * 1000).toISOString();
      const headers = { 'Content-Type': opts.contentType };
      const presigned = await presignObjectUrl(storageKey, { method: 'PUT', expiresSec });
      if (presigned) return { method: 'PUT', url: presigned, headers, expiresAt, direct: true };
      const ticket = createObjectTicket({
        p: pluginId,
        k: opts.key,
        o: 'u',
        e: Math.floor(Date.now() / 1000) + expiresSec,
        m: opts.maxBytes,
        t: opts.contentType.toLowerCase(),
      });
      return { method: 'PUT', url: `/api/ext-objects/${ticket}`, headers, expiresAt, direct: false };
    },

    async readUrl(key, opts = {}) {
      const storageKey = full(key);
      const expiresSec = boundedSeconds(opts.expiresInSec, 3600, 60, 43_200);
      const type = (opts.contentType ?? contentTypeForObjectKey(key)).toLowerCase();
      const inline = opts.disposition === 'inline' && INLINE_OBJECT_TYPES.has(type);
      const filename = opts.filename ?? basename(key);
      const presigned = await presignObjectUrl(storageKey, {
        method: 'GET',
        expiresSec,
        disposition: inline ? 'inline' : contentDisposition(filename),
        contentType: inline ? type : 'application/octet-stream',
      });
      if (presigned) return presigned;
      const ticket = createObjectTicket({
        p: pluginId,
        k: key,
        o: 'r',
        e: Math.floor(Date.now() / 1000) + expiresSec,
        d: inline ? 'i' : 'a',
        ...(inline ? { t: type } : { f: filename }),
      });
      return `/api/ext-objects/${ticket}`;
    },
  };
}
