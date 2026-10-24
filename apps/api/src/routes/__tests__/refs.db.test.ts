/**
 * POST /api/refs/resolve — titles for object chips, and above all what it must NOT reveal:
 * an object the caller may not read comes back with `title: null`, looking exactly like one
 * that does not exist.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { ResolveRefsResponse } from '@greenhouse/types/object-refs';
import type { AppEnv } from '../../app-env.js';
import { createRefsRoutes } from '../refs.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;

function createApp(users: UserRow[]) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/refs', createRefsRoutes());
  return app;
}

async function resolve(app: Hono<AppEnv>, userId: string, urls: unknown) {
  const res = await app.request('http://green.test/api/refs/resolve', {
    method: 'POST',
    headers: { 'x-test-user': userId, 'content-type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  return { status: res.status, body: (await res.json()) as ResolveRefsResponse & { error?: string } };
}

const titleOf = (body: ResolveRefsResponse, url: string) => body.items.find((item) => item.url === url)?.title;
const marker = () => `zz${Date.now()}${Math.trunc(performance.now())}`;

describe('POST /api/refs/resolve', () => {
  beforeEach(async () => {
    _resetProvider();
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [knowledgeRegistration, projectsRegistration, tablesRegistration]);
  });

  afterEach(() => {
    resetPlatformRuntimeForTests();
  });

  async function people(token: string) {
    const [owner, stranger] = await Promise.all([
      createInternalTestUser(db, { email: `refs-owner-${token}@test.local`, role: 'team' }),
      createInternalTestUser(db, { email: `refs-stranger-${token}@test.local`, role: 'team' }),
    ]);
    return { owner, stranger, app: createApp([owner, stranger]) };
  }

  it('resolves documents by visibility: team docs for everyone, private docs for the owner only', async () => {
    const token = marker();
    const { owner, stranger, app } = await people(token);
    const doc = (title: string, visibility: 'team' | 'private') =>
      db.knowledgeBase.create({
        doc_id: `${token}-${visibility}`,
        scope: 'shared',
        title,
        content: 'body',
        visibility,
        owner_user_id: owner.id,
        status: 'published',
        created_by: owner.id,
        updated_by: owner.id,
      });
    const team = await doc(`${token} team plan`, 'team');
    const secret = await doc(`${token} private notes`, 'private');
    const urls = [`#/knowledge/doc/${team.id}-team-plan`, `#/knowledge/doc/${secret.id}-private-notes`];

    const mine = await resolve(app, owner.id, urls);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((item) => item.title)).toEqual([`${token} team plan`, `${token} private notes`]);
    expect(mine.body.items[0]).toMatchObject({ type: 'doc', id: String(team.id) });

    const theirs = await resolve(app, stranger.id, urls);
    expect(titleOf(theirs.body, urls[0]!)).toBe(`${token} team plan`);
    expect(titleOf(theirs.body, urls[1]!)).toBeNull();
  });

  it('resolves the slug links the address bar shows, with the same rules', async () => {
    const token = marker();
    const { owner, stranger, app } = await people(token);
    const doc = (slug: string, title: string, visibility: 'team' | 'private') =>
      db.knowledgeBase.create({
        doc_id: slug,
        scope: 'shared',
        title,
        content: 'body',
        visibility,
        owner_user_id: owner.id,
        status: 'published',
        created_by: owner.id,
        updated_by: owner.id,
      });
    const team = await doc(`${token}-api-style-guide`, `${token} API style guide`, 'team');
    const secret = await doc(`${token}-salary`, `${token} salary`, 'private');
    const urls = [
      `http://green.test/#/knowledge/internal/general/${token}-api-style-guide`,
      `#/knowledge/personal/${token}-salary`,
      `#/knowledge/internal/general/${token}-nothing-here`,
    ];

    const mine = await resolve(app, owner.id, urls);
    expect(mine.body.items[0]).toEqual({
      url: urls[0],
      type: 'doc',
      id: String(team.id),
      title: `${token} API style guide`,
    });
    expect(mine.body.items[1]).toMatchObject({ type: 'doc', id: String(secret.id), title: `${token} salary` });

    // Forbidden and missing look the same: the slug from the link, no title, no id.
    const theirs = await resolve(app, stranger.id, urls);
    expect(titleOf(theirs.body, urls[0]!)).toBe(`${token} API style guide`);
    expect(theirs.body.items[1]).toEqual({ url: urls[1], type: 'doc', id: `${token}-salary`, title: null });
    expect(theirs.body.items[2]).toEqual({ url: urls[2], type: 'doc', id: `${token}-nothing-here`, title: null });
  });

  it('hides a missing object the same way as a forbidden one', async () => {
    const token = marker();
    const { stranger, app } = await people(token);
    const { body } = await resolve(app, stranger.id, ['#/knowledge/doc/999999999-gone', '#/projects/999999999']);
    expect(body.items).toEqual([
      { url: '#/knowledge/doc/999999999-gone', type: 'doc', id: '999999999', title: null },
      { url: '#/projects/999999999', type: 'project', id: '999999999', title: null },
    ]);
  });

  it('returns file name, size and type, and never another member’s private file', async () => {
    const token = marker();
    const { owner, stranger, app } = await people(token);
    const file = async (name: string, visibility: 'team' | 'private') => {
      const row = await db.drive.initFile({
        scope: 'kb',
        name,
        cos_key: `test/${token}/${name}`,
        content_type: 'application/pdf',
        size: 2048,
        visibility,
        owner_user_id: visibility === 'private' ? owner.id : null,
        uploaded_by: owner.id,
      });
      await db.drive.completeFile(row.id, { size: 2048 });
      return row;
    };
    const shared = await file(`${token}-pricing.pdf`, 'team');
    const personal = await file(`${token}-salary.pdf`, 'private');
    const folder = await db.drive.createFolder({
      scope: 'kb',
      visibility: 'private',
      owner_user_id: owner.id,
      name: `${token} contracts`,
      created_by: owner.id,
    });
    const urls = [
      `#/files?file=${shared.id}`,
      `#/files?shelf=personal&file=${personal.id}`,
      `#/files?folder=${folder.id}`,
    ];

    const theirs = await resolve(app, stranger.id, urls);
    expect(theirs.body.items[0]).toEqual({
      url: urls[0],
      type: 'file',
      id: String(shared.id),
      title: `${token}-pricing.pdf`,
      meta: { size: 2048, contentType: 'application/pdf' },
    });
    expect(theirs.body.items[1]).toMatchObject({ type: 'file', title: null });
    expect(theirs.body.items[1]!.meta).toBeUndefined();
    expect(theirs.body.items[2]).toMatchObject({ type: 'folder', title: null });

    const mine = await resolve(app, owner.id, urls);
    expect(mine.body.items.map((item) => item.title)).toEqual([
      `${token}-pricing.pdf`,
      `${token}-salary.pdf`,
      `${token} contracts`,
    ]);
  });

  it('follows project and task access, and rejects a task quoted under another project', async () => {
    const token = marker();
    const { owner, stranger, app } = await people(token);
    const hidden = await db.projects.createProject({
      title: `${token} private launch`,
      owner_id: owner.id,
      created_by: owner.id,
      visibility: 'private',
    });
    const open = await db.projects.createProject({
      title: `${token} open roadmap`,
      owner_id: owner.id,
      created_by: owner.id,
      visibility: 'public',
    });
    const task = await db.projects.createTask({
      project_id: hidden.id,
      title: `${token} sign contract`,
      created_by: owner.id,
    });
    const urls = [
      `#/projects/${hidden.id}`,
      `#/projects/${open.id}`,
      `#/projects/${hidden.id}?task=${task.id}`,
      `#/projects/${open.id}?task=${task.id}`,
    ];

    const mine = await resolve(app, owner.id, urls);
    expect(mine.body.items.map((item) => item.title)).toEqual([
      `${token} private launch`,
      `${token} open roadmap`,
      `${token} sign contract`,
      null,
    ]);
    expect(mine.body.items[2]).toMatchObject({ type: 'task', id: String(task.id) });

    const theirs = await resolve(app, stranger.id, urls);
    expect(theirs.body.items.map((item) => item.title)).toEqual([null, `${token} open roadmap`, null, null]);
  });

  it('titles a table record by its primary field, for members of the base only', async () => {
    const token = marker();
    const { owner, stranger, app } = await people(token);
    const base = await db.tables.createBase({
      name: `${token} ops`,
      visibility: 'private',
      owner_id: owner.id,
      created_by: owner.id,
    });
    const schema = await db.tables.createTable({ base_id: base.id, name: 'Items', created_by: owner.id });
    const record = await db.tables.createRecord({
      table_id: schema.table.id,
      values: { [schema.fields[0]!.id]: `${token} restock` },
      user_id: owner.id,
    });
    const url = `#/tables/${base.id}/table/${schema.table.id}?record=${record.id}`;
    // A real base the table does not belong to: the link names the wrong base.
    const otherBase = await db.tables.createBase({
      name: `${token} other`,
      visibility: 'private',
      owner_id: owner.id,
      created_by: owner.id,
    });
    const wrongBase = `#/tables/${otherBase.id}/table/${schema.table.id}?record=${record.id}`;

    const mine = await resolve(app, owner.id, [url, wrongBase]);
    expect(mine.body.items.map((item) => item.title)).toEqual([`${token} restock`, null]);
    const theirs = await resolve(app, stranger.id, [url]);
    expect(theirs.body.items[0]).toMatchObject({ type: 'record', title: null });
  });

  it('resolves conversations for their owner only', async () => {
    const token = marker();
    const { owner, stranger, app } = await people(token);
    const session = await db.sessions.create(`${token} weekly sync`, 'team', owner.id, undefined, 'web');
    const url = `#/chat?session=${session.id}`;
    expect(titleOf((await resolve(app, owner.id, [url])).body, url)).toBe(`${token} weekly sync`);
    expect(titleOf((await resolve(app, stranger.id, [url])).body, url)).toBeNull();
  });

  it('omits links that name no object, and accepts only this workspace’s absolute URLs', async () => {
    const token = marker();
    const { owner, app } = await people(token);
    const project = await db.projects.createProject({
      title: `${token} origin check`,
      owner_id: owner.id,
      created_by: owner.id,
      visibility: 'public',
    });
    const own = `http://green.test/#/projects/${project.id}`;
    const foreign = `https://elsewhere.example.com/#/projects/${project.id}`;
    const deep = `greenhouse://projects/detail?id=${project.id}`;
    const { body } = await resolve(app, owner.id, ['https://example.com/page', '#/projects', foreign, own, deep]);
    expect(body.items.map((item) => [item.url, item.title])).toEqual([
      [own, `${token} origin check`],
      [deep, `${token} origin check`],
    ]);
  });

  it('validates the request', async () => {
    const token = marker();
    const { owner, app } = await people(token);
    expect((await resolve(app, owner.id, 'nope')).status).toBe(400);
    expect((await resolve(app, owner.id, [1, 2])).status).toBe(400);
    expect(
      (
        await resolve(
          app,
          owner.id,
          Array.from({ length: 51 }, (_, i) => `#/projects/${i + 1}`),
        )
      ).status,
    ).toBe(400);
    expect((await resolve(app, owner.id, [])).body).toEqual({ items: [] });
  });
});
