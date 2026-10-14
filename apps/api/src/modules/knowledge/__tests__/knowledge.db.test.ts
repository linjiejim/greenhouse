import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import {
  comments,
  docLinks,
  docVersions,
  getDb,
  groupMembers,
  groups,
  members,
  newId,
  notifications,
} from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

type App = ReturnType<typeof createTestApp>;
type Who = Awaited<ReturnType<App['member']>>;

async function setup() {
  const app = createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-knowledge-')) });
  const person = async (name: string, role: 'admin' | 'member' = 'member') => {
    const who = await app.member(role);
    await getDb().update(members).set({ name }).where(eq(members.id, who.id));
    return { ...who, name };
  };
  const lin = await person('Lin');
  const chen = await person('Chen');
  const as = (who: Who) => ({
    get: (path: string) => app.call('GET', path, { token: who.token }),
    post: (path: string, body: unknown = {}) => app.call('POST', path, { token: who.token, body }),
    patch: (path: string, body: unknown) => app.call('PATCH', path, { token: who.token, body }),
    put: (path: string, body: unknown) => app.call('PUT', path, { token: who.token, body }),
    del: (path: string) => app.call('DELETE', path, { token: who.token }),
  });
  async function upload(who: Who, file: File, fields: Record<string, string>) {
    const form = new FormData();
    form.set('file', file);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const response = await app.app.request('/api/knowledge/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${who.token}` },
      body: form,
    });
    return { status: response.status, body: (await response.json()) as any };
  }
  /** Realtime events a member's open sockets would get. */
  function listen(who: Who) {
    const events: RealtimeEvent[] = [];
    app.services.hub.subscribe(who.id, (event) => events.push(event));
    return events;
  }
  const notified = (who: Who) =>
    getDb().select().from(notifications).where(eq(notifications.memberId, who.id)).orderBy(notifications.id);
  return { app, lin, chen, person, as, upload, listen, notified };
}

