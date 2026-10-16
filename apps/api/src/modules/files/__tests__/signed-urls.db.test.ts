import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEvents, files, getDb, members } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

function setup() {
  return createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-signed-')) });
}

async function upload(app: ReturnType<typeof setup>, token: string, file: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set('file', file);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const response = await app.app.request('/api/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** An <img> or a link: no bearer header, only the URL. */
const fetchUrl = (app: ReturnType<typeof setup>, url: string) => app.app.request(url);

const withQuery = (url: string, change: (query: URLSearchParams) => void) => {
  const parsed = new URL(url, 'http://greenhouse.test');
  change(parsed.searchParams);
  return `${parsed.pathname}?${parsed.searchParams.toString()}`;
};

describe('signed file URLs', () => {
  it('give each member a short-lived URL that works without a bearer header, and re-check access', async () => {
    const app = setup();
    const lin = await app.member();
    const chen = await app.member();
    const stored = await upload(app, lin.token, new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(stored.status).toBe(201);
    expect(stored.body.url).toMatch(/^\/api\/files\/fil_\w+\/content\?exp=\d+&m=mbr_\w+&sig=[\w-]+$/);
    const left = Date.parse(stored.body.expires_at) - Date.now();
    expect(left).toBeGreaterThan(59 * 60_000);
    expect(left).toBeLessThanOrEqual(2 * 60 * 60_000);

    const served = await fetchUrl(app, stored.body.url);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('hello');
    expect(served.headers.get('cache-control')).toMatch(/^private, max-age=\d+, immutable$/);
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
    // Minted per request, but stable within the hour: browsers can cache it.
    expect((await app.call('GET', `/api/files/${stored.body.id}`, { token: lin.token })).body.url).toBe(
      stored.body.url,
    );

    // Tampering with anything breaks it: the file, the member, the time.
    expect(
      (
        await fetchUrl(
          app,
          withQuery(stored.body.url, (q) => q.set('m', chen.id)),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetchUrl(
          app,
          withQuery(stored.body.url, (q) => q.set('exp', String(Number(q.get('exp')) + 3600))),
        )
      ).status,
    ).toBe(404);
    expect(
      await fetchUrl(
        app,
        withQuery(stored.body.url, (q) => q.delete('sig')),
      ),
    ).toMatchObject({ status: 400 });
    // A URL signed for chen does not open lin's file: access is checked again when it is served.
    const forChen = app.services.files.signedUrl(stored.body.id, chen.id);
    expect((await fetchUrl(app, forChen.url)).status).toBe(404);
    // An expired one is refused.
    const old = app.services.files.signedUrl(stored.body.id, lin.id, Date.now() - 3 * 60 * 60_000);
    expect((await fetchUrl(app, old.url)).status).toBe(404);

    // A member who is disabled loses their URLs at once.
    await getDb().update(members).set({ status: 'disabled' }).where(eq(members.id, lin.id));
    expect((await fetchUrl(app, stored.body.url)).status).toBe(404);
  });

  it('serve pages and SVG as downloads only', async () => {
    const app = setup();
    const lin = await app.member();
    const page = await upload(app, lin.token, new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' }));
    const served = await fetchUrl(app, page.body.url);
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('content-disposition')).toMatch(/^attachment/);
    const svg = await upload(app, lin.token, new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }));
    expect((await fetchUrl(app, svg.body.url)).headers.get('content-disposition')).toMatch(/^attachment/);
  });
});

describe('avatars', () => {
  it('lets a member set and remove their picture; every member sees it, and nothing else of theirs', async () => {
    const app = setup();
    const lin = await app.member();
    const chen = await app.member();
    const picture = await upload(app, lin.token, new File([PNG], 'me.png', { type: 'image/png' }), {
      purpose: 'avatar',
    });
    expect(picture.status).toBe(201);
    // Not an avatar yet: only its owner may read it.
    expect((await app.call('GET', `/api/files/${picture.body.id}`, { token: chen.token })).status).toBe(404);

    const me = await app.call('PATCH', '/api/me', { token: lin.token, body: { avatar_file_id: picture.body.id } });
    expect(me.status).toBe(200);
    expect(me.body.avatar_url).toMatch(
      new RegExp(`^/api/files/${picture.body.id}/content\\?exp=\\d+&m=${lin.id}&sig=`),
    );

    // Chen sees it in the directory, with a URL made for chen that an <img> can load.
    const directory = await app.call('GET', '/api/members', { token: chen.token });
    const seen = directory.body.items.find((person: { id: string }) => person.id === lin.id);
    expect(seen.avatar_url).toContain(`m=${chen.id}`);
    const image = await fetchUrl(app, seen.avatar_url);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-disposition')).toMatch(/^inline/);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);

    // A new picture replaces it and the old one is deleted, its URLs with it.
    const next = await upload(app, lin.token, new File([JPEG], 'new.jpg', { type: 'image/png' }), {
      purpose: 'avatar',
    });
    expect(next.body.content_type).toBe('image/jpeg');
    await app.call('PATCH', '/api/me', { token: lin.token, body: { avatar_file_id: next.body.id } });
    const [old] = await getDb().select().from(files).where(eq(files.id, picture.body.id));
    expect(old!.status).toBe('deleted');
    expect((await fetchUrl(app, seen.avatar_url)).status).toBe(404);

    // Removing it deletes it too.
    const removed = await app.call('PATCH', '/api/me', { token: lin.token, body: { avatar_file_id: null } });
    expect(removed.body.avatar_url).toBeNull();
    const [gone] = await getDb().select().from(files).where(eq(files.id, next.body.id));
    expect(gone!.status).toBe('deleted');
  });

  it('accepts only my own pictures, really images, uploaded as avatars', async () => {
    const app = setup();
    const lin = await app.member();
    const chen = await app.member();
    const fake = await upload(app, lin.token, new File(['<html>'], 'a.png', { type: 'image/png' }), {
      purpose: 'avatar',
    });
    expect(fake.status).toBe(400);
    const attachment = await upload(app, lin.token, new File([PNG], 'a.png', { type: 'image/png' }));
    const notAvatar = await app.call('PATCH', '/api/me', {
      token: lin.token,
      body: { avatar_file_id: attachment.body.id },
    });
    expect(notAvatar.status).toBe(400);
    const chens = await upload(app, chen.token, new File([PNG], 'c.png', { type: 'image/png' }), {
      purpose: 'avatar',
    });
    expect(
      (await app.call('PATCH', '/api/me', { token: lin.token, body: { avatar_file_id: chens.body.id } })).status,
    ).toBe(404);
  });
});

describe('the workspace logo', () => {
  it('is set by an admin and loads on the sign-in page without anyone signed in', async () => {
    const app = setup();
    const admin = await app.member('admin');
    const lin = await app.member();
    // Only admins upload a logo.
    expect(
      (await upload(app, lin.token, new File([PNG], 'logo.png', { type: 'image/png' }), { purpose: 'branding' }))
        .status,
    ).toBe(403);
    const logo = await upload(app, admin.token, new File([PNG], 'logo.png', { type: 'image/png' }), {
      purpose: 'branding',
    });
    const branded = await app.call('PATCH', '/api/admin/branding', {
      token: admin.token,
      body: { logo_file_id: logo.body.id },
    });
    expect(branded.status).toBe(200);
    const [record] = await getDb().select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
    expect(record).toMatchObject({ action: 'workspace.branding', summary: 'logo_file_id' });

    const bootstrap = await app.call('GET', '/api/bootstrap');
    expect(bootstrap.body.logo_url).toMatch(/^\/api\/files\/fil_\w+\/content\?exp=\d+&sig=/);
    expect(bootstrap.body.logo_url).not.toContain('m=');
    const image = await fetchUrl(app, bootstrap.body.logo_url);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');

    // An unsigned-for-anyone URL opens only the logo, nothing else.
    const other = await upload(app, admin.token, new File([PNG], 'x.png', { type: 'image/png' }));
    expect((await fetchUrl(app, app.services.files.signedUrl(other.body.id, null).url)).status).toBe(404);

    // Removing it deletes the file, and its URL stops working.
    const cleared = await app.call('PATCH', '/api/admin/branding', {
      token: admin.token,
      body: { logo_file_id: null },
    });
    expect(cleared.body.logo_url).toBeNull();
    expect((await fetchUrl(app, bootstrap.body.logo_url)).status).toBe(404);
  });
});
