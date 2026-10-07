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
