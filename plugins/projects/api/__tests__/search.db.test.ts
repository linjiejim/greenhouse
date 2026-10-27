import { services as knowledgeServices } from '../../../knowledge/api/services.js';
import { services as projectsServices } from '../services.js';
/**
 * Global search: aggregation and, mostly, what it must NOT return.
 *
 * A palette that reaches across conversations and several entity domains is a
 * place where an authorization mistake shows up as convenience rather than as
 * an error, so the assertions that matter here are the negative ones: a user
 * only ever sees the conversations and records they are allowed to see.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { GlobalSearchResponse } from '@greenhouse/types/search';
import type { AppEnv } from '../../../../apps/api/src/app-env.js';
import { createSearchRoute } from '../../../../apps/api/src/routes/search.js';
import { knowledgeRegistration } from '../../../knowledge/api/platform/registration.js';
import { projectsRegistration } from '../platform/application.js';
import {
  initializePlatformRuntime,
  resetPlatformRuntimeForTests,
} from '../../../../apps/api/src/plugin-host/runtime.js';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';

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
  app.route('/api/search', createSearchRoute());
  return app;
}

async function search(app: Hono<AppEnv>, userId: string, query: string, kind?: string) {
  const suffix = kind ? `&kind=${kind}` : '';
  const res = await app.request(`/api/search?q=${encodeURIComponent(query)}${suffix}`, {
    headers: { 'x-test-user': userId },
  });
  return { status: res.status, body: (await res.json()) as GlobalSearchResponse & { error?: string } };
}

function titles(body: GlobalSearchResponse, kind: string): string[] {
  return body.groups.find((g) => g.kind === kind)?.items.map((i) => i.title) ?? [];
}

/** Unique per run: this data is created inside the test transaction, but the
 *  marker keeps assertions honest if a fixture ever leaks. */
const marker = () => `zz${Date.now()}${Math.trunc(performance.now())}`;

