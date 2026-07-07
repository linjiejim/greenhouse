/**
 * Skill store — where version payload bundles live.
 *
 * One JSON object per published version, addressed by a backend-agnostic key
 * `<name>/<version>.json` (recorded in agent_skill_versions.storage_key,
 * portable across backends). Two backends, selected ONCE at first use:
 *
 * - S3-compatible object storage (preferred) when all four SKILLS_S3_* vars are
 *   set — see s3-lite.ts. A PARTIAL config is a hard error: silently falling
 *   back to disk would strand new bundles outside the store the admin asked for.
 * - Local disk under data/skills/ (default) — zero config, single-instance.
 *
 * Why not the uploads StorageDriver seam (storage/extensions.ts): that global
 * is the UPLOADS backend and is fork-owned (registerStorageDriver, empty
 * upstream). Skills need an upstream-configured backend of their own without
 * hijacking uploads; only the put/get/delete *shape* is mirrored here.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SKILLS_DIR } from '../paths.js';
import { createS3Client, type S3LiteClient } from '../storage/s3-lite.js';

export interface SkillStore {
  backend: 'local' | 's3';
  put(key: string, json: string): Promise<void>;
  /** null when the bundle does not exist. */
  get(key: string): Promise<string | null>;
  /** Idempotent — missing objects are not an error. */
  delete(key: string): Promise<void>;
}

/** Backend-agnostic storage key for a version's bundle. */
export function storageKeyFor(name: string, version: string): string {
  return `${name}/${version}.json`;
}

// Keys are derived from validated skill names + semver strings, but the store
// re-guards anyway — it must be safe even if a future caller feeds it a raw key.
const KEY_RE = /^[a-z0-9][a-z0-9-]*\/[0-9]+\.[0-9]+\.[0-9]+\.json$/;

function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`Invalid skill storage key: "${key}"`);
}

// ─── Local disk backend ──────────────────────────────────

export function createLocalSkillStore(baseDir: string = SKILLS_DIR): SkillStore {
  return {
    backend: 'local',
    async put(key, json) {
      assertSafeKey(key);
      const filePath = resolve(baseDir, key);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, json, 'utf8');
    },
    async get(key) {
      assertSafeKey(key);
      const filePath = resolve(baseDir, key);
      return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    },
    async delete(key) {
      assertSafeKey(key);
      const filePath = resolve(baseDir, key);
      if (existsSync(filePath)) unlinkSync(filePath);
    },
  };
}

// ─── S3 backend ──────────────────────────────────────────

function createS3SkillStore(client: S3LiteClient, prefix: string): SkillStore {
  return {
    backend: 's3',
    async put(key, json) {
      assertSafeKey(key);
      await client.putObject(`${prefix}${key}`, json, 'application/json');
    },
    async get(key) {
      assertSafeKey(key);
      const buf = await client.getObject(`${prefix}${key}`);
      return buf ? buf.toString('utf8') : null;
    },
    async delete(key) {
      assertSafeKey(key);
      await client.deleteObject(`${prefix}${key}`);
    },
  };
}

// ─── Backend selection (env, memoized) ───────────────────

const S3_VARS = [
  'SKILLS_S3_ENDPOINT',
  'SKILLS_S3_BUCKET',
  'SKILLS_S3_ACCESS_KEY_ID',
  'SKILLS_S3_SECRET_ACCESS_KEY',
] as const;

/** Exported for the doctor/tests — resolves which backend the env selects. */
export function resolveSkillStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SkillStore {
  const present = S3_VARS.filter((v) => (env[v] ?? '').trim() !== '');
  if (present.length === 0) return createLocalSkillStore();
  if (present.length < S3_VARS.length) {
    const missing = S3_VARS.filter((v) => !present.includes(v));
    throw new Error(`Skill store: partial SKILLS_S3_* config — missing ${missing.join(', ')}`);
  }
  const client = createS3Client({
    endpoint: env.SKILLS_S3_ENDPOINT!,
    region: env.SKILLS_S3_REGION?.trim() || 'us-east-1',
    bucket: env.SKILLS_S3_BUCKET!,
    accessKeyId: env.SKILLS_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.SKILLS_S3_SECRET_ACCESS_KEY!,
    forcePathStyle: env.SKILLS_S3_FORCE_PATH_STYLE?.trim().toLowerCase() !== 'false',
  });
  const rawPrefix = env.SKILLS_S3_PREFIX?.trim() ?? 'skills/';
  const prefix = rawPrefix === '' || rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
  return createS3SkillStore(client, prefix);
}

let store: SkillStore | null = null;

export function getSkillStore(): SkillStore {
  if (!store) store = resolveSkillStoreFromEnv();
  return store;
}

/** Test seam — drop the memoized backend so env changes take effect. */
export function _resetSkillStoreForTests(): void {
  store = null;
}

/** Test seam — inject an in-memory store so tests never touch data/skills. */
export function _setSkillStoreForTests(s: SkillStore): void {
  store = s;
}