describe('spaces and the tree', () => {
  it('gives every member the team space and each member a personal space of their own', async () => {
    const { lin, chen, as } = await setup();
    const policies = await as(lin).post('/api/knowledge/folders', { name: 'Policies', space: 'team' });
    expect(policies.status).toBe(201);
    expect(policies.body).toMatchObject({ type: 'folder', space: 'team', owner_id: null, access: 'editor', path: [] });
    const handbook = await as(lin).post('/api/knowledge/docs', {
      title: 'Handbook',
      content: 'Welcome.',
      folder_id: policies.body.id,
    });
    expect(handbook.status).toBe(201);
    expect(handbook.body).toMatchObject({
      space: 'team',
      version: 1,
      access: 'editor',
      path: [{ id: policies.body.id, name: 'Policies' }],
      created_by: { id: lin.id, name: 'Lin' },
    });

    // Everyone reads and writes the team space.
    const teamRoot = await as(chen).get('/api/knowledge/folders?space=team');
    expect(teamRoot.body.items.map((item: any) => item.name)).toEqual(['Policies']);
    const saved = await as(chen).patch(`/api/knowledge/docs/${handbook.body.id}`, {
      version: 1,
      content: 'Welcome, everyone.',
    });
    expect(saved.body).toMatchObject({ version: 2, updated_by: { id: chen.id, name: 'Chen' } });

    // A personal space is its owner's alone.
    const notes = await as(lin).post('/api/knowledge/docs', { title: 'My notes', content: 'private' });
    expect(notes.body).toMatchObject({ space: 'personal', owner_id: lin.id, access: 'owner' });
    expect((await as(chen).get(`/api/knowledge/docs/${notes.body.id}`)).status).toBe(404);
    expect((await as(chen).get('/api/knowledge/folders?space=personal')).body.items).toEqual([]);
    expect((await as(lin).get('/api/knowledge/folders?space=personal')).body.items).toEqual([
      expect.objectContaining({ type: 'doc', id: notes.body.id, access: 'owner' }),
    ]);
  });

  it('lists a folder in tree order, takes a hand order, and refuses folders inside themselves', async () => {
    const { lin, as } = await setup();
    const top = (await as(lin).post('/api/knowledge/folders', { name: 'Top' })).body;
    const make = async (body: object) => (await as(lin).post('/api/knowledge/docs', body)).body;
    const b = await make({ title: 'b', folder_id: top.id });
    const a = await make({ title: 'a', folder_id: top.id });
    const sub = (await as(lin).post('/api/knowledge/folders', { name: 'z', folder_id: top.id })).body;
    const deep = (await as(lin).post('/api/knowledge/folders', { name: 'deep', folder_id: sub.id })).body;
    const listed = await as(lin).get(`/api/knowledge/folders/${top.id}`);
    expect(listed.body.children.map((item: any) => item.name)).toEqual(['z', 'a', 'b']);
    expect((await as(lin).get(`/api/knowledge/folders/${deep.id}`)).body.path.map((entry: any) => entry.name)).toEqual([
      'Top',
      'z',
    ]);

    const order = await as(lin).post('/api/knowledge/reorder', {
      folder_id: top.id,
      items: [
        { type: 'doc', id: b.id },
        { type: 'folder', id: sub.id },
      ],
    });
    expect(order.status).toBe(204);
    expect((await as(lin).get(`/api/knowledge/folders/${top.id}`)).body.children.map((item: any) => item.name)).toEqual(
      ['b', 'z', 'a'],
    );
    const wrong = await as(lin).post('/api/knowledge/reorder', {
      folder_id: sub.id,
      items: [{ type: 'doc', id: a.id }],
    });
    expect(wrong.body.error.code).toBe('invalid_input');

    for (const target of [top.id, deep.id]) {
      const cycle = await as(lin).patch(`/api/knowledge/folders/${top.id}`, { folder_id: target });
      expect(cycle.status).toBe(409);
      expect(cycle.body.error.code).toBe('folder_cycle');
    }
    const moved = await as(lin).patch(`/api/knowledge/folders/${deep.id}`, { folder_id: null, name: 'Deep' });
    expect(moved.body).toMatchObject({ name: 'Deep', folder_id: null, path: [] });
  });

  it('moves personal items into the team space with what is in them, never back', async () => {
    const { lin, chen, as } = await setup();
    const drafts = (await as(lin).post('/api/knowledge/folders', { name: 'Drafts' })).body;
    const doc = (await as(lin).post('/api/knowledge/docs', { title: 'Plan', folder_id: drafts.id })).body;
    await as(lin).put(`/api/knowledge/docs/${doc.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'viewer' }],
    });

    // Someone with a share may not publish it to the team.
    await as(lin).put(`/api/knowledge/folders/${drafts.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'editor' }],
    });
    const notYours = await as(chen).patch(`/api/knowledge/folders/${drafts.id}`, { folder_id: null, space: 'team' });
    expect(notYours.status).toBe(403);

    const published = await as(lin).patch(`/api/knowledge/folders/${drafts.id}`, { folder_id: null, space: 'team' });
    expect(published.body).toMatchObject({ space: 'team', owner_id: null, access: 'editor', shared: false });
    const inside = await as(chen).get(`/api/knowledge/docs/${doc.id}`);
    expect(inside.body).toMatchObject({ space: 'team', owner_id: null, access: 'editor', shared: false });

    const back = await as(lin).patch(`/api/knowledge/docs/${doc.id}`, { folder_id: null, space: 'personal' });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('cross_space_move');
  });

  it('archives a folder with everything in it and restores exactly what went with it', async () => {
    const { lin, as } = await setup();
    const folder = (await as(lin).post('/api/knowledge/folders', { name: 'Old', space: 'team' })).body;
    const sub = (await as(lin).post('/api/knowledge/folders', { name: 'Sub', folder_id: folder.id })).body;
    const early = (await as(lin).post('/api/knowledge/docs', { title: 'Archived first', folder_id: folder.id })).body;
    const later = (await as(lin).post('/api/knowledge/docs', { title: 'Inside', folder_id: sub.id })).body;
    expect((await as(lin).del(`/api/knowledge/docs/${early.id}`)).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await as(lin).del(`/api/knowledge/folders/${folder.id}`)).status).toBe(204);

    expect((await as(lin).get('/api/knowledge/folders?space=team')).body.items).toEqual([]);
    expect((await as(lin).get(`/api/knowledge/docs/${later.id}`)).body.archived_at).toBeTruthy();
    const archived = await as(lin).get('/api/knowledge/archived?space=team');
    expect(archived.body.items.map((item: any) => item.name)).toEqual(['Old', 'Archived first']);
    // An archived folder shows what went with it.
    expect((await as(lin).get(`/api/knowledge/folders/${folder.id}`)).body.children.map((c: any) => c.name)).toEqual([
      'Sub',
      'Archived first',
    ]);
    const edit = await as(lin).patch(`/api/knowledge/docs/${later.id}`, { version: 1, content: 'x' });
    expect(edit.body.error.code).toBe('archived');
    const into = await as(lin).post('/api/knowledge/docs', { title: 'x', folder_id: folder.id });
    expect(into.body.error.code).toBe('archived');

    const restored = await as(lin).post(`/api/knowledge/folders/${folder.id}/restore`);
    expect(restored.body.children.map((child: any) => child.name)).toEqual(['Sub']);
    expect((await as(lin).get(`/api/knowledge/docs/${later.id}`)).body.archived_at).toBeNull();
    expect((await as(lin).get(`/api/knowledge/docs/${early.id}`)).body.archived_at).toBeTruthy();
    const back = await as(lin).post(`/api/knowledge/docs/${early.id}/restore`);
    expect(back.body).toMatchObject({ archived_at: null, folder_id: folder.id });
  });

  it('is closed to a member whose knowledge module is off, and an admin reads nothing extra', async () => {
    const { app, lin, chen, person, as } = await setup();
    const admin = await person('Admin', 'admin');
    const notes = (await as(lin).post('/api/knowledge/docs', { title: 'Mine' })).body;
    expect((await as(admin).get(`/api/knowledge/docs/${notes.id}`)).status).toBe(404);
    await app.call('PATCH', `/api/admin/members/${chen.id}`, {
      token: admin.token,
      body: { modules: { knowledge: false } },
    });
    const closed = await as(chen).get('/api/knowledge/folders?space=team');
    expect(closed.status).toBe(403);
    await as(lin).post('/api/knowledge/docs', { title: 'Team plan', space: 'team' });
    const found = await as(chen).get('/api/search?q=plan&kinds=docs');
    expect(found.body.items).toEqual([]);
  });
});