describe('global search', () => {
  beforeEach(async () => {
    _resetProvider();
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [knowledgeRegistration, projectsRegistration]);
  });

  afterEach(() => {
    resetPlatformRuntimeForTests();
  });

  it('aggregates matches from every domain the caller can see', async () => {
    const token = marker();
    const user = await createInternalTestUser(db, { email: `search-super-${token}@test.local`, role: 'super' });

    await db.sessions.create(`${token} planning`, 'team', user.id, undefined, 'web');
    await projectsServices(db).projects.createProject({
      title: `${token} rollout`,
      owner_id: user.id,
      created_by: user.id,
    });
    await knowledgeServices(db).knowledgeBase.create({
      doc_id: `${token}-doc`,
      scope: 'shared',
      title: `${token} pricing`,
      content: 'MOQ tiers for chain garden centres.',
      visibility: 'team',
      status: 'published',
      created_by: user.id,
      updated_by: user.id,
    });

    const app = createApp([user]);
    const { status, body } = await search(app, user.id, token);
    expect(status).toBe(200);
    expect(titles(body, 'session')).toEqual([`${token} planning`]);
    expect(titles(body, 'project')).toEqual([`${token} rollout`]);
    expect(titles(body, 'kb_doc')).toEqual([`${token} pricing`]);
  });

  it('returns a record reference the peek can open directly', async () => {
    const token = marker();
    const user = await createInternalTestUser(db, { email: `search-ref-${token}@test.local`, role: 'super' });
    const project = await projectsServices(db).projects.createProject({
      title: `${token} refs`,
      owner_id: user.id,
      created_by: user.id,
    });

    const { body } = await search(createApp([user]), user.id, token);
    const hit = body.groups.find((g) => g.kind === 'project')?.items[0];
    expect(hit && 'ref' in hit ? hit.ref : undefined).toEqual({
      kind: 'project',
      id: project.id,
    });
  });

  it("searches all of the caller's own conversations, automation runs included, but not workflow transcripts", async () => {
    const token = marker();
    const [owner, stranger] = await Promise.all([
      createInternalTestUser(db, { email: `search-session-owner-${token}@test.local`, role: 'team' }),
      createInternalTestUser(db, { email: `search-session-other-${token}@test.local`, role: 'team' }),
    ]);
    const own = await db.sessions.create(`${token} own chat`, 'team', owner.id, undefined, 'web');
    const run = await db.sessions.create(`${token} daily digest run`, 'team', owner.id, undefined, 'task');
    const bot = await db.sessions.create(`${token} feishu thread`, 'team', owner.id, undefined, 'feishu');
    await db.sessions.create(`${token} other chat`, 'team', stranger.id, undefined, 'web');
    await db.sessions.create(`${token} workflow`, 'team', owner.id, undefined, 'workflow');

    const { body } = await search(createApp([owner]), owner.id, token, 'session');
    const hits = body.groups.find((group) => group.kind === 'session')?.items ?? [];
    expect(hits.map((hit) => ('sessionId' in hit ? hit.sessionId : null)).sort()).toEqual(
      [own.id, run.id, bot.id].sort(),
    );
    // A date the client formats, not a raw ISO string in the subtitle.
    const ownHit = hits.find((hit) => 'sessionId' in hit && hit.sessionId === own.id);
    expect(ownHit).toMatchObject({ updatedAt: expect.any(String) });
    expect(ownHit?.subtitle).toBeUndefined();
  });

  it("finds the caller's own automations by name or prompt, and nobody else's", async () => {
    const token = marker();
    const [owner, stranger] = await Promise.all([
      createInternalTestUser(db, { email: `search-auto-owner-${token}@test.local`, role: 'super' }),
      createInternalTestUser(db, { email: `search-auto-other-${token}@test.local`, role: 'team' }),
    ]);
    const base = { schedule: '0 9 * * *', timezone: 'UTC' };
    const byName = await db.scheduledTasks.create({
      ...base,
      user_id: owner.id,
      name: `${token} digest`,
      task_prompt: 'Summarize yesterday in the CRM.',
    });
    const byPrompt = await db.scheduledTasks.create({
      ...base,
      user_id: owner.id,
      name: 'Weekly board',
      task_prompt: `Update the ${token} board table   every Monday.`,
      enabled: false,
    });
    await db.scheduledTasks.create({ ...base, user_id: owner.id, name: 'Unrelated', task_prompt: 'Nothing to see.' });
    await db.scheduledTasks.create({
      ...base,
      user_id: stranger.id,
      name: `${token} theirs`,
      task_prompt: 'Not yours to find.',
    });

    const { body } = await search(createApp([owner, stranger]), owner.id, token);
    const hits = body.groups.find((group) => group.kind === 'automation')?.items ?? [];
    expect(hits).toHaveLength(2);
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ automationId: byName.id, title: `${token} digest`, enabled: true }),
        expect.objectContaining({
          automationId: byPrompt.id,
          title: 'Weekly board',
          enabled: false,
          subtitle: `Update the ${token} board table every Monday.`,
        }),
      ]),
    );

    const narrowed = await search(createApp([owner]), owner.id, token, 'automation');
    expect(narrowed.body.groups.map((g) => g.kind)).toEqual(['automation']);
  });

  it('never surfaces another user private document', async () => {
    const token = marker();
    const [owner, stranger] = await Promise.all([
      createInternalTestUser(db, { email: `search-owner-${token}@test.local`, role: 'team' }),
      createInternalTestUser(db, { email: `search-other-${token}@test.local`, role: 'team' }),
    ]);
    await knowledgeServices(db).knowledgeBase.create({
      doc_id: `${token}-private`,
      scope: 'shared',
      title: `${token} private notes`,
      content: 'Not for the team.',
      visibility: 'private',
      owner_user_id: owner.id,
      status: 'published',
      created_by: owner.id,
      updated_by: owner.id,
    });

    const app = createApp([owner, stranger]);
    expect(titles((await search(app, owner.id, token)).body, 'kb_doc')).toEqual([`${token} private notes`]);
    expect(titles((await search(app, stranger.id, token)).body, 'kb_doc')).toEqual([]);
  });

  it('narrows to one domain when asked, and rejects a kind it does not serve', async () => {
    const token = marker();
    const user = await createInternalTestUser(db, { email: `search-kind-${token}@test.local`, role: 'super' });
    await projectsServices(db).projects.createProject({
      title: `${token} rollout`,
      owner_id: user.id,
      created_by: user.id,
    });
    const app = createApp([user]);

    const narrowed = await search(app, user.id, token, 'project');
    expect(narrowed.body.groups.map((g) => g.kind)).toEqual(['project']);

    const bogus = await search(app, user.id, token, 'not_a_kind');
    expect(bogus.status).toBe(400);
  });

  it('answers an empty query without touching any domain', async () => {
    const token = marker();
    const user = await createInternalTestUser(db, { email: `search-empty-${token}@test.local`, role: 'super' });
    const res = await createApp([user]).request('/api/search?q=%20%20', { headers: { 'x-test-user': user.id } });
    expect(res.status).toBe(200);
    expect((await res.json()).groups).toEqual([]);
  });
});
