/**
 * The asset library end to end on the local-disk backend: uploads through ticket targets,
 * de-duplication, who may edit and delete, search and facets, near duplicates, the AI
 * queue (vision mocked at the kit boundary), byte verification, cleanup and the agent tool.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith('TENCENT_CLOUD_COS_') || key.startsWith('STORAGE_S3_')) delete process.env[key];
  process.env.TOKEN_SIGNING_KEY ??= '6d'.repeat(32);
});

const vision = vi.hoisted(() => ({ calls: [] as unknown[], reply: {} as unknown, fail: null as Error | null }));
vi.mock('@greenhouse/api/extension-kit', async (original) => ({
  ...(await original<typeof import('@greenhouse/api/extension-kit')>()),
  analyzeImages: vi.fn(async (input: unknown) => {
    vision.calls.push(input);
    if (vision.fail) throw vision.fail;
    return { text: JSON.stringify(vision.reply), json: vision.reply, model: 'vision-test', durationMs: 1, usage: {} };
  }),
}));

import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
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
import { objectKeys } from '../model.js';
import { assetStore } from '../services.js';
import { runAiQueue, runCleanup, runVerification } from '../worker.js';
import { createAssetsQueryTool } from '../tool.js';
import { objects } from '../ai.js';

afterAll(() => {
  const namespace = resolve(UPLOADS_DIR, 'drive/plugins/assets');
  if (existsSync(namespace)) rmSync(namespace, { recursive: true, force: true });
});

const extension = EXTENSIONS.find((ext) => ext.id === 'assets')!;
let db: DatabaseProvider, alice: UserRow, bob: UserRow, admin: UserRow;

function app(user: UserRow) {
  const app = new Hono<AppEnv>().use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role } as AppEnv['Variables']['user']);
    await next();
  });
  for (const route of extension.routes ?? []) {
    for (const guard of route.guards ?? []) app.use(`${route.path}/*`, guard);
    app.route(route.path, route.app);
  }
  app.route('/api/ext-objects', extObjectRoutes);
  return app;
}
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// Minimal JPEG: SOI + APP0 marker, enough for magic-byte checks; contents are opaque here.
const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from(seed)]);

interface Target {
  url: string;
  headers: Record<string, string>;
}

async function put(api: Hono<AppEnv>, target: Target, body: Buffer) {
  const res = await api.request(target.url, {
    method: 'PUT',
    headers: { ...target.headers, 'content-length': String(body.length) },
    body: new Uint8Array(body),
  });
  expect(res.status, `PUT ${target.url}`).toBe(200);
}

/** The browser's part of an upload: start, PUT every target, complete. */
async function upload(
  user: UserRow,
  file: Buffer,
  extra: Record<string, unknown> = {},
  opts: { preview?: boolean; skipOriginal?: boolean } = {},
) {
  const api = app(user);
  const preview = opts.preview ?? true;
  const res = await api.request(
    '/api/ext/assets/uploads',
    json('POST', {
      sha256: sha(file),
      size: file.length,
      filename: 'basil-kitchen.jpg',
      content_type: 'image/jpeg',
      width: 1600,
      height: 900,
      has_preview: preview,
      frame_count: 0,
      ...extra,
    }),
  );
  const started = (await res.json()) as {
    status: string;
    asset: { id: string };
    targets?: { original: Target; thumb?: Target; preview?: Target };
    error?: string;
  };
  if (started.status !== 'upload') return { res, started };
  if (!opts.skipOriginal) await put(api, started.targets!.original, file);
  if (preview) {
    await put(api, started.targets!.thumb!, jpeg('thumb'));
    await put(api, started.targets!.preview!, jpeg('preview'));
  }
  const done = await api.request(`/api/ext/assets/assets/${started.asset.id}/complete`, json('POST'));
  return { res, started, done };
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(
    db,
    EXTENSIONS.flatMap((ext) => ext.applications ?? []),
  );
  await db.extensionMigrations.apply(extensionMigrationSources());
  alice = await createInternalTestUser(db, { email: `assets-alice-${crypto.randomUUID()}@test.local` });
  bob = await createInternalTestUser(db, { email: `assets-bob-${crypto.randomUUID()}@test.local` });
  admin = await createInternalTestUser(db, { email: `assets-super-${crypto.randomUUID()}@test.local`, role: 'super' });
  vision.calls = [];
  vision.reply = {};
  vision.fail = null;
});
afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('uploading', () => {
  it('stores a new file once and lists it with a thumbnail', async () => {
    const file = jpeg(`one-${crypto.randomUUID()}`);
    const { started, done } = await upload(alice, file, { title: '厨房里的罗勒', tags: ['kitchen'] });
    expect(started.status).toBe('upload');
    expect(done!.status).toBe(200);
    const asset = await assetStore(db).get(started.asset.id);
    expect(asset).toMatchObject({ status: 'active', ai_status: 'pending', display_title: '厨房里的罗勒' });
    expect(await objects.head(objectKeys.original(asset!.sha256, 'jpg'))).toEqual({ size: file.length });

    const list = (await (await app(bob).request('/api/ext/assets/assets')).json()) as {
      items: Array<{ id: string; thumb_url: string | null }>;
      total: number;
    };
    const item = list.items.find((i) => i.id === asset!.id)!;
    expect(item.thumb_url).toMatch(/^\/api\/ext-objects\//);
    const thumb = await app(bob).request(item.thumb_url!);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
  });

  it('lets browsers write only staging keys and publishes them on complete', async () => {
    const file = jpeg(`staging-${crypto.randomUUID()}`);
    const { started, done } = await upload(alice, file);
    const ticket = JSON.parse(
      Buffer.from(started.targets!.original.url.split('/').pop()!.split('.')[0]!, 'base64url').toString(),
    ) as { k: string };
    expect(ticket.k).toMatch(new RegExp(`^staging/${started.asset.id}/[0-9a-z]+/original\\.jpg$`));
    expect(done!.status).toBe(200);
    expect(await objects.head(objectKeys.original(sha(file), 'jpg'))).toEqual({ size: file.length });
    expect(await objects.list(objectKeys.stagingRoot(started.asset.id))).toEqual([]);
  });

  it('recognises the same bytes from anyone: no second copy, the uploader and empty fields are added', async () => {
    const file = jpeg(`dup-${crypto.randomUUID()}`);
    const first = await upload(alice, file, { tags: ['a'] });
    const check = (await (
      await app(bob).request(
        '/api/ext/assets/uploads/check',
        json('POST', { items: [{ sha256: sha(file), size: file.length }] }),
      )
    ).json()) as { results: Array<{ exists: boolean; asset?: { id: string } }> };
    expect(check.results[0]).toMatchObject({ exists: true, asset: { id: first.started.asset.id } });

    const second = await upload(bob, file, { title: 'Bob title', tags: ['b'] });
    expect(second.started.status).toBe('duplicate');
    expect(second.started.asset.id).toBe(first.started.asset.id);
    const store = assetStore(db);
    const asset = (await store.get(first.started.asset.id))!;
    expect(asset.title).toBe('Bob title');
    expect(asset.tags).toEqual(['a', 'b']);
    expect((await store.uploaders(asset.id)).map((u) => u.user_id).sort()).toEqual([alice.id, bob.id].sort());
    const rows = await db.executeRaw(sql`SELECT count(*)::int AS n FROM ext_assets_assets WHERE sha256 = ${sha(file)}`);
    expect((rows as Array<{ n: number }>)[0]!.n).toBe(1);
  });

  it('settles a race on the unique fingerprint', async () => {
    const store = assetStore(db);
    const base = {
      kind: 'image' as const,
      sha256: sha(Buffer.from(crypto.randomUUID())),
      size: 10,
      content_type: 'image/jpeg',
      ext: 'jpg',
      original_name: 'x.jpg',
      has_preview: false,
      frame_count: 0,
    };
    expect(await store.insertUploading({ ...base, uploaded_by: alice.id })).not.toBeNull();
    expect(await store.insertUploading({ ...base, uploaded_by: bob.id })).toBeNull();
  });

  it('refuses to complete a missing or short original, and unsupported or oversized files', async () => {
    const file = jpeg(`missing-${crypto.randomUUID()}`);
    const { done } = await upload(alice, file, {}, { preview: false, skipOriginal: true });
    expect(done!.status).toBe(400);
    const api = app(alice);
    const svg = await api.request(
      '/api/ext/assets/uploads',
      json('POST', {
        sha256: sha(file),
        size: 10,
        filename: 'x.svg',
        content_type: 'image/svg+xml',
        has_preview: false,
        frame_count: 0,
      }),
    );
    expect(svg.status).toBe(415);
    const huge = await api.request(
      '/api/ext/assets/uploads',
      json('POST', {
        sha256: sha(Buffer.from('huge')),
        size: 200 * 1024 * 1024,
        filename: 'x.jpg',
        content_type: 'image/jpeg',
        has_preview: false,
        frame_count: 0,
      }),
    );
    expect(huge.status).toBe(413);
  });

  it('treats undelivered previews as no preview and skips AI for it', async () => {
    const file = jpeg(`nopreview-${crypto.randomUUID()}`);
    const api = app(alice);
    const started = (await (
      await api.request(
        '/api/ext/assets/uploads',
        json('POST', {
          sha256: sha(file),
          size: file.length,
          filename: 'a.jpg',
          content_type: 'image/jpeg',
          has_preview: true,
          frame_count: 0,
        }),
      )
    ).json()) as { asset: { id: string }; targets: { original: Target } };
    await put(api, started.targets.original, file);
    expect((await api.request(`/api/ext/assets/assets/${started.asset.id}/complete`, json('POST'))).status).toBe(200);
    expect(await assetStore(db).get(started.asset.id)).toMatchObject({ has_preview: false, ai_status: 'skipped' });
  });
});

describe('the bin and removals stay consistent', () => {
  it('tells members only that binned content exists, and managers what it is', async () => {
    const file = jpeg(`binned-${crypto.randomUUID()}`);
    const { started } = await upload(alice, file);
    await assetStore(db).softDelete(started.asset.id, admin.id);
    const ask = async (user: UserRow) =>
      (
        (await (
          await app(user).request(
            '/api/ext/assets/uploads/check',
            json('POST', { items: [{ sha256: sha(file), size: file.length }] }),
          )
        ).json()) as { results: Array<{ exists: boolean; binned?: boolean; asset?: unknown }> }
      ).results[0]!;
    expect(await ask(bob)).toEqual({ sha256: sha(file), exists: true, binned: true });
    expect((await ask(admin)).asset).toBeTruthy();
    const again = await upload(bob, file);
    expect(again.started).toMatchObject({ status: 'binned', asset: null });
  });

  it('refuses to merge into an asset that left the library', async () => {
    const a = await upload(alice, jpeg(`m-a-${crypto.randomUUID()}`), { phash: 'f0f0f0f0f0f0f0f0' });
    const b = await upload(alice, jpeg(`m-b-${crypto.randomUUID()}`), { phash: 'f0f0f0f0f0f0f0f1' });
    await assetStore(db).softDelete(a.started.asset.id, admin.id);
    const merged = await app(admin).request(
      '/api/ext/assets/duplicates/merge',
      json('POST', { keep: a.started.asset.id, drop: b.started.asset.id }),
    );
    expect(merged.status).toBe(404);
    expect((await assetStore(db).get(b.started.asset.id))!.status).toBe('active');
  });

  it('blocks completing, restoring or re-uploading a row being purged', async () => {
    const file = jpeg(`purge-${crypto.randomUUID()}`);
    const api = app(alice);
    const started = (await (
      await api.request(
        '/api/ext/assets/uploads',
        json('POST', {
          sha256: sha(file),
          size: file.length,
          filename: 'p.jpg',
          content_type: 'image/jpeg',
          has_preview: false,
          frame_count: 0,
        }),
      )
    ).json()) as { asset: { id: string }; targets: { original: Target } };
    await put(api, started.targets.original, file);
    const store = assetStore(db);
    await db.executeRaw(
      sql`UPDATE ext_assets_assets SET updated_at = now() - interval '2 days' WHERE id = ${started.asset.id}`,
    );
    expect(
      await store.claimPurge(started.asset.id, ['uploading'], { untouchedSince: new Date().toISOString() }),
    ).toBeTruthy();
    expect((await api.request(`/api/ext/assets/assets/${started.asset.id}/complete`, json('POST'))).status).toBe(404);
    const retry = await api.request(
      '/api/ext/assets/uploads',
      json('POST', {
        sha256: sha(file),
        size: file.length,
        filename: 'p.jpg',
        content_type: 'image/jpeg',
        has_preview: false,
        frame_count: 0,
      }),
    );
    expect(retry.status).toBe(409);
    expect(await store.restore(started.asset.id)).toBeUndefined();
  });

  it('keeps an upload whose owner just got fresh targets out of the stale sweep', async () => {
    const store = assetStore(db);
    const row = await store.insertUploading({
      kind: 'image',
      sha256: sha(Buffer.from(`fresh-${crypto.randomUUID()}`)),
      size: 3,
      content_type: 'image/jpeg',
      ext: 'jpg',
      original_name: 'fresh.jpg',
      has_preview: false,
      frame_count: 0,
      uploaded_by: alice.id,
    });
    await db.executeRaw(sql`UPDATE ext_assets_assets SET updated_at = now() - interval '2 days' WHERE id = ${row!.id}`);
    // The owner starts a new attempt just before the sweep: the row is in use again.
    expect(await store.renewUpload(row!.id)).toBeTruthy();
    await runCleanup();
    expect((await store.get(row!.id))!.status).toBe('uploading');
  });
});

describe('who may change what', () => {
  it('lets uploaders and managers edit, only managers delete, and hides the bin from members', async () => {
    const { started } = await upload(alice, jpeg(`perm-${crypto.randomUUID()}`));
    const id = started.asset.id;
    expect((await app(bob).request(`/api/ext/assets/assets/${id}`, json('PATCH', { title: 'nope' }))).status).toBe(403);
    expect((await app(alice).request(`/api/ext/assets/assets/${id}`, json('PATCH', { title: 'mine' }))).status).toBe(
      200,
    );
    expect((await app(admin).request(`/api/ext/assets/assets/${id}`, json('PATCH', { source: 'shoot' }))).status).toBe(
      200,
    );
    expect((await app(alice).request(`/api/ext/assets/assets/${id}`, json('DELETE'))).status).toBe(403);
    expect((await app(bob).request('/api/ext/assets/assets?status=deleted')).status).toBe(403);

    await db.userFeatures.upsert({ user_id: bob.id, feature: 'assets_manage', enabled: true });
    expect((await app(bob).request(`/api/ext/assets/assets/${id}`, json('DELETE'))).status).toBe(200);
    expect((await app(alice).request(`/api/ext/assets/assets/${id}`)).status).toBe(404);
    const bin = (await (await app(bob).request('/api/ext/assets/assets?status=deleted')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(bin.items.map((i) => i.id)).toContain(id);
    expect((await app(bob).request(`/api/ext/assets/assets/${id}/restore`, json('POST'))).status).toBe(200);
    expect((await app(alice).request(`/api/ext/assets/assets/${id}`)).status).toBe(200);
  });

  it('turns members away without the feature', async () => {
    await db.userFeatures.upsert({ user_id: bob.id, feature: 'assets', enabled: false });
    expect((await app(bob).request('/api/ext/assets/assets')).status).toBe(403);
  });
});

describe('finding assets', () => {
  it('searches Chinese titles and AI text, and filters by facets including AI suggestions', async () => {
    await app(admin).request(
      '/api/ext/assets/facets',
      json('PUT', {
        facets: [
          {
            key: 'plant',
            label_en: 'Plant',
            label_zh: '植物',
            multiple: true,
            values: [{ value: 'basil', zh: '罗勒' }, { value: 'mint' }],
          },
        ],
      }),
    );
    const marker = crypto.randomUUID().slice(0, 8);
    const one = await upload(alice, jpeg(`s1-${marker}`), {
      title: `阳台上的罗勒 ${marker}`,
      facets: { plant: ['basil'] },
    });
    const two = await upload(alice, jpeg(`s2-${marker}`), { title: `薄荷 ${marker}` });
    await assetStore(db).saveAi(two.started.asset.id, {
      title: null,
      caption: null,
      tags: [],
      text: `SALE ${marker}`,
      facets: { plant: ['mint'] },
      people: false,
      model: 'm',
    });
    const search = async (query: string) =>
      (
        (await (await app(bob).request(`/api/ext/assets/assets?${query}`)).json()) as { items: Array<{ id: string }> }
      ).items.map((i) => i.id);
    expect(await search(`q=${encodeURIComponent(`罗勒 ${marker}`)}`)).toEqual([one.started.asset.id]);
    expect(await search(`q=${encodeURIComponent(`SALE ${marker}`)}`)).toEqual([two.started.asset.id]);
    const byFacet = await search(`facets=${encodeURIComponent(JSON.stringify({ plant: ['mint'] }))}`);
    expect(byFacet).toContain(two.started.asset.id);
    expect(byFacet).not.toContain(one.started.asset.id);
    expect((await app(bob).request('/api/ext/assets/assets?facets=not-json')).status).toBe(400);
  });

  it('answers the agent tool with links and refuses an unreadable id', async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const { started } = await upload(alice, jpeg(`tool-${marker}`), { title: `Tool ${marker}` });
    const tool = createAssetsQueryTool({ userId: bob.id });
    const found = (await tool.execute!(
      { action: 'search', query: `Tool ${marker}` },
      { toolCallId: 't', messages: [] },
    )) as {
      results: Array<{ id: string; url: string }>;
    };
    expect(found.results[0]).toMatchObject({ id: started.asset.id, url: `#/ext/assets/asset/${started.asset.id}` });
    const missing = (await tool.execute!({ action: 'get', id: 'ast_missing' }, { toolCallId: 't', messages: [] })) as {
      error?: string;
    };
    expect(missing.error).toBeTruthy();
  });
});

describe('near duplicates', () => {
  it('pairs look-alikes by dHash and merges uploaders into the kept asset', async () => {
    const a = await upload(alice, jpeg(`nd-a-${crypto.randomUUID()}`), { phash: '0f0f0f0f0f0f0f0f' });
    const b = await upload(bob, jpeg(`nd-b-${crypto.randomUUID()}`), { phash: '0f0f0f0f0f0f0f0e' });
    const pairs = (await (await app(admin).request('/api/ext/assets/duplicates')).json()) as {
      pairs: Array<{ a: { id: string }; b: { id: string } }>;
    };
    expect(
      pairs.pairs.some(
        (p) => [p.a.id, p.b.id].sort().join() === [a.started.asset.id, b.started.asset.id].sort().join(),
      ),
    ).toBe(true);
    expect((await app(alice).request('/api/ext/assets/duplicates')).status).toBe(403);
    const merged = await app(admin).request(
      '/api/ext/assets/duplicates/merge',
      json('POST', { keep: a.started.asset.id, drop: b.started.asset.id }),
    );
    expect(merged.status).toBe(200);
    const store = assetStore(db);
    expect((await store.get(b.started.asset.id))!.status).toBe('deleted');
    expect((await store.uploaders(a.started.asset.id)).map((u) => u.user_id)).toContain(bob.id);
  });
});

describe('background work', () => {
  it('catalogues with AI into the AI fields, charged to the uploader, never over member fields', async () => {
    const { started } = await upload(alice, jpeg(`ai-${crypto.randomUUID()}`), { title: 'Kept title' });
    vision.reply = {
      title: 'AI title',
      caption: '一盆罗勒',
      tags: ['罗勒', '厨房'],
      text: '',
      facets: {},
      people: false,
    };
    // Rows from earlier cases in this worker may queue ahead of ours; drain until ours ran.
    for (let i = 0; i < 20 && (await assetStore(db).get(started.asset.id))!.ai_status !== 'done'; i++)
      await runAiQueue(50);
    const asset = (await assetStore(db).get(started.asset.id))!;
    expect(asset).toMatchObject({
      ai_status: 'done',
      ai_title: 'AI title',
      ai_caption: '一盆罗勒',
      title: 'Kept title',
    });
    expect(vision.calls.some((c) => (c as { userId: string }).userId === alice.id)).toBe(true);
  });

  it('marks a failed vision call and lets an uploader retry it', async () => {
    const { started } = await upload(alice, jpeg(`aifail-${crypto.randomUUID()}`));
    vision.fail = new Error('provider down');
    for (let i = 0; i < 20 && (await assetStore(db).get(started.asset.id))!.ai_status === 'pending'; i++)
      await runAiQueue(50);
    expect(await assetStore(db).get(started.asset.id)).toMatchObject({
      ai_status: 'failed',
      ai_error: 'provider down',
    });
    expect((await app(bob).request(`/api/ext/assets/assets/${started.asset.id}/ai/retry`, json('POST'))).status).toBe(
      403,
    );
    expect((await app(alice).request(`/api/ext/assets/assets/${started.asset.id}/ai/retry`, json('POST'))).status).toBe(
      200,
    );
    expect((await assetStore(db).get(started.asset.id))!.ai_status).toBe('pending');
  });

  it('verifies stored bytes and drops an upload whose bytes do not match its fingerprint', async () => {
    const good = await upload(alice, jpeg(`v-good-${crypto.randomUUID()}`));
    const liar = jpeg(`v-claimed-${crypto.randomUUID()}`);
    const forged = await upload(alice, jpeg(`v-real-${crypto.randomUUID()}`), { sha256: sha(liar) });
    // The forged row claims liar's hash while its original holds other bytes.
    expect(forged.started.status).toBe('upload');
    for (let i = 0; i < 30; i++) {
      const store = assetStore(db);
      const [g, f] = [await store.get(good.started.asset.id), await store.get(forged.started.asset.id)];
      if (g?.verified_at && f?.status === 'invalid') break;
      await runVerification(50);
    }
    const store = assetStore(db);
    expect((await store.get(good.started.asset.id))!.verified_at).not.toBeNull();
    const forgedRow = (await store.get(forged.started.asset.id))!;
    expect(forgedRow.status).toBe('invalid');
    expect(await objects.head(objectKeys.original(forgedRow.sha256, 'jpg'))).toBeNull();
  });

  it('cleans up abandoned uploads and empties the bin after 30 days', async () => {
    const store = assetStore(db);
    const stale = await store.insertUploading({
      kind: 'image',
      sha256: sha(Buffer.from(`stale-${crypto.randomUUID()}`)),
      size: 3,
      content_type: 'image/jpeg',
      ext: 'jpg',
      original_name: 'stale.jpg',
      has_preview: false,
      frame_count: 0,
      uploaded_by: alice.id,
    });
    const { started } = await upload(alice, jpeg(`bin-${crypto.randomUUID()}`));
    await store.softDelete(started.asset.id, admin.id);
    await db.executeRaw(
      sql`UPDATE ext_assets_assets SET updated_at = now() - interval '2 days', deleted_at = now() - interval '31 days' WHERE id IN (${stale!.id}, ${started.asset.id})`,
    );
    await runCleanup();
    expect(await store.get(stale!.id)).toBeUndefined();
    expect(await store.get(started.asset.id)).toBeUndefined();
  });
});

describe('collections', () => {
  it('lets anyone add, and only the creator or a manager rename or remove', async () => {
    const { started } = await upload(alice, jpeg(`col-${crypto.randomUUID()}`));
    const { collection } = (await (
      await app(alice).request('/api/ext/assets/collections', json('POST', { name: '春季上新' }))
    ).json()) as { collection: { id: string } };
    expect(
      (
        await app(bob).request(
          `/api/ext/assets/collections/${collection.id}/items`,
          json('POST', { asset_ids: [started.asset.id] }),
        )
      ).status,
    ).toBe(200);
    const inside = (await (await app(bob).request(`/api/ext/assets/assets?collection=${collection.id}`)).json()) as {
      items: Array<{ id: string }>;
    };
    expect(inside.items.map((i) => i.id)).toEqual([started.asset.id]);
    expect(
      (await app(bob).request(`/api/ext/assets/collections/${collection.id}`, json('PATCH', { name: 'x' }))).status,
    ).toBe(403);
    expect((await app(alice).request(`/api/ext/assets/collections/${collection.id}`, json('DELETE'))).status).toBe(200);
  });
});