describe('docs, versions and templates', () => {
  it('refuses a stale save and keeps every version', async () => {
    const { lin, chen, as } = await setup();
    const doc = (await as(lin).post('/api/knowledge/docs', { title: 'Plan', content: 'one\ntwo\n', space: 'team' }))
      .body;
    const mine = await as(lin).patch(`/api/knowledge/docs/${doc.id}`, {
      version: 1,
      content: 'one\n2\n',
      change_note: 'numbers',
    });
    expect(mine.body.version).toBe(2);
    const late = await as(chen).patch(`/api/knowledge/docs/${doc.id}`, { version: 1, content: 'one\ntwo\nthree\n' });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: 'stale_version', details: { version: 2, updated_by: lin.id } });
    const noVersion = await as(chen).patch(`/api/knowledge/docs/${doc.id}`, { content: 'x' });
    expect(noVersion.body.error.code).toBe('invalid_input');

    // Tags, summary and the template flag change in place: no new version.
    const tagged = await as(chen).patch(`/api/knowledge/docs/${doc.id}`, {
      tags: ['plans'],
      meta: { summary: 'The plan for Q4' },
    });
    expect(tagged.body).toMatchObject({ version: 2, tags: ['plans'], meta: { summary: 'The plan for Q4' } });
    // The same content again writes nothing.
    expect(
      (await as(chen).patch(`/api/knowledge/docs/${doc.id}`, { version: 2, content: 'one\n2\n' })).body.version,
    ).toBe(2);

    const versions = await as(chen).get(`/api/knowledge/docs/${doc.id}/versions`);
    expect(versions.body.items).toEqual([
      expect.objectContaining({
        version: 2,
        change_note: 'numbers',
        created_by: { id: lin.id, name: 'Lin' },
        agent: null,
      }),
      expect.objectContaining({ version: 1, change_note: '' }),
    ]);
    expect((await as(chen).get(`/api/knowledge/docs/${doc.id}/versions/1`)).body).toMatchObject({
      version: 1,
      content: 'one\ntwo\n',
    });
    expect((await as(chen).get(`/api/knowledge/docs/${doc.id}/versions/9`)).status).toBe(404);

    const diff = await as(chen).get(`/api/knowledge/docs/${doc.id}/diff`);
    expect(diff.body).toMatchObject({ from: 1, to: 2, mode: 'line', added: 1, removed: 1, title: null });
    expect(diff.body.hunks[0].parts).toEqual([
      { op: 'equal', text: 'one\n' },
      { op: 'delete', text: 'two\n' },
      { op: 'insert', text: '2\n' },
    ]);
    const words = await as(chen).get(`/api/knowledge/docs/${doc.id}/diff?from=1&to=2&mode=word`);
    expect(words.body.hunks[0].parts.filter((part: any) => part.op !== 'equal')).toEqual([
      { op: 'delete', text: 'two' },
      { op: 'insert', text: '2' },
    ]);

    const stale = await as(chen).post(`/api/knowledge/docs/${doc.id}/versions/1/restore`, { version: 1 });
    expect(stale.body.error.code).toBe('stale_version');
    const restored = await as(chen).post(`/api/knowledge/docs/${doc.id}/versions/1/restore`, { version: 2 });
    expect(restored.body).toMatchObject({ version: 3, content: 'one\ntwo\n' });
    const [third] = await getDb()
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.docId, doc.id), eq(docVersions.version, 3)));
    expect(third).toMatchObject({ changeNote: '恢复到版本 1', createdBy: chen.id, content: 'one\ntwo\n' });
  });

  it('starts new docs from templates and lists recent docs', async () => {
    const { lin, chen, as } = await setup();
    const template = (
      await as(lin).post('/api/knowledge/docs', {
        title: 'Weekly report',
        content: '## Done\n\n## Next\n',
        tags: ['report'],
        is_template: true,
        space: 'team',
      })
    ).body;
    await as(lin).post('/api/knowledge/docs', { title: 'Private template', is_template: true });
    const templates = await as(chen).get('/api/knowledge/docs?template=true');
    expect(templates.body.items.map((item: any) => item.name)).toEqual(['Weekly report']);

    const fresh = await as(chen).post('/api/knowledge/docs', { template_id: template.id, space: 'personal' });
    expect(fresh.body).toMatchObject({
      title: 'Weekly report',
      content: '## Done\n\n## Next\n',
      tags: ['report'],
      is_template: false,
      space: 'personal',
      owner_id: chen.id,
    });
    const notTemplate = await as(chen).post('/api/knowledge/docs', { template_id: fresh.body.id });
    expect(notTemplate.body.error.code).toBe('invalid_input');

    for (let index = 0; index < 3; index++) await as(chen).post('/api/knowledge/docs', { title: `Note ${index}` });
    const first = await as(chen).get('/api/knowledge/docs?limit=2');
    expect(first.body.items.map((item: any) => item.name)).toEqual(['Note 2', 'Note 1']);
    const second = await as(chen).get(`/api/knowledge/docs?limit=2&cursor=${first.body.next_cursor}`);
    expect(second.body.items.map((item: any) => item.name)).toEqual(['Note 0', 'Weekly report']);
    const mine = await as(chen).get('/api/knowledge/docs?space=team');
    expect(mine.body.items.map((item: any) => item.name)).toEqual(['Weekly report']);
  });
});

