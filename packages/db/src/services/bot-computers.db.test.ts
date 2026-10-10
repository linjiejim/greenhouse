/**
 * Bot computers service against real PostgreSQL (rolled back per test): the
 * member's own timezone is a setting, not a lifecycle step — it creates the
 * row on first use, changes nothing the lifecycle compares (`version`, the
 * `updated_at` the sweeps date transitions by), and can be cleared back to
 * the deployment default.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, { email: `bot-computers-${Date.now()}-${Math.random()}@test.local` });
});

afterEach(() => {
  _resetProvider();
});

const identity = () => ({
  user_id: user.id,
  namespace: 'tztest',
  container_name: `gh-computer-tztest-${user.id}`,
  volume_name: `gh-computer-tztest-${user.id}-home`,
});

describe('computer timezone', () => {
  it('creates the row on first use, as an absent computer with the member’s timezone', async () => {
    expect(await db.botComputers.get(user.id)).toBeUndefined();
    const row = await db.botComputers.setTimezone(identity(), 'Asia/Shanghai');
    expect(row).toMatchObject({
      user_id: user.id,
      state: 'absent',
      version: 0,
      timezone: 'Asia/Shanghai',
      container_name: identity().container_name,
    });
    expect((await db.botComputers.get(user.id))?.timezone).toBe('Asia/Shanghai');
  });

  it('changes only the timezone of an existing row, and clears it back to the default', async () => {
    const created = await db.botComputers.ensure(identity());
    expect(created.timezone).toBeNull();
    const running = (await db.botComputers.transition(user.id, created.version, ['absent'], { state: 'running' }))!;

    const changed = await db.botComputers.setTimezone(
      { ...identity(), namespace: 'other', container_name: 'ignored', volume_name: 'ignored' },
      'America/New_York',
    );
    expect(changed).toMatchObject({
      state: 'running',
      version: running.version,
      updated_at: running.updated_at,
      container_name: identity().container_name, // identity is sticky: only the timezone moved
      timezone: 'America/New_York',
    });

    expect((await db.botComputers.setTimezone(identity(), null)).timezone).toBeNull();
    expect((await db.botComputers.get(user.id))?.timezone).toBeNull();
  });
});

describe('process watches', () => {
  async function conversation() {
    const bot = await db.bots.createBot({
      user_id: user.id,
      name: `Watcher ${Math.random().toString(36).slice(2, 7)}`,
    });
    const dm = await db.bots.ensureDirectConversation(user.id, bot.id);
    return { botId: bot.id, sessionId: dm.session_id };
  }

  it('watches a process once per job, lists it, and hands it to exactly one claimer', async () => {
    const { botId, sessionId } = await conversation();
    const input = { user_id: user.id, session_id: sessionId, bot_id: botId, job_id: 'j0000beef', name: 'tests' };
    await db.botComputers.watchProcess(input);
    await db.botComputers.watchProcess({ ...input, name: 'again' }); // the same job: ignored
    const [watch, ...rest] = await db.botComputers.listWatches(user.id);
    expect(rest).toEqual([]);
    expect(watch).toMatchObject({ job_id: 'j0000beef', name: 'tests', status: 'watching' });
    expect(await db.botComputers.listWatchingUsers()).toContain(user.id);

    // A conditional update: the first claim gets the row, a second one nothing.
    expect(await db.botComputers.settleWatch(watch!.id, 'notified')).toMatchObject({ status: 'notified' });
    expect(await db.botComputers.settleWatch(watch!.id, 'notified')).toBeUndefined();
    expect(await db.botComputers.listWatches(user.id)).toEqual([]);
    expect(await db.botComputers.listWatchingUsers()).not.toContain(user.id);
  });

  it('gives up on old watches and drops a member’s watches, touching nothing else', async () => {
    const { botId, sessionId } = await conversation();
    const base = { user_id: user.id, session_id: sessionId, bot_id: botId, name: 'job' };
    await db.botComputers.watchProcess({ ...base, job_id: 'j000000a1' });
    await db.botComputers.watchProcess({ ...base, job_id: 'j000000a2' });
    const [first] = await db.botComputers.listWatches(user.id);
    await db.botComputers.settleWatch(first!.id, 'notified');

    // Nothing is older than an hour ago; everything is older than an hour from now.
    expect(await db.botComputers.expireWatches(new Date(Date.now() - 3600_000).toISOString())).toBe(0);
    expect(await db.botComputers.expireWatches(new Date(Date.now() + 3600_000).toISOString())).toBeGreaterThanOrEqual(
      1,
    );
    expect(await db.botComputers.listWatches(user.id)).toEqual([]);

    await db.botComputers.watchProcess({ ...base, job_id: 'j000000a3' });
    await db.botComputers.dropWatches(user.id);
    expect(await db.botComputers.listWatches(user.id)).toEqual([]);
  });
});
