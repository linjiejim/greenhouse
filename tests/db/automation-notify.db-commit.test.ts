/**
 * A partial Automation notify update merges into the stored settings without
 * losing a concurrent merge.
 *
 * @db-commit-reason The race needs a second connection that holds the row lock
 * and commits a competing write while the update waits; one rollback
 * transaction cannot hold both sides.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { openTestConnection, TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;
let other: ReturnType<typeof openTestConnection>;
let userId: string;

describe('Automation notify merge', () => {
  beforeAll(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    other = openTestConnection();
    const user = await db.users.create({
      email: `notify-race-${randomUUID()}@test.com`,
      password_hash: 'hash',
      nickname: 'Notify Race',
      role: 'team',
    });
    userId = user.id;
  });

  afterAll(async () => {
    await db.users.delete(userId);
    await other.end();
    await db.close();
    _resetProvider();
  });

  it('keeps a merge committed while another merge waits on the row', async () => {
    const task = await db.scheduledTasks.create({
      user_id: userId,
      name: 'Notify race',
      profile_id: 'team',
      task_prompt: 'x',
      schedule: '0 * * * *',
    });
    let pending: Promise<unknown> | undefined;
    await other.begin(async (tx) => {
      await tx`SELECT id FROM automations WHERE id = ${task.id} FOR UPDATE`;
      pending = db.scheduledTasks.update(task.id, { notify: { email: true } });
      // Give the update time to read and queue behind the lock.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx`UPDATE automations SET notify = notify || '{"feishu": true}'::jsonb WHERE id = ${task.id}`;
    });
    await pending;
    expect((await db.scheduledTasks.getById(task.id))?.notify).toMatchObject({ email: true, feishu: true });
    await db.scheduledTasks.delete(task.id);
  });
});