describe('sharing', () => {
  it('shares down the tree with members, groups and the workspace, never narrower', async () => {
    const { app, lin, chen, person, as, notified } = await setup();
    const wu = await person('Wu');
    const folder = (await as(lin).post('/api/knowledge/folders', { name: 'Project' })).body;
    const sub = (await as(lin).post('/api/knowledge/folders', { name: 'Specs', folder_id: folder.id })).body;
    const brief = (await as(lin).post('/api/knowledge/docs', { title: 'Brief', folder_id: folder.id })).body;
    const spec = (await as(lin).post('/api/knowledge/docs', { title: 'Spec', folder_id: sub.id })).body;

    const viewers = await as(lin).put(`/api/knowledge/folders/${folder.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'viewer' }],
    });
    expect(viewers.body.items).toEqual([{ type: 'member', id: chen.id, name: 'Chen', role: 'viewer' }]);
    expect((await notified(chen)).map((row) => [row.kind, row.title, row.targetId])).toEqual([
      ['share', 'Lin 把《Project》分享给了你', folder.id],
    ]);
    expect((await as(chen).get(`/api/knowledge/docs/${spec.id}`)).body.access).toBe('viewer');
    expect((await as(chen).patch(`/api/knowledge/docs/${spec.id}`, { version: 1, content: 'x' })).status).toBe(403);
    // Only the topmost shared item is listed; the rest is reached by opening it.
    const shared = await as(chen).get('/api/knowledge/folders?space=shared');
    expect(shared.body.items).toEqual([expect.objectContaining({ id: folder.id, access: 'viewer', shared: true })]);

    // A share below widens what comes from above.
    await as(lin).put(`/api/knowledge/docs/${brief.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'editor' }],
    });
    expect((await as(chen).get(`/api/knowledge/docs/${brief.id}`)).body.access).toBe('editor');
    expect((await as(chen).patch(`/api/knowledge/docs/${brief.id}`, { version: 1, content: 'ok' })).status).toBe(200);
    const view = await as(chen).get(`/api/knowledge/docs/${brief.id}/share`);
    expect(view.body).toEqual({
      items: [{ type: 'member', id: chen.id, name: 'Chen', role: 'editor' }],
      inherited: [
        { type: 'member', id: chen.id, name: 'Chen', role: 'viewer', folder_id: folder.id, folder_name: 'Project' },
      ],
    });

    // A group: its members get the folder, the rest of the space stays closed.
    const [group] = await getDb()
      .insert(groups)
      .values({ id: newId('group'), name: 'Design' })
      .returning();
    await getDb().insert(groupMembers).values({ groupId: group!.id, memberId: wu.id });
    await as(lin).put(`/api/knowledge/folders/${sub.id}/share`, {
      items: [{ type: 'group', id: group!.id, role: 'editor' }],
    });
    expect((await as(wu).get(`/api/knowledge/docs/${spec.id}`)).body.access).toBe('editor');
    expect((await as(wu).get(`/api/knowledge/docs/${brief.id}`)).status).toBe(404);
    expect((await notified(wu)).map((row) => row.kind)).toEqual(['share']);
    // Chen gets editor on the subfolder only through the group she is not in: still a viewer there.
    expect((await as(chen).get(`/api/knowledge/docs/${spec.id}`)).body.access).toBe('viewer');

    // Only the owner shares; the team space needs no shares.
    const notOwner = await as(chen).put(`/api/knowledge/docs/${brief.id}/share`, { items: [] });
    expect(notOwner.status).toBe(403);
    const teamDoc = (await as(lin).post('/api/knowledge/docs', { title: 'Team', space: 'team' })).body;
    expect((await as(lin).put(`/api/knowledge/docs/${teamDoc.id}/share`, { items: [] })).body.error.code).toBe(
      'team_space',
    );
    const unknown = await as(lin).put(`/api/knowledge/docs/${brief.id}/share`, {
      items: [{ type: 'member', id: newId('member'), role: 'viewer' }],
    });
    expect(unknown.body.error.code).toBe('invalid_input');

    // Unsharing closes it again; the workspace opens it to everyone.
    await as(lin).put(`/api/knowledge/folders/${folder.id}/share`, { items: [] });
    await as(lin).put(`/api/knowledge/docs/${brief.id}/share`, { items: [] });
    expect((await as(chen).get(`/api/knowledge/docs/${brief.id}`)).status).toBe(404);
    await as(lin).put(`/api/knowledge/docs/${brief.id}/share`, { items: [{ type: 'workspace', role: 'viewer' }] });
    expect((await as(chen).get(`/api/knowledge/docs/${brief.id}`)).body.access).toBe('viewer');
    expect(app).toBeTruthy();
  });

  it('never shows the owner’s folders above what was shared', async () => {
    const { lin, chen, person, as } = await setup();
    const wu = await person('Wu');
    const secret = (await as(lin).post('/api/knowledge/folders', { name: 'Secret' })).body;
    const client = (await as(lin).post('/api/knowledge/folders', { name: 'Client X', folder_id: secret.id })).body;
    const notes = (await as(lin).post('/api/knowledge/docs', { title: 'Kickoff notes', folder_id: client.id })).body;
    const memo = (await as(lin).post('/api/knowledge/docs', { title: 'Kickoff memo', folder_id: secret.id })).body;
    await as(lin).put(`/api/knowledge/folders/${secret.id}/share`, {
      items: [{ type: 'member', id: wu.id, role: 'viewer' }],
    });
    await as(lin).put(`/api/knowledge/folders/${client.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'viewer' }],
    });
    await as(lin).put(`/api/knowledge/docs/${memo.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'viewer' }],
    });

    expect((await as(lin).get(`/api/knowledge/docs/${notes.id}`)).body.path.map((e: any) => e.name)).toEqual([
      'Secret',
      'Client X',
    ]);
    expect((await as(chen).get(`/api/knowledge/docs/${notes.id}`)).body.path.map((e: any) => e.name)).toEqual([
      'Client X',
    ]);
    expect((await as(chen).get(`/api/knowledge/folders/${client.id}`)).body.path).toEqual([]);
    expect((await as(chen).get(`/api/knowledge/docs/${memo.id}`)).body.path).toEqual([]);
    const hits = await as(chen).get('/api/knowledge/search?q=kickoff');
    expect(hits.body.items.map((hit: any) => [hit.title, hit.path.map((e: any) => e.name)])).toEqual(
      expect.arrayContaining([
        ['Kickoff notes', ['Client X']],
        ['Kickoff memo', []],
      ]),
    );
    // Shares from folders Chen cannot see stay out of what Chen is shown.
    expect((await as(chen).get(`/api/knowledge/docs/${notes.id}/share`)).body).toEqual({
      items: [],
      inherited: [
        { type: 'member', id: chen.id, name: 'Chen', role: 'viewer', folder_id: client.id, folder_name: 'Client X' },
      ],
    });
    expect((await as(lin).get(`/api/knowledge/docs/${notes.id}/share`)).body.inherited).toHaveLength(2);
  });

  it('shows backlinks only from docs the reader may read', async () => {
    const { lin, chen, as } = await setup();
    const target = (await as(lin).post('/api/knowledge/docs', { title: 'Glossary', space: 'team' })).body;
    const link = `[Glossary](#/knowledge/${target.id})`;
    const privateDoc = (await as(lin).post('/api/knowledge/docs', { title: 'My notes', content: `See ${link}` })).body;
    const teamDoc = (
      await as(chen).post('/api/knowledge/docs', { title: 'Onboarding', content: `Read ${link}.`, space: 'team' })
    ).body;
    expect(
      (await as(lin).get(`/api/knowledge/docs/${target.id}/backlinks`)).body.items.map((item: any) => item.name).sort(),
    ).toEqual(['My notes', 'Onboarding']);
    expect(
      (await as(chen).get(`/api/knowledge/docs/${target.id}/backlinks`)).body.items.map((i: any) => i.name),
    ).toEqual(['Onboarding']);
    // Saving without the link drops it.
    await as(lin).patch(`/api/knowledge/docs/${privateDoc.id}`, { version: 1, content: 'Nothing here.' });
    expect(await getDb().select().from(docLinks).where(eq(docLinks.toDocId, target.id))).toEqual([
      { fromDocId: teamDoc.id, toDocId: target.id },
    ]);
  });
});

