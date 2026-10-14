import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, groups, members, newId } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

/**
 * The share dialog sends every share back with each save. A share kept as it was may name a
 * member who was disabled since, or a group deleted since: only who is new must exist, or the
 * item could never be shared again.
 */

describe('saving shares', () => {
  it('keeps shares of members and groups that are gone, and still refuses new ones', async () => {
    const app = createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-kshares-')) });
    const [lin, chen, kai, wu] = [await app.member(), await app.member(), await app.member(), await app.member()];
    const put = (path: string, body: unknown) => app.call('PUT', path, { token: lin.token, body });
    const group = newId('group');
    await getDb().insert(groups).values({ id: group, name: 'Ops' });
    const doc = (await app.call('POST', '/api/knowledge/docs', { token: lin.token, body: { title: 'Plan' } })).body;
    const path = `/api/knowledge/docs/${doc.id}/share`;
    const chenShare = { type: 'member', id: chen.id, role: 'viewer' };
    const opsShare = { type: 'group', id: group, role: 'viewer' };
    expect((await put(path, { items: [chenShare, opsShare] })).status).toBe(200);

    await getDb().update(members).set({ status: 'disabled' }).where(eq(members.id, chen.id));
    await getDb().delete(groups).where(eq(groups.id, group));
    const saved = await put(path, { items: [chenShare, opsShare, { type: 'member', id: kai.id, role: 'editor' }] });
    expect(saved.status).toBe(200);
    expect(saved.body.items.map((entry: { id: string }) => entry.id)).toEqual([chen.id, group, kai.id]);

    await getDb().update(members).set({ status: 'disabled' }).where(eq(members.id, wu.id));
    const refused = await put(path, { items: [chenShare, { type: 'member', id: wu.id, role: 'viewer' }] });
    expect(refused.status).toBe(400);
  });
});
