import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import { getDb, groupMembers, groups, members, newId } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

/**
 * `knowledge.changed`: whoever sees a place in the tree hears that it changed, so the lists on
 * their screens refetch — everyone with the knowledge base for the team space, the owner and the
 * people shares reach in a personal one. The event names nothing.
 */

type App = ReturnType<typeof createTestApp>;
type Who = Awaited<ReturnType<App['member']>>;

async function setup() {
  const app = createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-kevents-')) });
  const as = (who: Who) => ({
    post: (path: string, body: unknown = {}) => app.call('POST', path, { token: who.token, body }),
    patch: (path: string, body: unknown) => app.call('PATCH', path, { token: who.token, body }),
    put: (path: string, body: unknown) => app.call('PUT', path, { token: who.token, body }),
    del: (path: string) => app.call('DELETE', path, { token: who.token }),
  });
  /** How many `knowledge.changed` events a member's sockets got since the last look. */
  function heard(who: Who) {
    const events: RealtimeEvent[] = [];
    app.services.hub.subscribe(who.id, (event) => events.push(event));
    return () => {
      const changed = events.filter((event) => event.type === 'knowledge.changed');
      events.length = 0;
      return changed;
    };
  }
  const [lin, chen, kai] = [await app.member(), await app.member(), await app.member()];
  return { app, as, heard, lin, chen, kai };
}

