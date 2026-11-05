/**
 * Plugin objects on the local-disk backend: the namespace, the inline allowlist, and the
 * /api/ext-objects ticket route (streamed uploads with a byte cap, byte-range reads).
 * Object storage is selected at module load, so every case loads the modules fresh with
 * the object-store variables cleared.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';

const STORAGE_ENV = [
  'TENCENT_CLOUD_COS_SECRET_ID',
  'TENCENT_CLOUD_COS_SECRET_KEY',
  'TENCENT_CLOUD_COS_BUCKET',
  'TENCENT_CLOUD_COS_REGION',
  'STORAGE_S3_ENDPOINT',
  'STORAGE_S3_BUCKET',
  'STORAGE_S3_ACCESS_KEY_ID',
  'STORAGE_S3_SECRET_ACCESS_KEY',
  'STORAGE_S3_REGION',
  'STORAGE_S3_FORCE_PATH_STYLE',
  'STORAGE_S3_PRESIGN',
];

async function load() {
  vi.resetModules();
  for (const key of STORAGE_ENV) vi.stubEnv(key, '');
  vi.stubEnv('TOKEN_SIGNING_KEY', '7a'.repeat(32));
  // The route admits tickets of active plugins only; a fixture keeps this test independent of the compiled set.
  vi.doMock('../../plugin-host/index.js', () => ({ EXTENSIONS: [{ id: 'fixture', name: 'Fixture' }] }));
  const objects = await import('../plugin-objects.js');
  const uploads = await import('../uploads.js');
  const route = (await import('../../routes/ext-objects.js')).default;
  const token = await import('../../auth/token.js');
  const paths = await import('../../paths.js');
  const app = new Hono().route('/api/ext-objects', route);
  return { objects, uploads, app, token, paths };
}

let namespace: string | undefined;
beforeEach(async () => {
  const { paths } = await load();
  namespace = resolve(paths.UPLOADS_DIR, 'drive/plugins/fixture/test');
});
afterEach(() => {
  vi.doUnmock('../../plugin-host/index.js');
  vi.unstubAllEnvs();
  vi.resetModules();
});
afterAll(() => {
  if (namespace && existsSync(namespace)) rmSync(namespace, { recursive: true, force: true });
});

const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

describe('plugin object keys', () => {
  it.each(['../x', '/abs', '.hidden', 'a//b', 'a/../b', 'a/./b', 'x'.repeat(201), 'a b', 'a\\b', ''])(
    'refuses %j',
    async (key) => {
      const { objects } = await load();
      expect(() => objects.pluginObjectStorageKey('fixture', key)).toThrow(/Invalid plugin object key/);
    },
  );

  it('files keys under the plugin namespace of the drive prefix', async () => {
    const { objects } = await load();
    expect(objects.pluginObjectStorageKey('fixture', 'test/a.webp')).toBe('drive/plugins/fixture/test/a.webp');
    expect(() => objects.pluginObjects('Bad Id')).toThrow(/Invalid plugin id/);
  });
});

describe('local backend', () => {
  it('round-trips bytes, sizes, ranges and deletes inside the namespace', async () => {
    const { objects } = await load();
    const store = objects.pluginObjects('fixture');
    expect(store.direct).toBe(false);
    await store.put('test/round.bin', Buffer.from('0123456789'), 'application/octet-stream');
    expect(await store.head('test/round.bin')).toEqual({ size: 10 });
    expect((await store.get('test/round.bin'))?.buffer.toString()).toBe('0123456789');
    const part = await store.open('test/round.bin', { start: 2, end: 4 });
    expect(part).toMatchObject({ status: 206, contentLength: 3, size: 10 });
    expect(await new Response((part as { body: ReadableStream }).body).text()).toBe('234');
    expect(await store.open('test/round.bin', { start: 10 })).toBe('unsatisfiable');
    await store.delete('test/round.bin');
    expect(await store.head('test/round.bin')).toBeNull();
  });

  it('serves only media inline; everything else is an attachment', async () => {
    const { objects, token } = await load();
    const store = objects.pluginObjects('fixture');
    const ticketOf = (url: string) => token.validateObjectTicket(url.split('/').pop()!)!;
    const image = ticketOf(await store.readUrl('test/a.webp', { disposition: 'inline' }));
    expect(image).toMatchObject({ p: 'fixture', k: 'test/a.webp', o: 'r', d: 'i', t: 'image/webp' });
    const svg = ticketOf(await store.readUrl('test/a.svg', { disposition: 'inline', contentType: 'image/svg+xml' }));
    expect(svg).toMatchObject({ d: 'a', f: 'a.svg' });
    expect(svg.t).toBeUndefined();
    const html = ticketOf(await store.readUrl('test/page', { disposition: 'inline', contentType: 'text/html' }));
    expect(html.d).toBe('a');
  });

  it('validates upload options', async () => {
    const { objects } = await load();
    const store = objects.pluginObjects('fixture');
    await expect(store.uploadUrl({ key: 'test/x', contentType: 'image/png', maxBytes: 0 })).rejects.toThrow(/maxBytes/);
    await expect(store.uploadUrl({ key: 'test/x', contentType: 'not a type', maxBytes: 10 })).rejects.toThrow(
      /content type/,
    );
    await expect(
      store.uploadUrl({ key: 'test/x', contentType: 'image/png', maxBytes: 10, expiresInSec: 10 }),
    ).rejects.toThrow(/Expiry/);
    const target = await store.uploadUrl({ key: 'test/x', contentType: 'image/png', maxBytes: 10 });
    expect(target).toMatchObject({ method: 'PUT', direct: false, headers: { 'Content-Type': 'image/png' } });
    expect(target.url).toMatch(/^\/api\/ext-objects\//);
  });
});

describe('/api/ext-objects tickets', () => {
  it('streams an upload within its cap, then serves it whole and by range', async () => {
    const { objects, app } = await load();
    const store = objects.pluginObjects('fixture');
    const upload = await store.uploadUrl({ key: 'test/video.mp4', contentType: 'video/mp4', maxBytes: 64 });
    const put = await app.request(path(upload.url), {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': '10' },
      body: 'abcdefghij',
    });
    expect(put.status).toBe(200);
    expect(await store.head('test/video.mp4')).toEqual({ size: 10 });

    const url = path(await store.readUrl('test/video.mp4', { disposition: 'inline' }));
    const whole = await app.request(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('content-disposition')).toBe('inline');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(await whole.text()).toBe('abcdefghij');

    const range = await app.request(url, { headers: { range: 'bytes=2-4' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await range.text()).toBe('cde');

    const suffix = await app.request(url, { headers: { range: 'bytes=-3' } });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe('hij');

    const open = await app.request(url, { headers: { range: 'bytes=7-' } });
    expect(await open.text()).toBe('hij');

    const past = await app.request(url, { headers: { range: 'bytes=20-' } });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */10');

    const head = await app.request(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
  });

  it('downloads non-media as an octet-stream attachment', async () => {
    const { objects, app } = await load();
    const store = objects.pluginObjects('fixture');
    await store.put('test/report.html', Buffer.from('<script>1</script>'), 'text/html');
    const res = await app.request(
      path(await store.readUrl('test/report.html', { disposition: 'inline', contentType: 'text/html' })),
    );
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="report.html"/);
  });

  it('refuses oversize, unlabelled, mistyped and over-long uploads', async () => {
    const { objects, app } = await load();
    const store = objects.pluginObjects('fixture');
    const upload = path((await store.uploadUrl({ key: 'test/cap.png', contentType: 'image/png', maxBytes: 4 })).url);
    const send = (headers: Record<string, string>, body = 'abcd') =>
      app.request(upload, { method: 'PUT', headers, body });
    expect((await send({ 'content-type': 'image/png', 'content-length': '5' }, 'abcde')).status).toBe(413);
    expect((await send({ 'content-type': 'image/jpeg', 'content-length': '4' })).status).toBe(415);
    // The declared length is a contract: a body longer than it never lands.
    expect((await send({ 'content-type': 'image/png', 'content-length': '2' }, 'abcd')).status).toBe(400);
    expect(await store.head('test/cap.png')).toBeNull();
  });

  it('404s tampered, expired, wrong-operation and inactive-plugin tickets', async () => {
    const { objects, app, token } = await load();
    const store = objects.pluginObjects('fixture');
    await store.put('test/t.png', Buffer.from('x'), 'image/png');
    const good = path(await store.readUrl('test/t.png', { disposition: 'inline' }));
    expect((await app.request(good)).status).toBe(200);
    expect((await app.request(`${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`)).status).toBe(404);
    const expired = token.createObjectTicket({ p: 'fixture', k: 'test/t.png', o: 'r', e: 1, d: 'i', t: 'image/png' });
    expect((await app.request(`/api/ext-objects/${expired}`)).status).toBe(404);
    const upload = path((await store.uploadUrl({ key: 'test/t.png', contentType: 'image/png', maxBytes: 4 })).url);
    expect((await app.request(upload)).status).toBe(404);
    const other = token.createObjectTicket({
      p: 'not-active',
      k: 'test/t.png',
      o: 'r',
      e: Math.floor(Date.now() / 1000) + 60,
    });
    expect((await app.request(`/api/ext-objects/${other}`)).status).toBe(404);
    const escape = token.createObjectTicket({
      p: 'fixture',
      k: '../../x',
      o: 'r',
      e: Math.floor(Date.now() / 1000) + 60,
    });
    expect((await app.request(`/api/ext-objects/${escape}`)).status).toBe(404);
  });
});
