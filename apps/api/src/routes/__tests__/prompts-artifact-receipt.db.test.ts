/** Task Capture receipt integration — duplicate clicks and refreshes create one Task. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import promptRoutes from '../prompts.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;
let sessionId: string;

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/prompts', promptRoutes);
  return app;
}

describe('Task Capture artifact receipt', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: 'task-capture-receipt@test.com' });
    sessionId = (await db.sessions.create('Capture source', undefined, user.id, undefined, 'web')).id;
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('returns the same Task for a duplicate artifact action', async () => {
    const app = createApp();
    const actionId = 'artifact:message-task:1:task_capture';
    const payload = {
      title: 'Weekly review',
      content: 'Review {{week}} and summarize changes.',
      variables: [{ key: 'week', label: 'Week', required: true }],
      expected_tools: ['tables_query'],
      source_session_id: sessionId,
      created_via: 'capture',
      artifact_action_id: actionId,
      artifact_session_id: sessionId,
    };
    const request = () =>
      app.request('/api/prompts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    const first = await request();
    const second = await request();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const firstTask = (await first.json()) as { id: number };
    const secondTask = (await second.json()) as { id: number };
    expect(secondTask.id).toBe(firstTask.id);
    expect((await db.userPrompts.listForUser(user.id)).filter((task) => task.title === 'Weekly review')).toHaveLength(
      1,
    );
    expect((await db.chatArtifactReceipts.getForUser(actionId, user.id))?.status).toBe('succeeded');
  });
});