describe('knowledge.changed', () => {
  it('tells everyone with the knowledge base about the team space, and names nothing', async () => {
    const { as, heard, lin, chen, kai } = await setup();
    await getDb()
      .update(members)
      .set({ modules: { knowledge: false } })
      .where(eq(members.id, kai.id));
    const [toLin, toChen, toKai] = [heard(lin), heard(chen), heard(kai)];
    const folder = (await as(lin).post('/api/knowledge/folders', { name: 'Policies', space: 'team' })).body;
    expect(toLin()).toEqual([{ type: 'knowledge.changed', data: {} }]);
    expect(toChen()).toHaveLength(1);
    expect(toKai()).toHaveLength(0);

    const doc = (await as(chen).post('/api/knowledge/docs', { title: 'Leave', folder_id: folder.id })).body;
    await as(chen).patch(`/api/knowledge/docs/${doc.id}`, { version: 1, content: 'Ask first.' });
    await as(lin).post('/api/knowledge/reorder', { folder_id: folder.id, items: [{ type: 'doc', id: doc.id }] });
    await as(lin).del(`/api/knowledge/docs/${doc.id}`);
    expect(toLin()).toHaveLength(4);
    expect(toChen()).toHaveLength(4);
    expect(toKai()).toHaveLength(0);
  });

  it('keeps a personal space to its owner until a share reaches someone, and tells who a removed share left', async () => {
    const { as, heard, lin, chen, kai } = await setup();
    const [toLin, toChen, toKai] = [heard(lin), heard(chen), heard(kai)];
    const drafts = (await as(lin).post('/api/knowledge/folders', { name: 'Drafts' })).body;
    const plan = (await as(lin).post('/api/knowledge/docs', { title: 'Plan', folder_id: drafts.id })).body;
    expect(toLin()).toHaveLength(2);
    expect(toChen()).toHaveLength(0);

    // A share on the folder reaches what is in it, and the change of shares itself is told.
    await as(lin).put(`/api/knowledge/folders/${drafts.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'viewer' }],
    });
    expect(toChen()).toHaveLength(1);
    await as(lin).patch(`/api/knowledge/docs/${plan.id}`, { version: 1, title: 'Plan B' });
    expect(toChen()).toHaveLength(1);
    expect(toKai()).toHaveLength(0);

    // Taking the share away tells Chen once more (the folder leaves his list), then nothing.
    await as(lin).put(`/api/knowledge/folders/${drafts.id}/share`, { items: [] });
    expect(toChen()).toHaveLength(1);
    await as(lin).patch(`/api/knowledge/docs/${plan.id}`, { version: 2, content: 'Later.' });
    expect(toChen()).toHaveLength(0);
    expect(toLin()).toHaveLength(4);
  });

  it('tells whoever a share inside reaches when a folder is archived or restored with it', async () => {
    const { as, heard, lin, chen, kai } = await setup();
    const drafts = (await as(lin).post('/api/knowledge/folders', { name: 'Drafts' })).body;
    const inner = (await as(lin).post('/api/knowledge/folders', { name: 'Inner', folder_id: drafts.id })).body;
    const plan = (await as(lin).post('/api/knowledge/docs', { title: 'Plan', folder_id: inner.id })).body;
    const memo = (await as(lin).post('/api/knowledge/docs', { title: 'Memo', folder_id: drafts.id })).body;
    await as(lin).put(`/api/knowledge/docs/${plan.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'viewer' }],
    });
    await as(lin).put(`/api/knowledge/folders/${inner.id}/share`, {
      items: [{ type: 'member', id: kai.id, role: 'viewer' }],
    });
    const [toChen, toKai] = [heard(chen), heard(kai)];
    // Memo is not shared: changing it tells neither.
    await as(lin).patch(`/api/knowledge/docs/${memo.id}`, { version: 1, content: 'Mine.' });
    expect(toChen()).toHaveLength(0);
    expect(toKai()).toHaveLength(0);

    await as(lin).del(`/api/knowledge/folders/${drafts.id}`);
    expect(toChen()).toHaveLength(1);
    expect(toKai()).toHaveLength(1);
    await as(lin).post(`/api/knowledge/folders/${drafts.id}/restore`);
    expect(toChen()).toHaveLength(1);
    expect(toKai()).toHaveLength(1);
  });

  it('reaches group members and, through a workspace share, everyone', async () => {
    const { as, heard, lin, chen, kai } = await setup();
    const group = newId('group');
    await getDb().insert(groups).values({ id: group, name: 'Ops' });
    await getDb().insert(groupMembers).values({ groupId: group, memberId: chen.id });
    const [toChen, toKai] = [heard(chen), heard(kai)];
    const notes = (await as(lin).post('/api/knowledge/docs', { title: 'Notes' })).body;
    await as(lin).put(`/api/knowledge/docs/${notes.id}/share`, {
      items: [{ type: 'group', id: group, role: 'editor' }],
    });
    toChen();
    await as(lin).patch(`/api/knowledge/docs/${notes.id}`, { version: 1, content: 'For ops.' });
    expect(toChen()).toHaveLength(1);
    expect(toKai()).toHaveLength(0);

    await as(lin).put(`/api/knowledge/docs/${notes.id}/share`, { items: [{ type: 'workspace', role: 'viewer' }] });
    toKai();
    await as(lin).patch(`/api/knowledge/docs/${notes.id}`, { version: 2, content: 'For all.' });
    expect(toKai()).toHaveLength(1);
  });

  it('tells about files of the tree, not about pictures pasted into a doc', async () => {
    const { app, as, heard, lin } = await setup();
    const toLin = heard(lin);
    const upload = async (fields: Record<string, string>) => {
      const form = new FormData();
      form.set('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      const response = await app.app.request('/api/knowledge/files', {
        method: 'POST',
        headers: { authorization: `Bearer ${lin.token}` },
        body: form,
      });
      return (await response.json()) as { id: string };
    };
    const file = await upload({ space: 'personal' });
    expect(toLin()).toHaveLength(1);
    await as(lin).patch(`/api/knowledge/files/${file.id}`, { name: 'hi.txt' });
    await as(lin).del(`/api/knowledge/files/${file.id}`);
    await as(lin).post(`/api/knowledge/files/${file.id}/restore`);
    expect(toLin()).toHaveLength(3);

    const doc = (await as(lin).post('/api/knowledge/docs', { title: 'With a picture' })).body;
    toLin();
    await upload({ doc_id: doc.id });
    expect(toLin()).toHaveLength(0);
  });
});
