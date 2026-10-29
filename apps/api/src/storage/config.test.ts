import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageS3Config } from './config.js';

const configured = {
  STORAGE_S3_ENDPOINT: ' http://127.0.0.1:9000 ',
  STORAGE_S3_BUCKET: 'files',
  STORAGE_S3_ACCESS_KEY_ID: 'key',
  STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('core storage configuration', () => {
  it('defaults to local, and parses complete S3 configuration', () => {
    expect(resolveStorageS3Config({})).toBeNull();
    expect(resolveStorageS3Config(configured)).toMatchObject({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      forcePathStyle: true,
    });
    expect(
      resolveStorageS3Config({ ...configured, STORAGE_S3_REGION: 'auto', STORAGE_S3_FORCE_PATH_STYLE: 'false' }),
    ).toMatchObject({ region: 'auto', forcePathStyle: false });
  });

  it.each(Object.keys(configured))('refuses a missing %s', (key) => {
    expect(() => resolveStorageS3Config({ ...configured, [key]: '' })).toThrow(/partial STORAGE_S3_\* config/);
  });

  it('refuses optional S3 settings without credentials and refuses COS + S3', () => {
    expect(() => resolveStorageS3Config({ STORAGE_S3_REGION: 'auto' })).toThrow(/partial/);
    expect(() =>
      resolveStorageS3Config({
        ...configured,
        TENCENT_CLOUD_COS_SECRET_ID: 'id',
        TENCENT_CLOUD_COS_SECRET_KEY: 'secret',
        TENCENT_CLOUD_COS_BUCKET: 'cos',
        TENCENT_CLOUD_COS_REGION: 'region',
      }),
    ).toThrow(/both configured/);
  });

  it.each([
    'not-a-url',
    'ftp://files.example',
    'https://files.example/path',
    'https://secret@files.example',
    'https://files.example?key=secret',
  ])('refuses invalid endpoint %s without echoing secrets', (endpoint) => {
    expect(() => resolveStorageS3Config({ ...configured, STORAGE_S3_ENDPOINT: endpoint })).toThrow(/S3 endpoint/);
  });

  it('validates at uploads module load, before the first storage operation', async () => {
    vi.stubEnv('STORAGE_S3_ENDPOINT', 'http://127.0.0.1:9000');
    vi.stubEnv('STORAGE_S3_BUCKET', '');
    await expect(import('./uploads.js')).rejects.toThrow(/partial STORAGE_S3_\* config/);
  });
});
