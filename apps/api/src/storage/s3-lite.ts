/**
 * s3-lite — minimal, dependency-free S3-compatible client (SigV4).
 *
 * The verbs its two users need, signed with AWS Signature V4: PUT/GET/DELETE of
 * an object (the skill store's small JSON bundles), plus multipart upload and a
 * streamed GET (Bot computer backups, which are gigabytes and never held in
 * memory whole). Works against AWS S3, MinIO, Cloudflare R2, Tencent COS, … —
 * anything S3-compatible. Path-style URLs by default (what MinIO/self-hosted
 * stores expect); virtual-host style is opt-out via `forcePathStyle: false`.
 *
 * Why not @aws-sdk/client-s3: a handful of verbs don't justify a multi-megabyte
 * dependency tree. The signing algorithm is deterministic and pinned by unit
 * tests against official AWS SigV4 vectors, query strings included (s3-lite.test.ts).
 *
 * Limitations (deliberate): no presign, no listing — objects are addressed by exact key.
 */

import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

// ─── SigV4 core (pure — unit-testable against official vectors) ───

/** RFC 3986 encode one path segment (AWS canonical URI rules). */
function encodeRfc3986(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encode an object key for the canonical URI, keeping `/` as the separator. */
export function encodeS3Key(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

/** The canonical query string: names and values RFC 3986-encoded, sorted by name (`uploads` → `uploads=`). */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export interface SignV4Input {
  method: string;
  /** Canonical URI — already RFC3986-encoded, starting with '/'. */
  path: string;
  /** Canonical query string ('' when none). */
  query?: string;
  /** Headers to sign — MUST include host and x-amz-date. */
  headers: Record<string, string>;
  /** Hex sha256 of the payload. */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** x-amz-date, `YYYYMMDD'T'HHMMSS'Z'`. */
  amzDate: string;
}

/**
 * Compute the SigV4 Authorization header for a request. Signs every header
 * passed in (lowercased, trimmed, sorted — the canonical form).
 */
export function signV4(input: SignV4Input): { authorization: string; signature: string } {
  const dateStamp = input.amzDate.slice(0, 8);
  const entries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalHeaders = entries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = entries.map(([k]) => k).join(';');

  const canonicalRequest = [
    input.method,
    input.path,
    input.query ?? '',
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, signature };
}

// ─── Client ──────────────────────────────────────────────

export interface S3LiteConfig {
  /** Base endpoint, e.g. `https://s3.us-east-1.amazonaws.com` or `http://127.0.0.1:9000`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style (`endpoint/bucket/key`, default true) vs virtual-host (`bucket.endpoint/key`). */
  forcePathStyle?: boolean;
}

export interface S3LiteClient {
  putObject(key: string, body: Buffer | string, contentType: string): Promise<void>;
  /** null when the object does not exist (404). */
  getObject(key: string): Promise<Buffer | null>;
  /** The body as a stream, never buffered; null when the object does not exist (404). */
  getObjectStream(key: string): Promise<Readable | null>;
  /** Idempotent — a missing object is not an error. */
  deleteObject(key: string): Promise<void>;
  /** Multipart upload: start one, returning its upload id. */
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /** One part (1-based; every part but the last at least 5 MiB), returning its ETag. */
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void>;
  /** Idempotent — an upload already gone is not an error. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

function amzNow(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** `fetchImpl` is a test seam — production uses global fetch. */
export function createS3Client(cfg: S3LiteConfig, fetchImpl: typeof fetch = fetch): S3LiteClient {
  const endpoint = new URL(cfg.endpoint);
  const pathStyle = cfg.forcePathStyle !== false;
  if (endpoint.pathname !== '/' && endpoint.pathname !== '') {
    throw new Error(`An S3 endpoint must not carry a path (got "${endpoint.pathname}")`);
  }

  async function request(
    method: 'PUT' | 'GET' | 'DELETE' | 'POST',
    key: string,
    opts: { query?: Record<string, string>; body?: Buffer; contentType?: string } = {},
  ): Promise<Response> {
    const { body, contentType } = opts;
    const host = pathStyle ? endpoint.host : `${cfg.bucket}.${endpoint.host}`;
    const path = pathStyle ? `/${encodeRfc3986(cfg.bucket)}/${encodeS3Key(key)}` : `/${encodeS3Key(key)}`;
    const query = opts.query ? canonicalQuery(opts.query) : '';
    const amzDate = amzNow();
    const payloadHash = sha256Hex(body ?? '');

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;

    const { authorization } = signV4({
      method,
      path,
      query,
      headers,
      payloadHash,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: 's3',
      amzDate,
    });

    // `host` is set by fetch itself from the URL; send the rest + Authorization.
    const { host: _host, ...sendHeaders } = headers;
    return fetchImpl(`${endpoint.protocol}//${host}${path}${query ? `?${query}` : ''}`, {
      method,
      headers: { ...sendHeaders, authorization },
      body: body as BodyInit | undefined,
    });
  }

  async function fail(op: string, key: string, res: Response): Promise<never> {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`S3 ${op} "${key}" failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  }

  /** S3 can answer 200 with an <Error> body (CompleteMultipartUpload): read the body before trusting it. */
  async function bodyOrFail(op: string, key: string, res: Response): Promise<string> {
    if (!res.ok) await fail(op, key, res);
    const text = await res.text();
    if (/<Error>/.test(text)) throw new Error(`S3 ${op} "${key}" failed: ${text.slice(0, 300)}`);
    return text;
  }

  return {
    async putObject(key, body, contentType) {
      const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      const res = await request('PUT', key, { body: buf, contentType });
      if (!res.ok) await fail('PUT', key, res);
      await res.body?.cancel();
    },

    async getObject(key) {
      const res = await request('GET', key);
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) await fail('GET', key, res);
      return Buffer.from(await res.arrayBuffer());
    },

    async getObjectStream(key) {
      const res = await request('GET', key);
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) await fail('GET', key, res);
      if (!res.body) return Readable.from([]);
      return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    },

    async deleteObject(key) {
      const res = await request('DELETE', key);
      // 204 = deleted, 404 = already gone — both fine.
      if (!res.ok && res.status !== 404) await fail('DELETE', key, res);
      await res.body?.cancel();
    },

    async createMultipartUpload(key, contentType) {
      const res = await request('POST', key, { query: { uploads: '' }, contentType });
      const text = await bodyOrFail('CreateMultipartUpload', key, res);
      const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(text)?.[1];
      if (!uploadId) throw new Error(`S3 CreateMultipartUpload "${key}" returned no UploadId`);
      return uploadId;
    },

    async uploadPart(key, uploadId, partNumber, body) {
      const res = await request('PUT', key, { query: { partNumber: String(partNumber), uploadId }, body });
      if (!res.ok) await fail(`UploadPart ${partNumber}`, key, res);
      await res.body?.cancel();
      const etag = res.headers.get('etag');
      if (!etag) throw new Error(`S3 UploadPart ${partNumber} "${key}" returned no ETag`);
      return etag;
    },

    async completeMultipartUpload(key, uploadId, parts) {
      const xml = `<CompleteMultipartUpload>${parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`;
      const res = await request('POST', key, {
        query: { uploadId },
        body: Buffer.from(xml, 'utf8'),
        contentType: 'application/xml',
      });
      await bodyOrFail('CompleteMultipartUpload', key, res);
    },

    async abortMultipartUpload(key, uploadId) {
      const res = await request('DELETE', key, { query: { uploadId } });
      if (!res.ok && res.status !== 404) await fail('AbortMultipartUpload', key, res);
      await res.body?.cancel();
    },
  };
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