describe('comments and mentions', () => {
  it('tells mentioned readers and the doc’s people, and lets authors change only their own', async () => {
    const { lin, chen, person, as, notified } = await setup();
    const wu = await person('Wu');
    const doc = (await as(lin).post('/api/knowledge/docs', { title: 'Plan', content: 'Draft.' })).body;
    await as(lin).put(`/api/knowledge/docs/${doc.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'viewer' }],
    });

    const first = await as(chen).post(`/api/knowledge/docs/${doc.id}/comments`, {
      body: `Looks good [@Lin](member:${lin.id}), and [@Wu](member:${wu.id}) should see it.`,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      mentions: [lin.id, wu.id],
      mine: true,
      created_by: { id: chen.id, name: 'Chen' },
    });
    // Wu cannot read the doc: no notification that leads nowhere.
    expect(await notified(wu)).toEqual([]);
    expect((await notified(lin)).map((row) => [row.kind, row.title, row.targetType])).toEqual([
      ['mention', 'Chen 在《Plan》的评论里提到了你', 'doc'],
    ]);

    // The owner answers: Chen commented before, so Chen hears about it.
    await as(lin).post(`/api/knowledge/docs/${doc.id}/comments`, { body: 'Thanks!' });
    expect((await notified(chen)).filter((row) => row.kind === 'comment').map((row) => row.title)).toEqual([
      'Lin 评论了《Plan》',
    ]);

    const list = await as(lin).get(`/api/knowledge/docs/${doc.id}/comments`);
    expect(list.body.items.map((item: any) => [item.created_by.name, item.mine])).toEqual([
      ['Chen', false],
      ['Lin', true],
    ]);
    const theirs = await as(lin).patch(`/api/knowledge/docs/${doc.id}/comments/${first.body.id}`, { body: 'x' });
    expect(theirs.status).toBe(403);
    const edited = await as(chen).patch(`/api/knowledge/docs/${doc.id}/comments/${first.body.id}`, {
      body: `Looks good [@Lin](member:${lin.id}).`,
    });
    expect(edited.body).toMatchObject({ edited: true, mentions: [lin.id] });
    expect((await as(chen).del(`/api/knowledge/docs/${doc.id}/comments/${first.body.id}`)).status).toBe(204);
    expect((await as(lin).get(`/api/knowledge/docs/${doc.id}/comments`)).body.items).toHaveLength(1);
    expect((await as(wu).get(`/api/knowledge/docs/${doc.id}/comments`)).status).toBe(404);
  });

  it('tells members newly mentioned in a doc when it is saved', async () => {
    const { lin, chen, as, notified } = await setup();
    const doc = (
      await as(lin).post('/api/knowledge/docs', {
        title: 'Roles',
        content: `Owner: [@Chen](member:${chen.id})`,
        space: 'team',
      })
    ).body;
    await as(lin).patch(`/api/knowledge/docs/${doc.id}`, { version: 1, content: `Owner: [@Chen](member:${chen.id}).` });
    expect((await notified(chen)).map((row) => [row.kind, row.title])).toEqual([
      ['mention', 'Lin 在《Roles》里提到了你'],
    ]);
  });
});

describe('presence and realtime', () => {
  it('tells who has a doc open and pushes saves and comments to them', async () => {
    const { lin, chen, as, listen } = await setup();
    const doc = (await as(lin).post('/api/knowledge/docs', { title: 'Live', content: 'a', space: 'team' })).body;
    const chenEvents = listen(chen);
    const viewing = await as(chen).put(`/api/knowledge/docs/${doc.id}/presence`, { state: 'viewing' });
    expect(viewing.body.items).toEqual([
      expect.objectContaining({ member_id: chen.id, name: 'Chen', state: 'viewing' }),
    ]);
    await as(lin).put(`/api/knowledge/docs/${doc.id}/presence`, { state: 'editing' });
    expect((await as(chen).get(`/api/knowledge/docs/${doc.id}/presence`)).body.items.map((i: any) => i.state)).toEqual([
      'viewing',
      'editing',
    ]);
    await as(lin).patch(`/api/knowledge/docs/${doc.id}`, { version: 1, content: 'b' });
    await as(lin).post(`/api/knowledge/docs/${doc.id}/comments`, { body: 'Saved.' });
    expect((await as(lin).del(`/api/knowledge/docs/${doc.id}/presence`)).status).toBe(204);
    expect(chenEvents.map((event) => event.type)).toEqual([
      'doc.presence',
      'doc.presence',
      'doc.updated',
      'comments.updated',
      'doc.presence',
    ]);
    expect(chenEvents[2]).toEqual({
      type: 'doc.updated',
      data: { doc_id: doc.id, version: 2, title: 'Live', updated_by: lin.id, archived: false },
    });

    // Someone who may only read cannot claim to be editing.
    const mine = (await as(lin).post('/api/knowledge/docs', { title: 'Mine' })).body;
    await as(lin).put(`/api/knowledge/docs/${mine.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'viewer' }],
    });
    expect((await as(chen).put(`/api/knowledge/docs/${mine.id}/presence`, { state: 'editing' })).status).toBe(403);
  });
});

