/** Automations (`automations`): the merged `notify` object and text ids (real PostgreSQL). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, newId, type DatabaseProvider } from '../index.js';
import { TEST_DATABASE_URL } from '../test-config.js';

let db: DatabaseProvider;

describe('scheduledTasks on automations', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('stores notify as one object and merges updates key by key', async () => {
    const user = await db.users.create({
      email: `${newId('user')}@test.local`,
      nickname: 'Automation owner',
      role: 'team',
      password_hash: 'test-only',
    });
    const task = await db.scheduledTasks.create({
      user_id: user.id,
      name: 'Digest',
      task_prompt: 'Summarize the day.',
      schedule: '0 9 * * *',
      notify: { webhook: '  ', email: true },
      unattended_tools: ['memory'],
    });
    expect(task.id).toMatch(/^atm_/);
    expect(task.notify).toEqual({ webhook: null, email: true, wecom: false, feishu: false });
    expect(task.unattended_tools).toEqual(['memory']);

    const updated = await db.scheduledTasks.update(task.id, {
      notify: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' },
    });
    expect(updated?.notify).toEqual({
      webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
      email: true,
      wecom: false,
      feishu: false,
    });
    expect(await db.scheduledTasks.update(newId('automation'), { notify: { email: false } })).toBeUndefined();
  });
});
