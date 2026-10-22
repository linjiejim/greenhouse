/** Immutable custom Agent versions and the private-unless-shared rule (v1.4). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry } from '@greenhouse/agent-core';
import { assertPinnedProfileExecutionAccess, resolveProfileAsync } from '../../apps/api/src/profiles/profile.js';
import { pinProfileIdForUser } from '../../apps/api/src/profiles/access.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random()}`;
}

async function createAgent(riskLevel: 'low' | 'medium' | 'high' = 'medium', modelId = 'flash') {
  return db.customProfiles.create({
    slug: unique('agent'),
    user_id: owner.id,
    name: 'Release analyst',
    description: 'Turns release evidence into a concise brief.',
    base_profile_id: 'sprouty',
    model_id: modelId,
    tools: ['team_knowledge'],
    system_prompt: 'Use only verified release evidence.',
    max_steps: 12,
    is_shared: true,
    purpose: 'Release readiness',
    audience: 'Engineering leads',
    risk_level: riskLevel,
    budget_policy: { max_tokens: 50_000 },
    change_log: 'Initial version',
    created_by: owner.id,
  });
}

describe('Custom Agent immutable versions', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `${unique('agent-owner')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('creates a private asset plus immutable v1 and ignores direct sharing', async () => {
    const asset = await createAgent();
    const version = await db.customProfiles.getCurrentVersion(asset.id);

    expect(asset).toMatchObject({ current_version: 1, is_shared: false });
    expect(version).toMatchObject({
      profile_id: asset.id,
      version: 1,
      name: 'Release analyst',
      change_log: 'Initial version',
      risk_level: 'medium',
    });
    expect(version?.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(version!.budget_policy)).toEqual({ max_tokens: 50_000 });
  });

  it('appends a new version without mutating the prior executable manifest', async () => {
    const asset = await createAgent();
    const v1 = await db.customProfiles.getVersion(asset.id, 1);
    const changed = await db.customProfiles.createVersion(asset.id, {
      name: 'Release analyst v2',
      system_prompt: 'Require verified evidence and identify blockers.',
      tools: ['team_knowledge', 'project_query'],
      change_log: 'Add blocker analysis',
      created_by: owner.id,
    });

    expect(changed?.profile).toMatchObject({ current_version: 2 });
    expect(changed?.version).toMatchObject({ version: 2, change_log: 'Add blocker analysis' });
    expect(await db.customProfiles.getVersion(asset.id, 1)).toEqual(v1);
    expect((await db.customProfiles.listVersions(asset.id)).map((version) => version.version)).toEqual([2, 1]);
  });

  it('keeps a shared Agent shared across edits, hands non-owners the current version, and keeps old pins resolving', async () => {
    const asset = await createAgent();
    const reader = await createInternalTestUser(db, { email: `${unique('agent-reader')}@test.local` });
    const readerActor = { id: reader.id, role: 'team' as const };
    expect((await db.customProfiles.listForUser(reader.id)).some((row) => row.id === asset.id)).toBe(false);

    expect(await db.customProfiles.setShared(asset.id, true)).toMatchObject({ is_shared: true });
    expect((await db.customProfiles.listForUser(reader.id)).some((row) => row.id === asset.id)).toBe(true);
    await expect(pinProfileIdForUser(readerActor, `custom:${asset.id}`, db)).resolves.toBe(`custom:${asset.id}@1`);

    const v2 = await db.customProfiles.createVersion(asset.id, {
      system_prompt: 'Require verified evidence and identify blockers.',
      change_log: 'Add blocker analysis',
      created_by: owner.id,
    });
    expect(v2?.profile).toMatchObject({ current_version: 2, is_shared: true });
    // The next pick gets the new version; work already pinned keeps v1.
    await expect(pinProfileIdForUser(readerActor, `custom:${asset.id}`, db)).resolves.toBe(`custom:${asset.id}@2`);
    await expect(pinProfileIdForUser(readerActor, `custom:${asset.id}@1`, db)).resolves.toBe(`custom:${asset.id}@1`);
    await expect(
      assertPinnedProfileExecutionAccess(db, readerActor, `custom:${asset.id}@1`, 'Automation'),
    ).resolves.toBeUndefined();
    await expect(resolveProfileAsync(`custom:${asset.id}@1`, db)).resolves.toMatchObject({
      id: `custom:${asset.id}@1`,
      system_prompt: 'Use only verified release evidence.',
    });
  });

  it('revokes non-owner use when an Agent is made private again, never the owner', async () => {
    const asset = await createAgent();
    const reader = await createInternalTestUser(db, { email: `${unique('agent-reader')}@test.local` });
    const readerActor = { id: reader.id, role: 'team' as const };
    await db.customProfiles.setShared(asset.id, true);
    await db.customProfiles.setShared(asset.id, false);

    expect((await db.customProfiles.listForUser(reader.id)).some((row) => row.id === asset.id)).toBe(false);
    await expect(pinProfileIdForUser(readerActor, `custom:${asset.id}`, db)).rejects.toMatchObject({ status: 403 });
    await expect(
      assertPinnedProfileExecutionAccess(db, readerActor, `custom:${asset.id}@1`, 'Automation'),
    ).rejects.toThrow(/access was revoked/);
    await expect(
      assertPinnedProfileExecutionAccess(db, { id: owner.id, role: 'team' }, `custom:${asset.id}@1`, 'Automation'),
    ).resolves.toBeUndefined();
  });

  it('never writes the retired review columns', async () => {
    const asset = await createAgent();
    await db.customProfiles.setShared(asset.id, true);
    await db.customProfiles.createVersion(asset.id, { change_log: 'Second', created_by: owner.id });
    const row = await db.customProfiles.getById(asset.id);
    const v2 = await db.customProfiles.getVersion(asset.id, 2);

    // Column defaults, untouched by create / edit / share.
    expect(row).toMatchObject({
      lifecycle_status: 'draft',
      lifecycle_note: null,
      published_version: null,
      reviewed_by: null,
      reviewed_at: null,
      next_review_at: null,
    });
    expect(v2?.review_due_at).toBeNull();
  });

  // A model is retired from the catalog (or its key is unset) long after an
  // Agent was pinned to it; the Agent keeps working on its base preset model.
  it('runs an Agent pinned to a model this deployment cannot reach on its base preset model', async () => {
    const savedKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    // In the catalog but unkeyed — the case a plain "is it in the catalog" check misses.
    setModelRegistry({
      ...DEFAULT_MODEL_REGISTRY,
      'deepseek-flash': {
        name: 'DeepSeek V4.1 Flash',
        providers: [{ provider: 'deepseek', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' }],
      },
    });
    try {
      for (const modelId of ['minimax-m3', 'deepseek-flash']) {
        const asset = await createAgent('medium', modelId);
        const resolved = await resolveProfileAsync(`custom:${asset.id}@1`);
        expect(resolved.model.id, modelId).toBe('flash');
      }
    } finally {
      setModelRegistry(DEFAULT_MODEL_REGISTRY);
      if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    }
  });

  it('deletes an Agent with its versions, so its pins fail closed', async () => {
    const asset = await createAgent();
    await db.customProfiles.createVersion(asset.id, { change_log: 'Second', created_by: owner.id });

    expect(await db.customProfiles.delete(asset.id)).toBe(true);
    expect(await db.customProfiles.getById(asset.id)).toBeUndefined();
    expect(await db.customProfiles.listVersions(asset.id)).toEqual([]);
    await expect(resolveProfileAsync(`custom:${asset.id}@1`, db)).rejects.toThrow(/not found/);
    expect(await db.customProfiles.delete(asset.id)).toBe(false);
  });
});