describe('files in the tree', () => {
  it('uploads into a folder and serves the bytes only to who may read it', async () => {
    const { app, lin, chen, as, upload } = await setup();
    const folder = (await as(lin).post('/api/knowledge/folders', { name: 'Specs' })).body;
    const stored = await upload(lin, new File(['水位低时报警。LPH64 manual'], 'manual.md', { type: 'text/markdown' }), {
      folder_id: folder.id,
    });
    expect(stored.status).toBe(201);
    expect(stored.body).toMatchObject({
      type: 'file',
      name: 'manual.md',
      folder_id: folder.id,
      space: 'personal',
      owner_id: lin.id,
      access: 'owner',
      preview: 'text',
      doc_id: null,
    });
    const bytes = await app.app.request(stored.body.url);
    expect(await bytes.text()).toBe('水位低时报警。LPH64 manual');
    expect((await as(chen).get(`/api/knowledge/files/${stored.body.id}`)).status).toBe(404);
    // Chen's own signed URL does not open it either.
    const forChen = app.services.files.signedUrl(stored.body.id, chen.id).url;
    expect((await app.app.request(forChen)).status).toBe(404);
    // The generic delete is not how knowledge files go.
    expect((await app.call('DELETE', `/api/files/${stored.body.id}`, { token: lin.token })).body.error.code).toBe(
      'file_governed',
    );

    await as(lin).put(`/api/knowledge/folders/${folder.id}/share`, {
      items: [{ type: 'member', id: chen.id, role: 'viewer' }],
    });
    const shared = await as(chen).get(`/api/knowledge/files/${stored.body.id}`);
    expect(shared.body.access).toBe('viewer');
    expect((await app.app.request(shared.body.url)).status).toBe(200);
    expect((await as(chen).get(`/api/knowledge/folders/${folder.id}`)).body.children.map((c: any) => c.name)).toEqual([
      'manual.md',
    ]);
    // Found by its text.
    const found = await as(chen).get('/api/knowledge/search?q=水位');
    expect(found.body.items).toEqual([
      expect.objectContaining({ type: 'file', id: stored.body.id, snippet: expect.stringContaining('水位') }),
    ]);

    const renamed = await as(lin).patch(`/api/knowledge/files/${stored.body.id}`, {
      name: 'LPH manual.md',
      folder_id: null,
    });
    expect(renamed.body).toMatchObject({ name: 'LPH manual.md', folder_id: null });
    expect((await as(lin).del(`/api/knowledge/files/${stored.body.id}`)).status).toBe(204);
    expect((await as(lin).get('/api/knowledge/folders?space=personal')).body.items.map((i: any) => i.name)).toEqual([
      'Specs',
    ]);
    const back = await as(lin).post(`/api/knowledge/files/${stored.body.id}/restore`);
    expect(back.body.archived_at).toBeNull();
  });

  it('keeps pictures pasted into a doc with the doc and signs them for each reader', async () => {
    const { app, lin, chen, as, upload } = await setup();
    const doc = (await as(lin).post('/api/knowledge/docs', { title: 'Diagram', content: 'x', space: 'team' })).body;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const picture = await upload(lin, new File([png], 'paste.png', { type: 'image/png' }), { doc_id: doc.id });
    expect(picture.body).toMatchObject({ doc_id: doc.id, preview: 'image', folder_id: null });
    expect((await as(lin).get('/api/knowledge/folders?space=team')).body.items.map((i: any) => i.type)).toEqual([
      'doc',
    ]);

    // Saved with Lin's signed URL; stored without it; read back signed for Chen.
    const saved = await as(lin).patch(`/api/knowledge/docs/${doc.id}`, {
      version: 1,
      content: `![diagram](${picture.body.url})`,
    });
    const [row] = await getDb()
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.docId, doc.id), eq(docVersions.version, 2)));
    expect(row!.content).toBe(`![diagram](/api/files/${picture.body.id}/content)`);
    expect(saved.body.content).toContain(`m=${lin.id}`);
    const forChen = await as(chen).get(`/api/knowledge/docs/${doc.id}`);
    const url = /\((\/api\/files\/[^)]+)\)/.exec(forChen.body.content)![1]!;
    expect(url).toContain(`m=${chen.id}`);
    expect((await app.app.request(url)).status).toBe(200);
    expect((await as(chen).del(`/api/knowledge/files/${picture.body.id}`)).body.error.code).toBe('doc_file');

    // Only this server's links are signed: the same path on another host, or inside another
    // address, stays as written, so a reader's signature never goes anywhere else.
    const outside = `https://outside.example/api/files/${picture.body.id}/content`;
    const nested = `[x](https://outside.example/(/api/files/${picture.body.id}/content))`;
    await as(lin).patch(`/api/knowledge/docs/${doc.id}`, {
      version: 2,
      content: `![ours](http://greenhouse.test/api/files/${picture.body.id}/content)\n\n![theirs](${outside})\n\n${nested}`,
    });
    const read = (await as(chen).get(`/api/knowledge/docs/${doc.id}`)).body.content as string;
    expect(read).toContain(`![ours](http://greenhouse.test/api/files/${picture.body.id}/content?exp=`);
    expect(read).toContain(`![theirs](${outside})`);
    expect(read).toContain(nested);
    expect(read.match(/sig=/g)).toHaveLength(1);
    const version = (await as(chen).get(`/api/knowledge/docs/${doc.id}/versions/3`)).body.content as string;
    expect(version.match(/sig=/g)).toHaveLength(1);
    expect(version).toContain(`m=${chen.id}`);
  });

  it('keeps comments free of signatures and signs their pictures for each reader', async () => {
    const { app, lin, chen, as, upload } = await setup();
    const doc = (await as(lin).post('/api/knowledge/docs', { title: 'Review', content: 'x', space: 'team' })).body;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const picture = (await upload(lin, new File([png], 'shot.png', { type: 'image/png' }), { doc_id: doc.id })).body;
    const outside = `https://outside.example/api/files/${picture.id}/content?sig=theirs`;
    const posted = await as(lin).post(`/api/knowledge/docs/${doc.id}/comments`, {
      body: `Look: ![shot](${picture.url}) and [elsewhere](${outside})`,
    });
    const [stored] = await getDb().select().from(comments).where(eq(comments.id, posted.body.id));
    expect(stored!.body).toBe(`Look: ![shot](/api/files/${picture.id}/content) and [elsewhere](${outside})`);
    expect(posted.body.body).toContain(`m=${lin.id}`);
    const forChen = (await as(chen).get(`/api/knowledge/docs/${doc.id}/comments`)).body.items[0];
    const url = /\((\/api\/files\/[^)]+)\)/.exec(forChen.body)![1]!;
    expect(url).toContain(`m=${chen.id}`);
    expect(forChen.body).toContain(`[elsewhere](${outside})`);
    expect((await app.app.request(url)).status).toBe(200);
  });
});

