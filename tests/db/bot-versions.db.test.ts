/** Bot identities: immutable versions, the sharing lifecycle and profile resolution (PostgreSQL). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry } from '@greenhouse/agent-core';
import { resolveProfileAsync } from '../../apps/api/src/profiles/profile.js';
import { pinProfileIdForUser } from '../../apps/api/src/profiles/access.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let other: UserRow;

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random()}`;
}

async function createBot(riskLevel: 'low' | 'medium' | 'high' = 'medium', modelId = 'flash') {
  return db.bots.createBot({
    user_id: owner.id,
    name: unique('Release analyst').slice(0, 24),
    role: 'Release readiness',
    description: 'Turns release evidence into a concise brief.',
    instructions: 'Use only verified release evidence.',
    model_id: modelId,
    tools: ['team_knowledge'],
    max_steps: 12,
    purpose: 'Release readiness',
    audience: 'Engineering leads',
    risk_level: riskLevel,
    budget_policy: { max_tokens: 50_000 },
    eval_refs: ['eval:baseline'],
    change_log: 'Initial governed draft',
    created_by: owner.id,
  });
}

describe('Bot immutable versions and lifecycle', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `${unique('bot-owner')}@test.local` });
    other = await createInternalTestUser(db, { email: `${unique('bot-other')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('creates an identity plus immutable draft v1 that is private until reviewed', async () => {
    const bot = await createBot();
    const version = await db.bots.getCurrentVersion(bot.id);

    expect(bot).toMatchObject({
      current_version: 1,
      published_version: null,
      lifecycle_status: 'draft',
      is_shared: false,
      status: 'active',
    });
    expect(version).toMatchObject({
      bot_id: bot.id,
      version: 1,
      name: bot.name,
      change_log: 'Initial governed draft',
      risk_level: 'medium',
    });
    expect(version?.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(version!.budget_policy)).toEqual({ max_tokens: 50_000 });
    expect(JSON.parse(version!.tools!)).toEqual(['team_knowledge']);
  });

  it('appends a new version on edit without mutating the prior manifest', async () => {
    const bot = await createBot();
    const v1 = await db.bots.getVersion(bot.id, 1);
    const changed = await db.bots.updateBot(owner.id, bot.id, {
      name: 'Release analyst v2',
      instructions: 'Require verified evidence and identify blockers.',
      tools: ['team_knowledge', 'project_query'],
      change_log: 'Add blocker analysis',
      created_by: owner.id,
    });
    expect(changed).toMatchObject({ current_version: 2, name: 'Release analyst v2', lifecycle_status: 'draft' });
    const v2 = await db.bots.getVersion(bot.id, 2);
    expect(v2).toMatchObject({ version: 2, change_log: 'Add blocker analysis' });
    expect(JSON.parse(v2!.tools!)).toEqual(['team_knowledge', 'project_query']);
    expect(await db.bots.getVersion(bot.id, 1)).toEqual(v1);
    expect((await db.bots.listVersions(bot.id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it('withdraws a verified Bot immediately on edit while old pinned work still resolves', async () => {
    const bot = await createBot();
    await db.bots.transitionLifecycle(bot.id, { status: 'review', actor_user_id: owner.id });
    const verified = await db.bots.transitionLifecycle(bot.id, {
      status: 'verified',
      actor_user_id: 'super-1',
      publish_version: 1,
    });
    expect(verified).toMatchObject({ is_shared: true, published_version: 1, lifecycle_status: 'verified' });
    expect(verified?.next_review_at).toBeTruthy();

    // Another member runs the published version; the owner's Chat follows live.
    await expect(pinProfileIdForUser({ id: other.id, role: 'team' }, `bot:${bot.id}`, db)).resolves.toBe(
      `bot:${bot.id}@1`,
    );
    await expect(
      pinProfileIdForUser({ id: owner.id, role: 'team' }, `bot:${bot.id}`, db, { mode: 'live' }),
    ).resolves.toBe(`bot:${bot.id}`);
    expect(await db.bots.listShared(other.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: bot.id })]),
    );

    const edited = await db.bots.updateBot(owner.id, bot.id, { instructions: 'Tightened.', created_by: owner.id });
    expect(edited).toMatchObject({
      lifecycle_status: 'draft',
      is_shared: false,
      published_version: null,
      current_version: 2,
    });
    await expect(pinProfileIdForUser({ id: other.id, role: 'team' }, `bot:${bot.id}`, db)).rejects.toMatchObject({
      status: 403,
    });
    // The already-pinned reference is still an immutable, resolvable manifest.
    const pinned = await resolveProfileAsync(`bot:${bot.id}@1`, db);
    expect(pinned.id).toBe(`bot:${bot.id}@1`);
    expect(pinned.identity).toMatchObject({ botId: bot.id, instructions: 'Use only verified release evidence.' });
    expect(pinned.narrow_tools).toBe(true);
    expect(pinned.tools).toEqual(['team_knowledge']);
  });

  it('runs a Bot pinned to a model this deployment cannot reach on the base preset model', async () => {
    setModelRegistry(DEFAULT_MODEL_REGISTRY);
    const bot = await createBot('medium', 'retired-model');
    const profile = await resolveProfileAsync(`bot:${bot.id}`, db);
    expect(profile.model.id).toBe('flash');
    expect(profile.name).toBe(bot.name);
    expect(profile.identity?.ownerUserId).toBe(owner.id);
  });

  it('inherits the owner tool set when the Bot has no filter and resolves the default identity for a member', async () => {
    const open = await db.bots.createBot({ user_id: owner.id, name: unique('Open').slice(0, 24), instructions: 'Hi.' });
    const profile = await resolveProfileAsync(`bot:${open.id}`, db);
    expect(open.tools).toBeNull();
    expect(profile.narrow_tools).toBe(false);

    // `sprouty` for a known member is their own Sprouty Bot (created on first use), under the preset's id.
    const sprouty = await resolveProfileAsync('sprouty', db, { forUserId: owner.id });
    expect(sprouty.id).toBe('sprouty');
    expect(sprouty.identity?.name).toBe('Sprouty');
    const mine = await db.bots.listBots(owner.id);
    expect(mine.some((bot) => bot.template_key === 'sprouty')).toBe(true);
    // The row persists: a second resolution reuses it.
    const again = await resolveProfileAsync('sprouty', db, { forUserId: owner.id });
    expect(again.identity?.botId).toBe(sprouty.identity?.botId);
  });

  it('rejects same-state lifecycle calls and exposes stable governance sweeper queries', async () => {
    const bot = await createBot('high');
    await expect(db.bots.transitionLifecycle(bot.id, { status: 'draft', actor_user_id: owner.id })).rejects.toThrow(
      /already draft/,
    );
    await db.bots.transitionLifecycle(bot.id, { status: 'review', actor_user_id: owner.id });
    const pilot = await db.bots.transitionLifecycle(bot.id, { status: 'pilot', actor_user_id: 'super-1' });
    const dueAt = new Date(Date.parse(pilot!.next_review_at!) + 1000).toISOString();
    expect((await db.bots.listReviewDue(dueAt)).map((row) => row.id)).toContain(bot.id);
    expect(
      (await db.bots.listReviewDue(new Date(Date.parse(pilot!.next_review_at!) - 1000).toISOString())).map((r) => r.id),
    ).not.toContain(bot.id);
    const page = await db.bots.listActiveWithOwners(500);
    expect(page.find((candidate) => candidate.bot.id === bot.id)).toMatchObject({ owner_status: 'active' });
    expect((await db.bots.listGovernanceQueue()).map((row) => row.id)).toContain(bot.id);
    // High risk → 60 days.
    const days = (Date.parse(pilot!.next_review_at!) - Date.parse(pilot!.reviewed_at!)) / 86_400_000;
    expect(Math.round(days)).toBe(60);
  });

  it('rejects invalid lifecycle jumps and archives without deleting version evidence', async () => {
    const bot = await createBot();
    await expect(db.bots.transitionLifecycle(bot.id, { status: 'verified', actor_user_id: 'super-1' })).rejects.toThrow(
      /Invalid Bot lifecycle transition/,
    );
    expect(await db.bots.archiveBot(owner.id, bot.id)).toBe(true);
    const archived = await db.bots.getBotById(bot.id);
    expect(archived).toMatchObject({ status: 'archived', lifecycle_status: 'archived', is_shared: false });
    expect(await db.bots.getVersion(bot.id, 1)).toBeTruthy();
    await expect(resolveProfileAsync(`bot:${bot.id}`, db)).rejects.toThrow(/not executable/);
  });
});
