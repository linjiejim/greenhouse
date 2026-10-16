import { z } from 'zod';
import type { ProviderAdapter, StorageClient } from '../types.js';
import { amzDate, encodeKey, encodeRfc3986, presignV4, sha256Hex, signV4 } from './sigv4.js';

export const s3ConfigSchema = z.object({
  /** Base endpoint without a path, e.g. https://s3.us-east-1.amazonaws.com or https://cos.ap-shanghai.myqcloud.com */
  endpoint: z.string().url(),
  bucket: z.string().min(1),
  region: z.string().min(1).default('us-east-1'),
  /** Path-style (endpoint/bucket/key) when true; virtual-host style (bucket.endpoint/key) when false. */
  forcePathStyle: z.boolean().default(true),
  /** Prepended to every key, e.g. greenhouse/ */
  prefix: z.string().default(''),
});
export type S3Config = z.infer<typeof s3ConfigSchema>;

function hostAndPath(config: S3Config, key: string) {
  const endpoint = new URL(config.endpoint);
  if (endpoint.pathname !== '/' && endpoint.pathname !== '') throw new Error('An S3 endpoint must not carry a path.');
  const fullKey = `${config.prefix}${key}`;
  return config.forcePathStyle
    ? {
        protocol: endpoint.protocol,
        host: endpoint.host,
        path: `/${encodeRfc3986(config.bucket)}/${encodeKey(fullKey)}`,
      }
    : { protocol: endpoint.protocol, host: `${config.bucket}.${endpoint.host}`, path: `/${encodeKey(fullKey)}` };
}

export function createS3Client(
  config: S3Config,
  secrets: { accessKeyId: string; secretAccessKey: string },
  fetchImpl: typeof fetch,
): StorageClient {
  async function request(
    method: 'PUT' | 'GET' | 'HEAD' | 'DELETE',
    key: string,
    body?: Uint8Array,
    contentType?: string,
  ) {
    const { protocol, host, path } = hostAndPath(config, key);
    const date = amzDate();
    const payloadHash = sha256Hex(body ?? '');
    const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
    if (contentType) headers['content-type'] = contentType;
    const { authorization } = signV4({
      method,
      path,
      headers,
      payloadHash,
      accessKeyId: secrets.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
      region: config.region,
      service: 's3',
      amzDate: date,
    });
    const { host: _host, ...send } = headers;
    return fetchImpl(`${protocol}//${host}${path}`, {
      method,
      headers: { ...send, authorization },
      body: body as BodyInit | undefined,
    });
  }

  async function fail(op: string, key: string, response: Response): Promise<never> {
    const text = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`S3 ${op} "${key}" failed: HTTP ${response.status}${text ? ` — ${text}` : ''}`);
  }

  return {
    async put(key, body, options) {
      const response = await request('PUT', key, body, options.contentType);
      if (!response.ok) await fail('PUT', key, response);
      await response.body?.cancel();
    },
    async get(key) {
      const response = await request('GET', key);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) await fail('GET', key, response);
      const size = Number(response.headers.get('content-length'));
      return {
        body: response.body ?? new ReadableStream({ start: (controller) => controller.close() }),
        size: Number.isFinite(size) ? size : undefined,
        contentType: response.headers.get('content-type') ?? undefined,
      };
    },
    async head(key) {
      const response = await request('HEAD', key);
      if (response.status === 404) return null;
      if (!response.ok) await fail('HEAD', key, response);
      return {
        size: Number(response.headers.get('content-length') ?? 0),
        contentType: response.headers.get('content-type') ?? undefined,
      };
    },
    async delete(key) {
      const response = await request('DELETE', key);
      if (!response.ok && response.status !== 404) await fail('DELETE', key, response);
      await response.body?.cancel();
    },
    presignGet(key, options) {
      const { protocol, host, path } = hostAndPath(config, key);
      const extraQuery = options.filename
        ? { 'response-content-disposition': `attachment; filename*=UTF-8''${encodeRfc3986(options.filename)}` }
        : undefined;
      const query = presignV4({
        method: 'GET',
        path,
        host,
        accessKeyId: secrets.accessKeyId,
        secretAccessKey: secrets.secretAccessKey,
        region: config.region,
        service: 's3',
        amzDate: amzDate(),
        expiresInSeconds: Math.min(Math.max(1, Math.floor(options.expiresInSeconds)), 7 * 24 * 3600),
        extraQuery,
      });
      return `${protocol}//${host}${path}?${query}`;
    },
  };
}

export const s3Adapter: ProviderAdapter<'storage', S3Config> = {
  capability: 'storage',
  kind: 's3',
  label: 'S3 兼容存储',
  configSchema: s3ConfigSchema as z.ZodType<S3Config>,
  secretKeys: ['accessKeyId', 'secretAccessKey'],
  requiredSecrets: ['accessKeyId', 'secretAccessKey'],
  presets: [
    {
      id: 'aws-s3',
      label: 'AWS S3',
      config: { endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', forcePathStyle: false },
    },
    { id: 'r2', label: 'Cloudflare R2', config: { region: 'auto', forcePathStyle: true } },
    { id: 'minio', label: 'MinIO', config: { endpoint: 'http://localhost:9000', forcePathStyle: true } },
    {
      id: 'tencent-cos',
      label: '腾讯云 COS',
      config: { endpoint: 'https://cos.ap-shanghai.myqcloud.com', region: 'ap-shanghai', forcePathStyle: false },
    },
    {
      id: 'aliyun-oss',
      label: '阿里云 OSS',
      config: { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'oss-cn-hangzhou', forcePathStyle: false },
    },
    {
      id: 'huawei-obs',
      label: '华为云 OBS',
      config: { endpoint: 'https://obs.cn-north-4.myhuaweicloud.com', region: 'cn-north-4', forcePathStyle: false },
    },
  ],
  endpoints: (config) => {
    const endpoint = new URL(config.endpoint);
    return [config.forcePathStyle ? endpoint.origin : `${endpoint.protocol}//${config.bucket}.${endpoint.host}`];
  },
  create: ({ config, secrets, fetch }) =>
    createS3Client(
      config,
      { accessKeyId: secrets.accessKeyId ?? '', secretAccessKey: secrets.secretAccessKey ?? '' },
      fetch,
    ),
  async test(client) {
    // A HEAD on a key that need not exist proves the credentials and the bucket.
    await client.head('greenhouse-check');
  },
};
