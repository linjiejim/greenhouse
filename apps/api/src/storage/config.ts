import { parseS3Endpoint, type S3LiteConfig } from './s3-lite.js';

const REQUIRED = [
  'STORAGE_S3_ENDPOINT',
  'STORAGE_S3_BUCKET',
  'STORAGE_S3_ACCESS_KEY_ID',
  'STORAGE_S3_SECRET_ACCESS_KEY',
] as const;
const OPTIONAL = ['STORAGE_S3_REGION', 'STORAGE_S3_FORCE_PATH_STYLE'] as const;
const COS_REQUIRED = [
  'TENCENT_CLOUD_COS_SECRET_ID',
  'TENCENT_CLOUD_COS_SECRET_KEY',
  'TENCENT_CLOUD_COS_BUCKET',
  'TENCENT_CLOUD_COS_REGION',
] as const;

/** Shared by uploads and plugin stores; an incomplete requested backend never becomes local disk. */
export function resolveStorageS3Config(env: NodeJS.ProcessEnv = process.env): S3LiteConfig | null {
  if (![...REQUIRED, ...OPTIONAL].some((key) => env[key]?.trim())) return null;
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`Storage: partial STORAGE_S3_* config — missing ${missing.join(', ')}`);
  if (COS_REQUIRED.every((key) => env[key]?.trim())) {
    throw new Error('Storage: COS and STORAGE_S3_* are both configured; select only one object storage backend');
  }
  const endpoint = env.STORAGE_S3_ENDPOINT!.trim();
  parseS3Endpoint(endpoint);
  return {
    endpoint,
    bucket: env.STORAGE_S3_BUCKET!.trim(),
    accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY!.trim(),
    region: env.STORAGE_S3_REGION?.trim() || 'us-east-1',
    forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE?.trim().toLowerCase() !== 'false',
  };
}