describe('export', () => {
  it('exports a doc as Markdown and a folder as a ZIP of Markdown files and its files', async () => {
    const { app, lin, chen, as, upload } = await setup();
    const folder = (await as(lin).post('/api/knowledge/folders', { name: 'Handbook', space: 'team' })).body;
    const sub = (await as(lin).post('/api/knowledge/folders', { name: '人事', folder_id: folder.id })).body;
    const leave = (await as(lin).post('/api/knowledge/docs', { title: 'Leave', content: 'Ask HR.', folder_id: sub.id }))
      .body;
    const form = await upload(lin, new File(['%PDF-1.4 form'], 'form.pdf', { type: 'application/pdf' }), {
      folder_id: sub.id,
    });
    await as(lin).post('/api/knowledge/docs', {
      title: 'Welcome',
      content: `Read [Leave](#/knowledge/${leave.id}) and fill [the form](/api/files/${form.body.id}/content).`,
      folder_id: folder.id,
    });

    const markdown = await app.app.request(`/api/knowledge/docs/${leave.id}/export`, {
      headers: { authorization: `Bearer ${chen.token}` },
    });
    expect(markdown.headers.get('content-disposition')).toContain("filename*=UTF-8''Leave.md");
    expect(await markdown.text()).toBe('# Leave\n\nAsk HR.\n');

    const zip = await app.app.request(`/api/knowledge/folders/${folder.id}/export`, {
      headers: { authorization: `Bearer ${chen.token}` },
    });
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const entries = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(['README.md', 'Welcome.md', '人事/Leave.md', '人事/form.pdf']);
    expect(strFromU8(entries['Welcome.md']!)).toContain(
      'Read [Leave](人事/Leave.md) and fill [the form](人事/form.pdf).',
    );
    expect(strFromU8(entries['人事/form.pdf']!)).toBe('%PDF-1.4 form');
    expect(strFromU8(entries['README.md']!)).toContain('Handbook');

    const space = await app.app.request('/api/knowledge/export?space=team', {
      headers: { authorization: `Bearer ${chen.token}` },
    });
    expect(Object.keys(unzipSync(new Uint8Array(await space.arrayBuffer())))).toContain('Handbook/人事/Leave.md');
    const mine = (await as(lin).post('/api/knowledge/folders', { name: 'Private' })).body;
    expect((await as(chen).get(`/api/knowledge/folders/${mine.id}/export`)).status).toBe(404);
  });
});

