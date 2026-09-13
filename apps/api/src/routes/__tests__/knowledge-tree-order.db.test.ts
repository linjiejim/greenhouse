/**
 * Sidebar tree ordering + whole-library export (real PostgreSQL).
 *
 * Two properties carry real risk and are pinned here: `/tree/reorder` must be
 * unable to MOVE anything (it is the one write that skips the move endpoints'
 * cross-scope checks), and `/export` must never sweep up someone's private docs
 * just because the caller is super.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { unzipSync, strFromU8 } from 'fflate';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import knowledgeRoutes from '../knowledge.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let superUser: UserRow;
let otherUser: UserRow;

function appFor(users: UserRow[]) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/knowledge', knowledgeRoutes);
  return app;
}

async function teamFolder(name: string, parentId?: number) {
  return db.drive.createFolder({
    scope: 'kb',
    name,
    parent_id: parentId ?? null,
    visibility: 'team',
    created_by: superUser.id,
  });
}

async function teamDoc(slug: string, title: string, folderId: number | null, content = `# ${title}`) {
  return db.knowledgeBase.create({
    doc_id: slug,
    title,
    content,
    visibility: 'team',
    status: 'published',
    folder_id: folderId,
    created_by: superUser.id,
  });
}

function reorder(app: ReturnType<typeof appFor>, user: UserRow, body: unknown) {
  return app.request('/api/knowledge/tree/reorder', {
    method: 'POST',
    headers: { 'x-test-user': user.id, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('knowledge tree ordering', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [knowledgeRegistration]);
    superUser = await createInternalTestUser(db, { email: 'kb-order-super@test.com', role: 'super' });
    otherUser = await createInternalTestUser(db, { email: 'kb-order-other@test.com' });
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('writes a manual doc order and reads it back', async () => {
    const folder = await teamFolder('手册');
    const a = await teamDoc('order/a', 'Alpha', folder.id);
    const b = await teamDoc('order/b', 'Beta', folder.id);
    const app = appFor([superUser]);

    const res = await reorder(app, superUser, { kind: 'doc', parent_id: folder.id, ids: [b.id, a.id] });
    expect(res.status).toBe(200);

    const rows = await db.knowledgeBase.listByIds([a.id, b.id]);
    expect(rows.find((r) => r.id === b.id)?.sort_order).toBe(1);
    expect(rows.find((r) => r.id === a.id)?.sort_order).toBe(2);
  });

  it('orders folders too', async () => {
    const root = await teamFolder('专栏');
    const first = await teamFolder('甲', root.id);
    const second = await teamFolder('乙', root.id);
    const app = appFor([superUser]);

    const res = await reorder(app, superUser, { kind: 'folder', parent_id: root.id, ids: [second.id, first.id] });
    expect(res.status).toBe(200);

    const listed = await db.drive.listFolders({ scope: 'kb', parent_id: root.id, visibility: 'team' });
    expect(listed.map((f) => f.name)).toEqual(['乙', '甲']);
  });

  it('refuses ids that are not already siblings — reorder can never move a node', async () => {
    const here = await teamFolder('此处');
    const elsewhere = await teamFolder('别处');
    const mine = await teamDoc('order/mine', 'Mine', here.id);
    const stranger = await teamDoc('order/stranger', 'Stranger', elsewhere.id);
    const app = appFor([superUser]);

    const res = await reorder(app, superUser, { kind: 'doc', parent_id: here.id, ids: [mine.id, stranger.id] });
    expect(res.status).toBe(400);
    // The outsider stayed put: no folder_id was touched.
    const after = await db.knowledgeBase.getById(stranger.id);
    expect(after?.folder_id).toBe(elsewhere.id);
  });

  it('refuses a group spanning two access domains at the root', async () => {
    const teamRoot = await teamDoc('order/team-root', 'Team root doc', null);
    const privateRoot = await db.knowledgeBase.create({
      doc_id: 'order/private-root',
      title: 'Private root doc',
      content: 'x',
      visibility: 'private',
      status: 'published',
      owner_user_id: superUser.id,
      created_by: superUser.id,
    });
    const app = appFor([superUser]);

    const res = await reorder(app, superUser, {
      kind: 'doc',
      parent_id: null,
      ids: [teamRoot.id, privateRoot.id],
    });
    expect(res.status).toBe(400);
  });

  it('refuses to order another user’s private docs', async () => {
    const theirs = await db.knowledgeBase.create({
      doc_id: 'order/theirs',
      title: 'Theirs',
      content: 'x',
      visibility: 'private',
      status: 'published',
      owner_user_id: otherUser.id,
      created_by: otherUser.id,
    });
    const app = appFor([superUser, otherUser]);

    const res = await reorder(app, superUser, { kind: 'doc', parent_id: null, ids: [theirs.id] });
    expect(res.status).toBe(404);
  });
});

describe('knowledge library export', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [knowledgeRegistration]);
    superUser = await createInternalTestUser(db, { email: 'kb-export-super@test.com', role: 'super' });
    otherUser = await createInternalTestUser(db, { email: 'kb-export-other@test.com' });
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('packs team docs into their folder tree and leaves private docs out', async () => {
    const root = await teamFolder('指南');
    const sub = await teamFolder('快速上手', root.id);
    await teamDoc('export/nested', '登录与界面导览', sub.id, '# 登录\n\n正文');
    await teamDoc('export/rooted', '根文档', null);
    await db.knowledgeBase.create({
      doc_id: 'export/secret',
      title: '别人的私人笔记',
      content: 'SECRET-MUST-NOT-EXPORT',
      visibility: 'private',
      status: 'published',
      owner_user_id: otherUser.id,
      created_by: otherUser.id,
    });

    const res = await appFor([superUser]).request('/api/knowledge/export', {
      headers: { 'x-test-user': superUser.id },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');

    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(entries);
    expect(names).toContain('指南/快速上手/登录与界面导览.md');
    expect(names).toContain('根文档.md');
    expect(names.some((n) => n.includes('私人'))).toBe(false);
    const everything = names.map((n) => strFromU8(entries[n])).join('\n');
    expect(everything).not.toContain('SECRET-MUST-NOT-EXPORT');
    // Front matter carries the doc_id so an edited archive can be matched back.
    expect(strFromU8(entries['指南/快速上手/登录与界面导览.md'])).toContain('doc_id: export/nested');
  });

  it('rewrites embedded upload links to a relative assets path and reports missing bytes', async () => {
    const folder = await teamFolder('图册');
    await teamDoc('export/with-image', '带图', folder.id, '![x](/api/upload/1700000000000-abcd1234.png)');

    const res = await appFor([superUser]).request('/api/knowledge/export', {
      headers: { 'x-test-user': superUser.id },
    });
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(strFromU8(entries['图册/带图.md'])).toContain('](../assets/1700000000000-abcd1234.png)');
    // The bytes are absent in the test store — that must be stated, not swallowed.
    expect(Object.keys(entries)).toContain('EXPORT-NOTES.md');
    expect(strFromU8(entries['EXPORT-NOTES.md'])).toContain('1700000000000-abcd1234.png');
  });

  it('narrows to one folder subtree, re-rooted at that folder', async () => {
    const root = await teamFolder('指南');
    const sub = await teamFolder('快速上手', root.id);
    const deeper = await teamFolder('更深', sub.id);
    await teamDoc('scope/in-sub', '子目录文档', sub.id);
    await teamDoc('scope/in-deeper', '更深的文档', deeper.id);
    await teamDoc('scope/outside', '范围外文档', root.id);

    const res = await appFor([superUser]).request(`/api/knowledge/export?folder_id=${sub.id}`, {
      headers: { 'x-test-user': superUser.id },
    });
    const names = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(names).toContain('快速上手/子目录文档.md');
    expect(names).toContain('快速上手/更深/更深的文档.md');
    expect(names.some((n) => n.includes('范围外'))).toBe(false);
  });

  it('narrows to a single document, packed flat', async () => {
    const folder = await teamFolder('手册');
    const one = await teamDoc('scope/one', '单篇', folder.id);
    await teamDoc('scope/two', '另一篇', folder.id);

    const res = await appFor([superUser]).request(`/api/knowledge/export?doc_id=${one.id}`, {
      headers: { 'x-test-user': superUser.id },
    });
    const names = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(names).toEqual(expect.arrayContaining(['单篇.md', 'README.md']));
    expect(names.some((n) => n.includes('另一篇'))).toBe(false);
    expect(names.some((n) => n.includes('手册/'))).toBe(false);
  });

  it('a scoped export still cannot reach a private doc', async () => {
    const theirs = await db.knowledgeBase.create({
      doc_id: 'scope/private',
      title: '私人',
      content: 'SECRET-SCOPED',
      visibility: 'private',
      status: 'published',
      owner_user_id: otherUser.id,
      created_by: otherUser.id,
    });

    const res = await appFor([superUser]).request(`/api/knowledge/export?doc_id=${theirs.id}`, {
      headers: { 'x-test-user': superUser.id },
    });
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const everything = Object.keys(entries)
      .map((n) => strFromU8(entries[n]))
      .join('\n');
    expect(everything).not.toContain('SECRET-SCOPED');
  });

  it('is closed to non-super internal users', async () => {
    const res = await appFor([superUser, otherUser]).request('/api/knowledge/export', {
      headers: { 'x-test-user': otherUser.id },
    });
    expect(res.status).toBe(403);
  });
});
