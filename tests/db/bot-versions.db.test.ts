/** Bot identities: immutable versions, owner-only access and profile resolution (PostgreSQL). */

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

async function createBot(modelId = 'flash') {
  return db.bots.createBot({
    user_id: owner.id,
    name: unique('Release analyst').slice(0, 24),
    role: 'Release readiness',
    description: 'Turns release evidence into a concise brief.',
    instructions: 'Use only verified release evidence.',
    model_id: modelId,
    tools: ['team_knowledge'],
    max_steps: 12,
    change_log: 'Initial draft',
    created_by: owner.id,
  });
}

describe('Bot immutable versions', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `${unique('bot-owner')}@test.local` });
    other = await createInternalTestUser(db, { email: `${unique('bot-other')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('creates an identity plus its immutable v1', async () => {
    const bot = await createBot();
    const version = await db.bots.getCurrentVersion(bot.id);

    expect(bot).toMatchObject({ current_version: 1, status: 'active' });
    expect(version).toMatchObject({ bot_id: bot.id, version: 1, name: bot.name, change_log: 'Initial draft' });
    expect(version?.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
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
    expect(changed).toMatchObject({ current_version: 2, name: 'Release analyst v2' });
    const v2 = await db.bots.getVersion(bot.id, 2);
    expect(v2).toMatchObject({ version: 2, change_log: 'Add blocker analysis' });
    expect(JSON.parse(v2!.tools!)).toEqual(['team_knowledge', 'project_query']);
    expect(await db.bots.getVersion(bot.id, 1)).toEqual(v1);
    expect((await db.bots.listVersions(bot.id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it('keeps a Bot private: the owner runs it live or pinned, nobody else at all', async () => {
    const bot = await createBot();
    // The owner's Chat follows the live definition; unattended work pins the current version.
    await expect(
      pinProfileIdForUser({ id: owner.id, role: 'team' }, `bot:${bot.id}`, db, { mode: 'live' }),
    ).resolves.toBe(`bot:${bot.id}`);
    await expect(pinProfileIdForUser({ id: owner.id, role: 'team' }, `bot:${bot.id}`, db)).resolves.toBe(
      `bot:${bot.id}@1`,
    );
    await expect(pinProfileIdForUser({ id: other.id, role: 'team' }, `bot:${bot.id}`, db)).rejects.toMatchObject({
      status: 403,
    });
    await expect(pinProfileIdForUser({ id: other.id, role: 'team' }, `bot:${bot.id}@1`, db)).rejects.toMatchObject({
      status: 403,
    });

    // An edit leaves already-pinned work on its immutable manifest.
    await db.bots.updateBot(owner.id, bot.id, { instructions: 'Tightened.', created_by: owner.id });
    const pinned = await resolveProfileAsync(`bot:${bot.id}@1`, db);
    expect(pinned.id).toBe(`bot:${bot.id}@1`);
    expect(pinned.identity).toMatchObject({ botId: bot.id, instructions: 'Use only verified release evidence.' });
    expect(pinned.narrow_tools).toBe(true);
    expect(pinned.tools).toEqual(['team_knowledge']);
    const live = await resolveProfileAsync(`bot:${bot.id}`, db);
    expect(live.identity?.instructions).toBe('Tightened.');
  });

  it('runs a Bot pinned to a model this deployment cannot reach on the base preset model', async () => {
    setModelRegistry(DEFAULT_MODEL_REGISTRY);
    const bot = await createBot('retired-model');
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

  it('archives without deleting version evidence and stops resolving the identity', async () => {
    const bot = await createBot();
    expect(await db.bots.archiveBot(owner.id, bot.id)).toBe(true);
    expect(await db.bots.getBotById(bot.id)).toMatchObject({ status: 'archived' });
    expect(await db.bots.getVersion(bot.id, 1)).toBeTruthy();
    await expect(resolveProfileAsync(`bot:${bot.id}`, db)).rejects.toThrow(/not executable/);
  });
});
