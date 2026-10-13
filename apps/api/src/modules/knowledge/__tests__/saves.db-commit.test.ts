/**
 * Two API processes save the same doc from the same version at the same moment: the version is
 * a compare-and-set, so exactly one save lands and the other is told it is stale.
 */

import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { docVersions, getDb, members, newId } from '@greenhouse/db';
import { createApp, createServices } from '../../../app.js';
import { loadConfig } from '../../../config/index.js';

const createdMembers: string[] = [];

afterAll(async () => {
  // Personal docs, their versions and links go with their owner.
  if (createdMembers.length) await getDb().delete(members).where(inArray(members.id, createdMembers));
});

function apiProcess() {
  const services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
      PUBLIC_URL: 'http://greenhouse.test',
    }),
  );
  return { services, app: createApp(services) };
}

describe('saving a doc from two processes at once', () => {
  it('lands one save and refuses the other as stale', async () => {
    const a = apiProcess();
    const b = apiProcess();
    const id = newId('member');
    createdMembers.push(id);
    await getDb()
      .insert(members)
      .values({ id, email: `${id.toLowerCase()}@example.com`, name: 'Lin', status: 'active' });
    const token = a.services.tokens.createAccessToken(id, 'member', 0);
    const doc = await a.services.knowledge.createDoc(id, { title: 'Race', content: 'start' });

    const save = async (process: ReturnType<typeof apiProcess>, content: string) => {
      const response = await process.app.request(`/api/knowledge/docs/${doc.id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, content }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const results = await Promise.all([save(a, 'from a'), save(b, 'from b')]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const refused = results.find((result) => result.status === 409)!;
    expect(refused.body.error).toMatchObject({ code: 'stale_version', details: { version: 2 } });
    const versions = await getDb().select().from(docVersions).where(eq(docVersions.docId, doc.id));
    expect(versions.map((version) => version.version).sort()).toEqual([1, 2]);
    const landed = results.find((result) => result.status === 200)!;
    expect(versions.find((version) => version.version === 2)!.content).toBe(landed.body.content);
  });
});
