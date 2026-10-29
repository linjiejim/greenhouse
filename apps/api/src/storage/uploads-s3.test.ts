import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const paths = vi.hoisted(() => ({ UPLOADS_DIR: '' }));
vi.mock('../paths.js', () => paths);
const fetchMock = vi.fn<typeof fetch>();
const id = '1784639633034-32fd7fa6-01a2-4bdd-9733-737e835da203.png';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let storage: typeof import('./uploads.js');

beforeEach(async () => {
  vi.resetModules();
  paths.UPLOADS_DIR = mkdtempSync(join(tmpdir(), 'portable-uploads-'));
  for (const key of ['SECRET_ID', 'SECRET_KEY', 'BUCKET', 'REGION']) vi.stubEnv(`TENCENT_CLOUD_COS_${key}`, '');
  vi.stubEnv('TENCENT_CLOUD_COS_PREFIX', 'images');
  vi.stubEnv('TENCENT_CLOUD_COS_DRIVE_PREFIX', 'files');
  vi.stubEnv('STORAGE_S3_ENDPOINT', 'http://127.0.0.1:9000');
  vi.stubEnv('STORAGE_S3_BUCKET', 'bucket');
  vi.stubEnv('STORAGE_S3_ACCESS_KEY_ID', 'key');
  vi.stubEnv('STORAGE_S3_SECRET_ACCESS_KEY', 'secret');
  vi.stubGlobal('fetch', fetchMock);
  storage = await import('./uploads.js');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  fetchMock.mockReset();
  rmSync(paths.UPLOADS_DIR, { recursive: true, force: true });
});

describe('S3 uploads and Files', () => {
  it('stores uploaded and generated images at the existing COS keys and verifies read bytes', async () => {
    fetchMock.mockImplementation(async () => new Response(png));
    await storage.putUpload(id, png, 'image/png');
    await storage.putUpload(`gen-${id}`, png, 'image/png');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `http://127.0.0.1:9000/bucket/images/${id}`,
      `http://127.0.0.1:9000/bucket/generate/gen-${id}`,
    ]);
    expect(await storage.getUpload(id)).toEqual({ buffer: png, contentType: 'image/png' });
    fetchMock.mockResolvedValueOnce(new Response('not an image'));
    await expect(storage.getUpload(id)).rejects.toThrow(/not a supported image/);
  });

  it('falls back to a legacy local image only on 404', async () => {
    writeFileSync(join(paths.UPLOADS_DIR, id), png);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect((await storage.getUpload(id))?.buffer).toEqual(png);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(storage.getUpload(id)).rejects.toThrow(/HTTP 403/);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await storage.getUpload(`gen-${id}`)).toBeNull();
  });

  it('proxies file put/get/head/list/delete and never presigns', async () => {
    const key = storage.driveKeyFor({ scope: 'drive', filename: 'export.csv' });
    expect(key).toMatch(/^files\/drive\/none\//);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await storage.putObjectAtKey(key, Buffer.from('a,b'), 'text/csv');
    fetchMock.mockResolvedValueOnce(new Response('a,b', { headers: { 'content-type': 'text/csv; charset=utf-8' } }));
    expect(await storage.getObjectAtKey(key)).toEqual({ buffer: Buffer.from('a,b'), contentType: 'text/csv' });
    fetchMock.mockResolvedValueOnce(new Response(null, { headers: { 'content-length': '3' } }));
    expect(await storage.headObjectSize(key)).toBe(3);
    fetchMock.mockResolvedValueOnce(
      new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key></Contents></ListBucketResult>`,
      ),
    );
    expect(await storage.listObjectKeys('files/')).toEqual([key]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await storage.deleteObjectAtKey(key);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'GET', 'HEAD', 'GET', 'DELETE']);
    expect(await storage.presignPutUrl(key)).toBeNull();
    expect(await storage.presignGetUrl(key)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await expect(storage.listObjectKeys('skills/')).rejects.toThrow('Invalid drive prefix');
  });
});
