/**
 * s3-lite — minimal, dependency-free S3-compatible client (SigV4).
 *
 * PUT/GET/HEAD/DELETE objects and paginated ListObjectsV2,
 * signed with AWS Signature V4. Works against AWS S3, MinIO, Cloudflare R2,
 * Tencent COS, … — anything S3-compatible. Path-style URLs by default (what
 * MinIO/self-hosted stores expect); virtual-host style is opt-out via
 * `forcePathStyle: false`.
 *
 * Why not @aws-sdk/client-s3: these operations don't justify a multi-megabyte
 * dependency tree. The signing algorithm is deterministic and pinned by a unit
 * test against the official AWS SigV4 test-suite vector (s3-lite.test.ts).
 *
 * Limitations (deliberate): no presign or multipart; callers proxy bytes.
 */

import { createHash, createHmac } from 'node:crypto';

// ─── SigV4 core (pure — unit-testable against official vectors) ───

/** RFC 3986 encode one path segment (AWS canonical URI rules). */
function encodeRfc3986(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encode an object key for the canonical URI, keeping `/` as the separator. */
export function encodeS3Key(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
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
  getObjectWithMetadata(key: string): Promise<{ buffer: Buffer; contentType: string | null } | null>;
  /** Verified Content-Length, or null on 404. Invalid metadata is an error. */
  headObjectSize(key: string): Promise<number | null>;
  /** All matching keys, following opaque ListObjectsV2 continuation tokens. */
  listObjectKeys(prefix: string): Promise<string[]>;
  /** Idempotent — a missing object is not an error. */
  deleteObject(key: string): Promise<void>;
}

function amzNow(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Validate infrastructure without putting endpoint credentials in an error message. */
export function parseS3Endpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('S3 endpoint must be an absolute http(s) URL');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('S3 endpoint must be an http(s) URL without credentials, query or fragment');
  }
  if (endpoint.pathname !== '/' && endpoint.pathname !== '') {
    throw new Error('S3 endpoint must not carry a path');
  }
  return endpoint;
}

/** The response fields we read are XML text, never markup or external entities. */
function xmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1].toLowerCase() === 'x';
      return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity];
  });
}

/** `fetchImpl` is a test seam — production uses global fetch. */
export function createS3Client(cfg: S3LiteConfig, fetchImpl: typeof fetch = fetch): S3LiteClient {
  const endpoint = parseS3Endpoint(cfg.endpoint);
  const pathStyle = cfg.forcePathStyle !== false;

  async function request(
    method: 'PUT' | 'GET' | 'HEAD' | 'DELETE',
    key: string,
    body?: Buffer,
    contentType?: string,
    params: Record<string, string> = {},
  ): Promise<Response> {
    const host = pathStyle ? endpoint.host : `${cfg.bucket}.${endpoint.host}`;
    const path = pathStyle ? `/${encodeRfc3986(cfg.bucket)}/${encodeS3Key(key)}` : `/${encodeS3Key(key)}`;
    const amzDate = amzNow();
    const payloadHash = sha256Hex(body ?? '');
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
      .sort()
      .join('&');

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
      redirect: 'error',
    });
  }

  async function getObjectWithMetadata(key: string) {
    const res = await request('GET', key);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) await fail('GET', key, res);
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type')?.split(';')[0].trim() || null,
    };
  }

  async function fail(op: string, key: string, res: Response): Promise<never> {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`S3 ${op} "${key}" failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  }

  return {
    async putObject(key, body, contentType) {
      const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      const res = await request('PUT', key, buf, contentType);
      if (!res.ok) await fail('PUT', key, res);
      await res.body?.cancel();
    },

    async getObject(key) {
      return (await getObjectWithMetadata(key))?.buffer ?? null;
    },

    getObjectWithMetadata,

    async headObjectSize(key) {
      const res = await request('HEAD', key);
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) await fail('HEAD', key, res);
      await res.body?.cancel();
      const length = res.headers.get('content-length');
      if (length === null || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
        throw new Error('S3 HEAD returned invalid Content-Length');
      }
      return Number(length);
    },

    async listObjectKeys(prefix) {
      const keys: string[] = [];
      const seenTokens = new Set<string>();
      let token: string | undefined;
      for (;;) {
        const res = await request('GET', '', undefined, undefined, {
          'list-type': '2',
          'max-keys': '1000',
          prefix,
          ...(token ? { 'continuation-token': token } : {}),
        });
        if (!res.ok) await fail('LIST', prefix, res);
        const xml = await res.text();
        const truncated = /<IsTruncated>\s*(true|false)\s*<\/IsTruncated>/.exec(xml)?.[1];
        if (!/<ListBucketResult(?:\s[^>]*)?>/.test(xml) || !xml.includes('</ListBucketResult>') || !truncated) {
          throw new Error('S3 LIST returned an invalid ListObjectsV2 response');
        }
        for (const entry of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const raw = /<Key>([\s\S]*?)<\/Key>/.exec(entry[1])?.[1];
          if (raw === undefined) throw new Error('S3 LIST returned an object without a key');
          // Raw keys (no encoding-type=url): servers disagree on how they encode `+` and spaces.
          keys.push(xmlText(raw));
        }
        if (truncated === 'false') return keys;
        const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
        token = next ? xmlText(next) : undefined;
        if (!token || seenTokens.has(token))
          throw new Error('S3 LIST returned a missing or repeated continuation token');
        seenTokens.add(token);
      }
    },

    async deleteObject(key) {
      const res = await request('DELETE', key);
      // 204 = deleted, 404 = already gone — both fine.
      if (!res.ok && res.status !== 404) await fail('DELETE', key, res);
      await res.body?.cancel();
    },
  };
}
