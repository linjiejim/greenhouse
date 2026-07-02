/**
 * GET /api/upload/:id — serving semantics for generated files.
 *
 * Drives the real Hono handler via app.request() over the local-disk storage
 * default (no driver), so expiry enforcement + download headers are exercised
 * end-to-end. Auth is applied globally in the main app, so the sub-app under test
 * needs none here.
 */

import { describe, it, expect, afterAll } from 'vitest';
import uploadApp from '../upload.js';
import { putUpload, deleteUpload, makeExpiringId } from '../../storage/uploads.js';

const created: string[] = [];
async function put(id: string, body: string, contentType: string): Promise<string> {
  await putUpload(id, Buffer.from(body), contentType);
  created.push(id);
  return id;
}

afterAll(async () => {
  await Promise.all(created.map((id) => deleteUpload(id).catch(() => {})));
});

describe('GET /api/upload/:id', () => {
  it('serves a live export as an attachment, uncached, with the right type', async () => {
    const id = await put(makeExpiringId('csv', 60_000), 'a,b\r\n1,2', 'text/csv; charset=utf-8');
    const res = await uploadApp.request(`/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toBe('a,b\r\n1,2');
  });

  it('returns 410 and no body once the export has expired', async () => {
    const id = makeExpiringId('xlsx', -1000); // deadline already in the past
    await putUpload(id, Buffer.from('stale'), 'application/octet-stream');
    created.push(id);
    const res = await uploadApp.request(`/${id}`);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'expired' });
  });

  it('serves images inline and publicly cacheable (unchanged behavior)', async () => {
    const id = await put('gen-test-abcdef12.png', 'PNGDATA', 'image/png');
    const res = await uploadApp.request(`/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('rejects ids that look like path traversal', async () => {
    const res = await uploadApp.request('/evil..name');
    expect(res.status).toBe(400);
  });
});
