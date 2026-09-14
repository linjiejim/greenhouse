/** Immutable custom Agent version and lifecycle integration tests. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { resolveProfileAsync } from '../../apps/api/src/profiles/profile.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random()}`;
}

async function createAgent(riskLevel: 'low' | 'medium' | 'high' = 'medium') {
  return db.customProfiles.create({
    slug: unique('agent'),
    user_id: owner.id,
    name: 'Release analyst',
    description: 'Turns release evidence into a concise brief.',
    base_profile_id: 'sprouty',
    model_id: 'flash',
    tools: ['team_knowledge'],
    system_prompt: 'Use only verified release evidence.',
    max_steps: 12,
    is_shared: true,
    purpose: 'Release readiness',
    audience: 'Engineering leads',
    risk_level: riskLevel,
    budget_policy: { max_tokens: 50_000 },
    eval_refs: ['eval:baseline'],
    change_log: 'Initial governed draft',
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

  it('creates a stable asset plus immutable draft v1 and ignores direct sharing', async () => {
    const asset = await createAgent();
    const version = await db.customProfiles.getCurrentVersion(asset.id);

    expect(asset).toMatchObject({
      current_version: 1,
      published_version: null,
      lifecycle_status: 'draft',
      is_shared: false,
    });
    expect(version).toMatchObject({
      profile_id: asset.id,
      version: 1,
      name: 'Release analyst',
      change_log: 'Initial governed draft',
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

    expect(changed?.profile).toMatchObject({ current_version: 2, published_version: null });
    expect(changed?.version).toMatchObject({ version: 2, change_log: 'Add blocker analysis' });
    expect(await db.customProfiles.getVersion(asset.id, 1)).toEqual(v1);
    expect((await db.customProfiles.listVersions(asset.id)).map((version) => version.version)).toEqual([2, 1]);
  });

  it('withdraws a verified Agent immediately on edit while old pinned work still resolves', async () => {
    const asset = await createAgent();
    const reader = await createInternalTestUser(db, { email: `${unique('agent-reader')}@test.local` });
    const submitted = await db.customProfiles.transitionLifecycle(asset.id, {
      status: 'review',
      actor_user_id: owner.id,
      note: 'Ready for review',
    });
    expect(submitted?.is_shared).toBe(false);

    const verified = await db.customProfiles.transitionLifecycle(asset.id, {
      status: 'verified',
      actor_user_id: owner.id,
      publish_version: 1,
      next_review_at: '2026-09-01T00:00:00.000Z',
    });
    expect(verified).toMatchObject({ lifecycle_status: 'verified', published_version: 1, is_shared: true });
    expect((await db.customProfiles.listForUser(reader.id)).some((row) => row.id === asset.id)).toBe(true);

    const draftV2 = await db.customProfiles.createVersion(asset.id, {
      system_prompt: 'This newer draft must pass review before it can be shared.',
      change_log: 'Prepare next review',
      created_by: owner.id,
    });
    expect(draftV2?.profile).toMatchObject({
      current_version: 2,
      lifecycle_status: 'draft',
      published_version: null,
      is_shared: false,
      reviewed_by: null,
      reviewed_at: null,
      next_review_at: null,
    });
    expect(await db.customProfiles.getPublishedVersion(asset.id)).toBeUndefined();
    expect((await db.customProfiles.listForUser(reader.id)).some((row) => row.id === asset.id)).toBe(false);

    // Existing sessions/schedules/evals carry immutable references. Removing
    // the asset from discovery must not rewrite or break their old manifest.
    await expect(resolveProfileAsync(`custom:${asset.id}@1`)).resolves.toMatchObject({
      id: `custom:${asset.id}@1`,
      system_prompt: 'Use only verified release evidence.',
    });
  });

  it('rejects same-state lifecycle calls and exposes stable governance sweeper queries', async () => {
    const asset = await createAgent();
    await db.customProfiles.transitionLifecycle(asset.id, {
      status: 'review',
      actor_user_id: owner.id,
    });
    const verified = await db.customProfiles.transitionLifecycle(asset.id, {
      status: 'verified',
      actor_user_id: 'system:agent-governance',
      next_review_at: '2026-08-01T00:00:00.000Z',
    });

    await expect(
      db.customProfiles.transitionLifecycle(asset.id, {
        status: 'verified',
        actor_user_id: owner.id,
        next_review_at: '2027-08-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/already verified/);

    const due = await db.customProfiles.listReviewDue('2026-08-02T00:00:00.000Z', 10);
    expect(due.map((row) => row.id)).toContain(asset.id);

    const candidates = await db.customProfiles.listActiveWithOwners(10, Math.max(0, asset.id - 1));
    expect(candidates.find((row) => row.profile.id === asset.id)).toMatchObject({
      owner_status: 'active',
      backup_owner_status: null,
      profile: { lifecycle_status: verified?.lifecycle_status },
    });
  });

  it.each([
    ['low', 90],
    ['medium', 90],
    ['high', 60],
  ] as const)('defaults %s-risk published Agents to a %d-day review window', async (riskLevel, days) => {
    const asset = await createAgent(riskLevel);
    await db.customProfiles.transitionLifecycle(asset.id, {
      status: 'review',
      actor_user_id: owner.id,
    });
    const before = Date.now();
    const published = await db.customProfiles.transitionLifecycle(asset.id, {
      status: 'verified',
      actor_user_id: 'system:agent-governance',
    });
    const after = Date.now();
    const reviewAt = Date.parse(published!.next_review_at!);
    const expectedMs = days * 24 * 60 * 60 * 1000;

    expect(reviewAt).toBeGreaterThanOrEqual(before + expectedMs);
    expect(reviewAt).toBeLessThanOrEqual(after + expectedMs);
  });

  it('rejects invalid lifecycle jumps and archives without deleting version evidence', async () => {
    const asset = await createAgent();
    await expect(
      db.customProfiles.transitionLifecycle(asset.id, {
        status: 'verified',
        actor_user_id: owner.id,
      }),
    ).rejects.toThrow(/Invalid Agent lifecycle transition/);

    const archived = await db.customProfiles.archive(asset.id, owner.id);
    expect(archived).toMatchObject({ lifecycle_status: 'archived', is_shared: false });
    expect(await db.customProfiles.getVersion(asset.id, 1)).toBeDefined();
    expect((await db.customProfiles.listForUser(owner.id)).some((row) => row.id === asset.id)).toBe(false);
  });
});
