import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSkillStore, resolveSkillStoreFromEnv, storageKeyFor } from './store.js';

describe('storageKeyFor', () => {
  it('builds the backend-agnostic key', () => {
    expect(storageKeyFor('pdf-report', '1.2.3')).toBe('pdf-report/1.2.3.json');
  });
});

describe('local skill store', () => {
  const dirs: string[] = [];
  const tempStore = () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-store-'));
    dirs.push(dir);
    return { store: createLocalSkillStore(dir), dir };
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips put/get/delete', async () => {
    const { store, dir } = tempStore();
    const key = storageKeyFor('pdf-report', '1.0.0');
    await store.put(key, '{"format":1}');
    expect(existsSync(join(dir, 'pdf-report', '1.0.0.json'))).toBe(true);
    expect(await store.get(key)).toBe('{"format":1}');

    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await expect(store.delete(key)).resolves.toBeUndefined(); // idempotent
  });

  it('refuses unsafe keys (defense in depth — names/versions are validated upstream)', async () => {
    const { store } = tempStore();
    for (const bad of ['../escape.json', 'name/1.0.0.txt', 'UPPER/1.0.0.json', 'a/b/1.0.0.json', 'a/1.0.json']) {
      await expect(store.put(bad, 'x'), bad).rejects.toThrow(/Invalid skill storage key/);
    }
  });
});

describe('resolveSkillStoreFromEnv', () => {
  it('defaults to local disk when no SKILLS_S3_* is set', () => {
    expect(resolveSkillStoreFromEnv({}).backend).toBe('local');
  });

  it('selects S3 when the four required vars are present', () => {
    const store = resolveSkillStoreFromEnv({
      SKILLS_S3_ENDPOINT: 'http://127.0.0.1:9000',
      SKILLS_S3_BUCKET: 'example-bucket',
      SKILLS_S3_ACCESS_KEY_ID: 'ak',
      SKILLS_S3_SECRET_ACCESS_KEY: 'sk',
    });
    expect(store.backend).toBe('s3');
  });

  it('fails loud on partial S3 config instead of silently falling back', () => {
    expect(() =>
      resolveSkillStoreFromEnv({ SKILLS_S3_ENDPOINT: 'http://127.0.0.1:9000', SKILLS_S3_BUCKET: 'example-bucket' }),
    ).toThrow(/partial SKILLS_S3_\* config.*SKILLS_S3_ACCESS_KEY_ID/s);
  });
});

describe('core S3 fallback', () => {
  const core = {
    STORAGE_S3_ENDPOINT: 'http://127.0.0.1:9000',
    STORAGE_S3_BUCKET: 'core',
    STORAGE_S3_ACCESS_KEY_ID: 'key',
    STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
  };
  afterEach(() => vi.unstubAllGlobals());
  it('uses core credentials and skills/ without changing the stored version key', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', request);
    const store = resolveSkillStoreFromEnv(core);
    expect(store.backend).toBe('s3');
    const key = storageKeyFor('portable', '1.0.0');
    await store.put(key, '{}');
    expect(request.mock.calls[0][0]).toBe('http://127.0.0.1:9000/core/skills/portable/1.0.0.json');
    expect(await store.get(key)).toBe('{}');
  });
  it('dedicated SKILLS_S3_* takes precedence and keeps its configured prefix', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', request);
    const store = resolveSkillStoreFromEnv({
      ...core,
      SKILLS_S3_ENDPOINT: 'https://skills.example',
      SKILLS_S3_BUCKET: 'dedicated',
      SKILLS_S3_ACCESS_KEY_ID: 'own',
      SKILLS_S3_SECRET_ACCESS_KEY: 'secret',
      SKILLS_S3_PREFIX: 'packs',
    });
    await store.delete('portable/1.0.0.json');
    expect(request.mock.calls[0][0]).toBe('https://skills.example/dedicated/packs/portable/1.0.0.json');
  });
  it('does not hide partial dedicated or core configuration behind a fallback', () => {
    expect(() => resolveSkillStoreFromEnv({ ...core, SKILLS_S3_BUCKET: 'partial' })).toThrow(/partial SKILLS_S3/);
    expect(() => resolveSkillStoreFromEnv({ STORAGE_S3_BUCKET: 'partial' })).toThrow(/partial STORAGE_S3/);
  });
});
