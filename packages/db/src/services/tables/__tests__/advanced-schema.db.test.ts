/**
 * Migration 0027 (Tables → Apps Phase 2 foundation, F2) against real
 * PostgreSQL, rolled back per test: the AI queue columns on
 * `table_recompute_jobs` (existing rollup rows stay valid — `kind` defaults to
 * `rollup`), the template tables (semver unique per template, cascade from the
 * template, provenance cleared when the app / Base goes), the typed
 * `custom_review` on app versions, and the `ai` field type stored as a
 * computed field writers cannot set.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess } from '@greenhouse/types/table-access';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  owner = await createInternalTestUser(db, { email: `adv-${tag}@test.local`, nickname: 'Advanced owner' });
});

afterEach(() => {
  _resetProvider();
});

const NOW = '2026-10-11T00:00:00.000Z';

async function baseWithTable() {
  const base = await db.tables.createBase({ name: 'Advanced Base', owner_id: owner.id, created_by: owner.id });
  const { table } = await db.tables.createTable({ base_id: base.id, name: 'Tickets', created_by: owner.id });
  return { base, table };
}

describe('table_recompute_jobs — the AI queue columns', () => {
  it('keeps rollup rows as they were and stores the lease, input hash, revision and spend of AI jobs', async () => {
    const { table } = await baseWithTable();
    await db.executeRaw(sql`
      INSERT INTO table_recompute_jobs (table_id, status, idempotency_key, created_at)
      VALUES (${table.id}, 'queued', ${`rollup:${table.id}:legacy`}, ${NOW})`);
    await db.executeRaw(sql`
      INSERT INTO table_recompute_jobs
        (table_id, kind, status, idempotency_key, lease_owner, lease_expires_at, input_hash, source_revision, tokens, model, error, created_at)
      VALUES (${table.id}, 'ai', 'running', ${`ai:1:2:${table.id}`}, 'worker-a', ${NOW}, 'h1', 3, 120, 'deepseek-chat', NULL, ${NOW})`);
    const rows = (await db.executeRaw(sql`
      SELECT kind, status, lease_owner, input_hash, source_revision, tokens, model
      FROM table_recompute_jobs WHERE table_id = ${table.id} ORDER BY id`)) as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        kind: 'rollup',
        status: 'queued',
        lease_owner: null,
        input_hash: null,
        source_revision: null,
        tokens: null,
        model: null,
      },
      {
        kind: 'ai',
        status: 'running',
        lease_owner: 'worker-a',
        input_hash: 'h1',
        source_revision: 3,
        tokens: 120,
        model: 'deepseek-chat',
      },
    ]);
    const indexes = (await db.executeRaw(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'table_recompute_jobs' ORDER BY indexname`)) as Array<{
      indexname: string;
    }>;
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(['idx_table_recompute_jobs_claim', 'idx_table_recompute_jobs_field']),
    );
  });
});

describe('app templates', () => {
  async function template(key: string, extra: { appId?: number; baseId?: number } = {}) {
    const [row] = (await db.executeRaw(sql`
      INSERT INTO table_app_templates (key, source, name, owner_id, source_app_id, source_base_id, created_at, updated_at)
      VALUES (${key}, 'published', 'Requests', ${owner.id}, ${extra.appId ?? null}, ${extra.baseId ?? null}, ${NOW}, ${NOW})
      RETURNING *`)) as Array<Record<string, unknown>>;
    return row!;
  }

  async function version(templateId: unknown, semver: string) {
    const [row] = (await db.executeRaw(sql`
      INSERT INTO table_app_template_versions (template_id, version, content, content_hash, published_by, published_at)
      VALUES (${templateId}, ${semver}, '{}', 'hash', ${owner.id}, ${NOW})
      RETURNING *`)) as Array<Record<string, unknown>>;
    return row!;
  }

  it('stores a template with defaults, and versions unique per template', async () => {
    const row = await template(`req-${Date.now()}`);
    expect(row).toMatchObject({
      source: 'published',
      status: 'active',
      icon: 'app',
      accent: 'brand',
      description: '',
      latest_version: null,
      archived_at: null,
    });
    const first = await version(row.id, '1.0.0');
    expect(first).toMatchObject({
      changelog: '',
      custom_cards: 0,
      automations: 0,
      scan_status: 'pending',
      review_status: 'pending',
      scan_findings: null,
      reviewed_by: null,
    });
    await expect(version(row.id, '1.0.0')).rejects.toThrow();
    await expect(template(String(row.key))).rejects.toThrow();
  });

  it('drops versions with their template and forgets an app or Base that is gone', async () => {
    const { base } = await baseWithTable();
    const app = await db.tables.createApp({
      base_id: base.id,
      name: 'Source',
      owner_id: owner.id,
      draft_spec: '{}',
      created_by: owner.id,
    });
    const row = await template(`src-${Date.now()}`, { appId: app.id, baseId: base.id });
    await version(row.id, '1.0.0');
    await db.executeRaw(sql`DELETE FROM table_apps WHERE id = ${app.id}`);
    await db.executeRaw(sql`DELETE FROM table_bases WHERE id = ${base.id}`);
    const [kept] = (await db.executeRaw(
      sql`SELECT source_app_id, source_base_id FROM table_app_templates WHERE id = ${row.id}`,
    )) as Array<Record<string, unknown>>;
    expect(kept).toEqual({ source_app_id: null, source_base_id: null });
    await db.executeRaw(sql`DELETE FROM table_app_templates WHERE id = ${row.id}`);
    const versions = (await db.executeRaw(
      sql`SELECT id FROM table_app_template_versions WHERE template_id = ${row.id}`,
    )) as unknown[];
    expect(versions).toEqual([]);
  });

  it('names the version foreign key within Postgres’ identifier limit', async () => {
    const constraints = (await db.executeRaw(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'table_app_template_versions'::regclass AND contype = 'f'`)) as Array<{ conname: string }>;
    expect(constraints.map((row) => row.conname)).toEqual(['table_app_template_versions_template_fk']);
  });
});

describe('app versions — custom_review', () => {
  it('round-trips the review record on a version', async () => {
    const { base } = await baseWithTable();
    const app = await db.tables.createApp({
      base_id: base.id,
      name: 'Custom',
      owner_id: owner.id,
      draft_spec: '{"version":1,"pages":[],"roles":[]}',
      created_by: owner.id,
    });
    const published = await db.tables.publishApp(app.id, { draftRevision: 1, publishedBy: owner.id });
    if (!published.ok) throw new Error('publish failed');
    expect(published.version.custom_review).toBeNull();
    const review = {
      status: 'approved',
      hash: published.version.spec_hash,
      reviewed_by: owner.id,
      reviewed_at: NOW,
    };
    await db.executeRaw(sql`
      UPDATE table_app_versions SET custom_review = ${JSON.stringify(review)}::jsonb
      WHERE app_id = ${app.id} AND version = 1`);
    const stored = await db.tables.getAppVersion(app.id, 1);
    expect(stored?.custom_review).toEqual(review);
  });
});

describe('ai fields', () => {
  it('store as a computed type writers cannot set', async () => {
    const { table } = await baseWithTable();
    const field = await db.tables.createField({
      table_id: table.id,
      name: 'Category',
      type: 'ai',
      created_by: owner.id,
    });
    expect(field.type).toBe('ai');
    await expect(
      db.tables.createRecord({ table_id: table.id, values: { [String(field.id)]: 'bug' } }, fullTableAccess(owner.id), {
        actorId: owner.id,
        actorKind: 'user',
        enqueueAutomations: false,
      }),
    ).rejects.toThrow(/computed/);
  });
});
