/**
 * Local object-storage driver + presigned-URL flow.
 *
 * Verifies the object-storage code path end-to-end WITHOUT a real S3/COS: driver
 * routing, presignGet, and serving over `GET /api/upload/signed/:id`. Driver state
 * is a module global; vitest isolates per file, and the "no driver" case runs
 * before registration below.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import uploadApp from '../routes/upload.js';
import { signObjectPath, verifyObjectSignature } from './presign.js';
import { createLocalStorageDriver } from './local-driver.js';
import { registerStorageDriver } from './extensions.js';
import { presignUpload, putUpload, getUpload, deleteUpload, deleteLocal, expiryOf, makeExpiringId } from './uploads.js';

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((id) => deleteLocal(id)));
});

/** Drop the mount prefix so we can drive the upload sub-app directly. */
const rel = (signedUrl: string) => signedUrl.replace('/api/upload', '');

describe('presign signing', () => {
  const id = 'exp_100_abcdef12.xlsx';
  const path = signObjectPath(id, 100);
  const sig = new URL(path, 'http://x').searchParams.get('sig')!;

  it('accepts its own signature and rejects tampering', () => {
    expect(verifyObjectSignature(id, 100, sig)).toBe(true);
    expect(verifyObjectSignature(id, 100, `${sig}0`)).toBe(false); // wrong length
    expect(verifyObjectSignature(id, 100, 'deadbeef')).toBe(false); // wrong value
    expect(verifyObjectSignature('other.xlsx', 100, sig)).toBe(false); // different id
    expect(verifyObjectSignature(id, 101, sig)).toBe(false); // different deadline
    expect(verifyObjectSignature(id, 100, '')).toBe(false); // missing
  });
});

describe('presignUpload without a driver', () => {
  it('returns null so callers fall back to the proxy link', async () => {
    expect(await presignUpload('exp_100_abcdef12.xlsx')).toBeNull();
  });
});

describe('local object-storage driver', () => {
  beforeAll(() => registerStorageDriver(createLocalStorageDriver()));

  it('routes put/get/delete through the driver (disk-backed)', async () => {
    const id = makeExpiringId('csv', 60_000);
    created.push(id);
    await putUpload(id, Buffer.from('hello'), 'text/csv');
    expect((await getUpload(id))?.buffer.toString()).toBe('hello');
    await deleteUpload(id);
    expect(await getUpload(id)).toBeNull();
  });

  it('presignUpload returns a signed URL whose deadline matches the id expiry', async () => {
    const id = makeExpiringId('xlsx', 60_000);
    const url = await presignUpload(id);
    expect(url).toMatch(/^\/api\/upload\/signed\//);
    const exp = Number(new URL(url!, 'http://x').searchParams.get('exp'));
    expect(exp * 1000).toBe(expiryOf(id));
  });

  it('serves bytes over a valid presigned URL; 403 on tamper, 410 past deadline', async () => {
    const id = makeExpiringId('csv', 60_000);
    created.push(id);
    await putUpload(id, Buffer.from('a,b\r\n1,2'), 'text/csv; charset=utf-8');
    const signed = rel((await presignUpload(id))!);

    const ok = await uploadApp.request(signed);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(ok.headers.get('content-disposition')).toBe('attachment');
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(await ok.text()).toBe('a,b\r\n1,2');

    const tampered = await uploadApp.request(signed.replace(/sig=.*/, 'sig=deadbeef'));
    expect(tampered.status).toBe(403);

    const expired = await uploadApp.request(rel(signObjectPath(id, 1))); // exp=1 → 1970
    expect(expired.status).toBe(410);
  });
});
