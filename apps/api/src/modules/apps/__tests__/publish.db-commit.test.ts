import { eq, inArray } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { apps, appVersions, bases, getDb, members, newId } from '@greenhouse/db';
import { createServices } from '../../../app.js';
import { loadConfig } from '../../../config/index.js';

const createdMembers: string[] = [];
const createdBases: string[] = [];
afterAll(async () => {
  if (createdBases.length) await getDb().delete(bases).where(inArray(bases.id, createdBases));
  if (createdMembers.length) await getDb().delete(members).where(inArray(members.id, createdMembers));
});
const processServices = () =>
  createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
      PUBLIC_URL: 'http://greenhouse.test',
    }),
  );
it('publishes the same draft from two API processes exactly once and rejects the stale publisher', async () => {
  const a = processServices();
  const b = processServices();
  const memberId = newId('member');
  createdMembers.push(memberId);
  await getDb()
    .insert(members)
    .values({ id: memberId, email: `${memberId.toLowerCase()}@example.com`, name: 'Lin', status: 'active' });
  const base = await a.tables.create(memberId, { name: 'Publication race' });
  createdBases.push(base.id);
  const draft = await a.apps.create(memberId, { base_id: base.id, name: 'Race', description: '' });
  const input = { revision: draft.revision, notes: 'First', audience: [] };
  const results = await Promise.allSettled([
    a.apps.publish(memberId, draft.app.id, input),
    b.apps.publish(memberId, draft.app.id, input),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const refused = results.find((r) => r.status === 'rejected');
  expect(refused?.status === 'rejected' && refused.reason).toMatchObject({ code: 'stale_revision' });
  expect(await getDb().select().from(appVersions).where(eq(appVersions.appId, draft.app.id))).toHaveLength(1);
  const [current] = await getDb().select().from(apps).where(eq(apps.id, draft.app.id));
  expect(current).toMatchObject({ publishedVersion: 1, draftRevision: 2 });
});
