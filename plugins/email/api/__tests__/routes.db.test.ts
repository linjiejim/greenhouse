import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { initDatabase } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import type { AppEnv } from '@greenhouse/api/extension-kit';
import { mountExtensionRoutes } from '../../../../apps/api/src/plugin-host/boot.js';
import { resolveUserTools } from '../../../../apps/api/src/agent.js';
it('keeps mail available by default and applies the member flag to REST and tools together', async () => {
  const db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const owner = await createInternalTestUser(db, { email: 'mail-flag@test.local' });
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: owner.id, role: 'team' } as never);
    await next();
  });
  mountExtensionRoutes(app);
  expect((await app.request('/api/email/accounts')).status).toBe(200);
  expect((await resolveUserTools(owner.id, 'team')).activeTools).toContain('email_query');
  await db.userFeatures.upsert({ user_id: owner.id, feature: 'email', enabled: false });
  expect((await app.request('/api/email/accounts')).status).toBe(403);
  expect((await resolveUserTools(owner.id, 'team')).activeTools).not.toContain('email_query');
  expect((await resolveUserTools(owner.id, 'team')).activeTools).not.toContain('email_mutation');
});
