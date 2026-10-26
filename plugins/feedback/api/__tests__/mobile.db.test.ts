import { beforeEach, it, expect } from 'vitest';
import { Hono } from 'hono';
import { initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import type { AppEnv } from '@greenhouse/api/extension-kit';
import { feedbackServices } from '../services.js';
import { mobileFeedbackRoutes } from '../routes/mobile.js';
let db: DatabaseProvider;
let user: UserRow;
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, { email: 'feedback-mobile@test.local', role: 'team' });
});
function app(actor: UserRow) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: actor.id, role: actor.role });
      await next();
    })
    .route('/api/me/feedback', mobileFeedbackRoutes);
}
it('files feedback as a request from the member, with the app context appended', async () => {
  const server = app(user);
  const post = (body: unknown) =>
    server.request('/api/me/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const made = await post({
    message: 'The table view is cramped\nRotating would help',
    context: { app: '3.0.0 (45)', station: 'green.example' },
  });
  expect(made.status).toBe(201);
  const { id } = (await made.json()) as { id: string };
  const saved = await feedbackServices(db).featureRequests.getById(id);
  expect(saved).toMatchObject({ title: 'The table view is cramped', submitted_by: user.id, status: 'pending' });
  expect(saved?.description).toContain('Rotating would help');
  expect(saved?.description).toContain('- station: green.example');

  expect((await post({ message: '   ' })).status).toBe(400);
  expect((await post({ message: 'x'.repeat(4001) })).status).toBe(400);
  expect((await post({ message: 'ok', extra: 1 })).status).toBe(400);
});
