/**
 * The reference use of plugin objects: a note's picture goes up through an upload target,
 * is size-checked against the store, and comes back as a short-lived inline URL. On the
 * local-disk backend the target is an /api/ext-objects ticket, so the whole round trip
 * runs here without a bucket.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Before any import: storage and the extension list are chosen when their modules load.
vi.hoisted(() => {
  process.env.GREENHOUSE_EXTENSIONS = 'example';
  for (const key of Object.keys(process.env))
    if (key.startsWith('TENCENT_CLOUD_COS_') || key.startsWith('STORAGE_S3_')) delete process.env[key];
  process.env.TOKEN_SIGNING_KEY ??= '5c'.repeat(32);
});

import { Hono } from 'hono';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../../../apps/api/src/app-env.js';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import { extensionMigrationSources } from '../../../../apps/api/src/plugin-host/boot.js';
import { EXTENSIONS } from '../../../../apps/api/src/plugin-host/index.js';
import {
  initializePlatformRuntime,
  resetPlatformRuntimeForTests,
} from '../../../../apps/api/src/plugin-host/runtime.js';
import extObjectRoutes from '../../../../apps/api/src/routes/ext-objects.js';
import { UPLOADS_DIR } from '../../../../apps/api/src/paths.js';

afterAll(() => {
  delete process.env.GREENHOUSE_EXTENSIONS;
  const namespace = resolve(UPLOADS_DIR, 'drive/plugins/example');
  if (existsSync(namespace)) rmSync(namespace, { recursive: true, force: true });
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const extension = EXTENSIONS.find((ext) => ext.id === 'example')!;
let db: DatabaseProvider, alice: UserRow, bob: UserRow;

function app(user: UserRow) {
  const app = new Hono<AppEnv>().use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role });
    await next();
  });
  for (const route of extension.routes ?? []) app.route(route.path, route.app);
  app.route('/api/ext-objects', extObjectRoutes);
  return app;
}
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(
    db,
    EXTENSIONS.flatMap((ext) => ext.applications ?? []),
  );
  await db.extensionMigrations.apply(extensionMigrationSources());
  alice = await createInternalTestUser(db, { email: `pic-alice-${crypto.randomUUID()}@test.local` });
  bob = await createInternalTestUser(db, { email: `pic-bob-${crypto.randomUUID()}@test.local` });
  for (const user of [alice, bob])
    await db.userFeatures.upsert({ user_id: user.id, feature: 'example', enabled: true });
});
afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('a note with a picture', () => {
  it('uploads through its target, attaches after the size check and lists an inline URL', async () => {
    const api = app(alice);
    const { note } = (await (await api.request('/api/ext/example/notes', post({ body: 'with a picture' }))).json()) as {
      note: { id: number };
    };
    const started = await api.request(
      `/api/ext/example/notes/${note.id}/picture`,
      post({ content_type: 'image/png', size: PNG.length }),
    );
    expect(started.status).toBe(200);
    const { upload } = (await started.json()) as {
      upload: { url: string; method: string; headers: Record<string, string>; direct: boolean };
    };
    expect(upload).toMatchObject({ method: 'PUT', direct: false, headers: { 'Content-Type': 'image/png' } });

    // Not uploaded yet: nothing to attach.
    expect(
      (await api.request(`/api/ext/example/notes/${note.id}/picture/complete`, post({ content_type: 'image/png' })))
        .status,
    ).toBe(400);

    const put = await api.request(upload.url, {
      method: 'PUT',
      headers: { ...upload.headers, 'content-length': String(PNG.length) },
      body: PNG,
    });
    expect(put.status).toBe(200);

    const done = await api.request(
      `/api/ext/example/notes/${note.id}/picture/complete`,
      post({ content_type: 'image/png' }),
    );
    expect(done.status).toBe(200);
    const { picture_url } = (await done.json()) as { picture_url: string };

    const listed = (await (await api.request('/api/ext/example/notes')).json()) as {
      notes: Array<{ id: number; picture_url?: string }>;
    };
    const mine = listed.notes.find((n) => n.id === note.id)!;
    expect(mine.picture_url).toMatch(/^\/api\/ext-objects\//);

    const image = await api.request(picture_url);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-disposition')).toBe('inline');
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('refuses another member’s note, a non-image and an oversize declaration', async () => {
    const { note } = (await (
      await app(alice).request('/api/ext/example/notes', post({ body: 'alice only' }))
    ).json()) as { note: { id: number } };
    expect(
      (
        await app(bob).request(
          `/api/ext/example/notes/${note.id}/picture`,
          post({ content_type: 'image/png', size: 9 }),
        )
      ).status,
    ).toBe(404);
    for (const body of [
      { content_type: 'image/svg+xml', size: 9 },
      { content_type: 'image/png', size: 6 * 1024 * 1024 },
    ])
      expect((await app(alice).request(`/api/ext/example/notes/${note.id}/picture`, post(body))).status).toBe(400);
  });

  it('reports a missing vision provider as a provider error, not a crash', async () => {
    vi.stubEnv('MEDIA_API_KEY', '');
    vi.stubEnv('LLM_API_KEY', '');
    try {
      const api = app(alice);
      const { note } = (await (await api.request('/api/ext/example/notes', post({ body: 'describe me' }))).json()) as {
        note: { id: number };
      };
      const { upload } = (await (
        await api.request(
          `/api/ext/example/notes/${note.id}/picture`,
          post({ content_type: 'image/png', size: PNG.length }),
        )
      ).json()) as { upload: { url: string; headers: Record<string, string> } };
      await api.request(upload.url, {
        method: 'PUT',
        headers: { ...upload.headers, 'content-length': String(PNG.length) },
        body: PNG,
      });
      await api.request(`/api/ext/example/notes/${note.id}/picture/complete`, post({ content_type: 'image/png' }));
      const described = await api.request(`/api/ext/example/notes/${note.id}/picture/describe`, post({}));
      expect(described.status).toBe(502);
      expect(((await described.json()) as { error: string }).error).toMatch(/MEDIA_API_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
