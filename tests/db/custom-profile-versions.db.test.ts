/** Custom Agent version counter, 1.x pins and the private-unless-shared rule (v1.4 / 3.0). */

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
  });
}

describe('Custom Agent versions', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `${unique('agent-owner')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('creates a private Agent at version 1 and ignores direct sharing', async () => {
    const asset = await createAgent();
    const version = await db.customProfiles.getCurrentVersion(asset.id);

    expect(asset.id).toMatch(/^rpf_/);
    expect(asset).toMatchObject({ version: 1, is_shared: false, purpose: 'Release readiness' });
    expect(version).toMatchObject({
      profile_id: asset.id,
      version: 1,
      name: 'Release analyst',
      risk_level: 'medium',
    });
    expect(version?.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(version!.budget_policy).toEqual({ max_tokens: 50_000 });
  });

  it('bumps the version on every edit and resolves older pins to the current configuration', async () => {
    const asset = await createAgent();
    const changed = await db.customProfiles.createVersion(asset.id, {
      name: 'Release analyst v2',
      system_prompt: 'Require verified evidence and identify blockers.',
      tools: ['team_knowledge', 'project_query'],
    });

    expect(changed?.profile).toMatchObject({ version: 2, tools: ['team_knowledge', 'project_query'] });
    expect(changed?.version).toMatchObject({ version: 2, name: 'Release analyst v2' });
    // Immutable versions were retired in 3.0: a 1.x pin runs the current configuration.
    expect(await db.customProfiles.getVersion(asset.id, 1)).toMatchObject({
      version: 1,
      name: 'Release analyst v2',
      manifest_hash: changed!.version.manifest_hash,
    });
    expect(await db.customProfiles.getVersion(asset.id, 3)).toBeUndefined();
    expect(await db.customProfiles.getVersion(asset.id, 0)).toBeUndefined();
    expect((await db.customProfiles.getCurrentVersion(asset.id))?.version).toBe(2);
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
    });
    expect(v2?.profile).toMatchObject({ version: 2, is_shared: true });
    // The next pick gets the new version; work already pinned keeps its pin (now the current configuration).
    await expect(pinProfileIdForUser(readerActor, `custom:${asset.id}`, db)).resolves.toBe(`custom:${asset.id}@2`);
    await expect(pinProfileIdForUser(readerActor, `custom:${asset.id}@1`, db, { existingPin: true })).resolves.toBe(
      `custom:${asset.id}@1`,
    );
    // Picking the old version afresh is refused: it may never have been shared.
    await expect(pinProfileIdForUser(readerActor, `custom:${asset.id}@1`, db)).rejects.toMatchObject({ status: 403 });
    await expect(
      assertPinnedProfileExecutionAccess(db, readerActor, `custom:${asset.id}@1`, 'Automation'),
    ).resolves.toBeUndefined();
    await expect(resolveProfileAsync(`custom:${asset.id}@1`, db)).resolves.toMatchObject({
      id: `custom:${asset.id}@1`,
      system_prompt: 'Require verified evidence and identify blockers.',
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

  it('deletes an Agent, so its pins fail closed', async () => {
    const asset = await createAgent();
    await db.customProfiles.createVersion(asset.id, { name: 'Second' });

    expect(await db.customProfiles.delete(asset.id)).toBe(true);
    expect(await db.customProfiles.getById(asset.id)).toBeUndefined();
    expect(await db.customProfiles.getCurrentVersion(asset.id)).toBeUndefined();
    await expect(resolveProfileAsync(`custom:${asset.id}@1`, db)).rejects.toThrow(/not found/);
    expect(await db.customProfiles.delete(asset.id)).toBe(false);
  });
});