describe('search', () => {
  it('finds what the reader may see in Chinese and English, title matches first, with snippets', async () => {
    const { lin, chen, as } = await setup();
    const report = (
      await as(lin).post('/api/knowledge/docs', {
        title: '周报模板',
        content: '每周五提交周报，写清楚进展和风险。',
        space: 'team',
      })
    ).body;
    const mention = (
      await as(lin).post('/api/knowledge/docs', {
        title: 'Team rituals',
        content: `${'Intro. '.repeat(40)}We share the 周报 every Friday.`,
        space: 'team',
      })
    ).body;
    const device = (
      await as(lin).post('/api/knowledge/docs', { title: 'LPH64 alarms', content: '水位低时会触发报警。' })
    ).body;

    const ranked = await as(chen).get('/api/knowledge/search?q=周报');
    expect(ranked.body.items.map((hit: any) => hit.id)).toEqual([report.id, mention.id]);
    expect(ranked.body.items[1].snippet).toContain('周报');
    expect(ranked.body.items[1].snippet.startsWith('…')).toBe(true);
    // Part of a long word, with the word written differently.
    expect((await as(chen).get('/api/knowledge/search?q=周五')).body.items.map((hit: any) => hit.id)).toEqual([
      report.id,
    ]);
    expect((await as(chen).get('/api/knowledge/search?q=RITUAL')).body.items.map((hit: any) => hit.id)).toEqual([
      mention.id,
    ]);

    // Personal docs: their owner finds them, others do not.
    expect((await as(lin).get('/api/knowledge/search?q=LPH64 报警')).body.items.map((hit: any) => hit.id)).toEqual([
      device.id,
    ]);
    expect((await as(chen).get('/api/knowledge/search?q=LPH64')).body.items).toEqual([]);
    // Inside a word, where the index cannot look.
    expect((await as(lin).get('/api/knowledge/search?q=PH6')).body.items.map((hit: any) => hit.id)).toEqual([
      device.id,
    ]);
    // Narrowed to a space, and archived docs are gone.
    expect((await as(lin).get('/api/knowledge/search?q=周报&space=personal')).body.items).toEqual([]);
    await as(lin).del(`/api/knowledge/docs/${report.id}`);
    expect((await as(chen).get('/api/knowledge/search?q=周报模板')).body.items.map((hit: any) => hit.id)).toEqual([
      mention.id,
    ]);

    // ⌘K lists docs next to the rest.
    const palette = await as(chen).get('/api/search?q=rituals&kinds=docs');
    expect(palette.body.items).toEqual([
      expect.objectContaining({ kind: 'docs', id: mention.id, title: 'Team rituals' }),
    ]);
  });

  it('carries the path of each hit and searches inside a folder', async () => {
    const { lin, as } = await setup();
    const top = (await as(lin).post('/api/knowledge/folders', { name: 'Ops', space: 'team' })).body;
    const sub = (await as(lin).post('/api/knowledge/folders', { name: 'Runbooks', folder_id: top.id })).body;
    const runbook = (await as(lin).post('/api/knowledge/docs', { title: 'Restart the pump', folder_id: sub.id })).body;
    await as(lin).post('/api/knowledge/docs', { title: 'Pump vendors', space: 'team' });
    const hits = await as(lin).get(`/api/knowledge/search?q=pump&folder_id=${top.id}`);
    expect(hits.body.items).toEqual([
      expect.objectContaining({
        id: runbook.id,
        path: [
          { id: top.id, name: 'Ops' },
          { id: sub.id, name: 'Runbooks' },
        ],
      }),
    ]);
  });
});
