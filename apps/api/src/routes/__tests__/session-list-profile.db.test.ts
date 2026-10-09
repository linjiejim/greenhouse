/**
 * `GET /api/sessions?profile=` against a real database.
 *
 * A Bot profile's "Conversations" tab lists the member's own by-session chats
 * with ONE Bot: every stored spelling of that Bot (live, pinned, the legacy ids
 * that resolve to it) and nothing that merely shares an id prefix. The filter
 * runs in SQL, so it composes with scope, status, tags, pagination and the
 * pinned / shared backfills instead of thinning pages after the fact.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { BOT_TASK_SESSION_PREFIX, type SessionChannel } from '@greenhouse/types/session';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

vi.mock('../../llm/title.js', () => ({ generateSessionTitle: vi.fn() }));

import sessionRoutes from '../sessions.js';

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
  app.route('/api/sessions', sessionRoutes);
  return app;
}

interface ListResult {
  status: number;
  ids: string[];
  page?: { has_more: boolean; next_offset: number };
  error?: string;
}

async function list(app: Hono<AppEnv>, user: UserRow, query: Record<string, string>): Promise<ListResult> {
  const res = await app.request(`/api/sessions?${new URLSearchParams(query).toString()}`, {
    headers: { 'x-test-user': user.id },
  });
  const body = (await res.json()) as {
    sessions?: Array<{ id: string }>;
    page?: ListResult['page'];
    error?: string;
  };
  return { status: res.status, ids: (body.sessions ?? []).map((s) => s.id), page: body.page, error: body.error };
}

const BASE = Date.parse('2026-10-01T12:00:00.000Z');

/** A session last touched `minutesAgo` before BASE, so the list order is deterministic. */
async function session(
  owner: UserRow,
  profileId: string,
  minutesAgo: number,
  opts: { channel?: SessionChannel; id?: string } = {},
): Promise<string> {
  const row = await db.sessions.create(
    profileId,
    profileId,
    owner.id,
    undefined,
    opts.channel,
    undefined,
    opts.id ? { id: opts.id } : undefined,
  );
  const at = new Date(BASE - minutesAgo * 60_000).toISOString();
  await db.executeRaw(sql`UPDATE sessions SET created_at = ${at}, updated_at = ${at} WHERE id = ${row.id}`);
  return row.id;
}

/** Alice with her Sprouty and Sage (a Bot migrated from a custom Agent), plus Bob. */
async function fixture() {
  const token = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const alice = await createInternalTestUser(db, { email: `profile-alice-${token}@test.local` });
  const bob = await createInternalTestUser(db, { email: `profile-bob-${token}@test.local` });
  const sprouty = await db.bots.createBot({
    user_id: alice.id,
    name: 'Sprouty',
    template_key: 'sprouty',
    builtIn: true,
  });
  const sage = await db.bots.createBot({ user_id: alice.id, name: 'Sage' });
  const legacyId = 900_000 + Math.floor(Math.random() * 99_999);
  await db.executeRaw(sql`UPDATE bots SET legacy_custom_id = ${legacyId} WHERE id = ${sage.id}`);
  const app = createApp([alice, bob]);
  return { app, alice, bob, sprouty, SAGE: `bot:${sage.id}`, legacyId };
}

describe('GET /api/sessions?profile=', () => {
  beforeEach(async () => {
    _resetProvider();
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(() => {
    _resetProvider();
  });

  it('lists one Bot under every stored spelling, never a longer id, never another member’s', async () => {
    const { app, alice, bob, sprouty, SAGE, legacyId } = await fixture();
    const live = await session(alice, SAGE, 1);
    const pinned = await session(alice, `${SAGE}@2`, 2); // an automation's pinned run
    const legacy = await session(alice, `custom:${legacyId}`, 3);
    const legacyPinned = await session(alice, `custom:${legacyId}@1`, 4);
    await session(alice, `${SAGE}0`, 5);
    await session(alice, `custom:${legacyId}0`, 6);
    await session(alice, 'sprouty', 7);
    await session(alice, `bot:${sprouty.id}`, 8);
    await session(bob, SAGE, 9);
    // Bots threads and Bot task children stay out of the generic list, filtered or not.
    await session(alice, SAGE, 10, { channel: 'bots' });
    await session(alice, `${SAGE}@2`, 11, { channel: 'subagent', id: `${BOT_TASK_SESSION_PREFIX}${randomUUID()}` });

    const res = await list(app, alice, { scope: 'mine', profile: SAGE });

    expect(res.status).toBe(200);
    expect(res.ids).toEqual([live, pinned, legacy, legacyPinned]);
  });

  it('reads `sprouty` and the Sprouty Bot’s own id as the same main Bot, legacy ids included', async () => {
    const { app, alice, sprouty, SAGE } = await fixture();
    const expected = [
      await session(alice, 'sprouty', 1),
      await session(alice, 'team', 2),
      await session(alice, `bot:${sprouty.id}`, 3),
      await session(alice, `bot:${sprouty.id}@1`, 4),
      await session(alice, 'default', 5),
      await session(alice, 'sprouty-quick', 6),
    ];
    await session(alice, SAGE, 7);
    await session(alice, 'desktop', 8);

    for (const profile of ['sprouty', `bot:${sprouty.id}`]) {
      const res = await list(app, alice, { scope: 'mine', profile });
      expect(res.ids, profile).toEqual(expected);
    }
  });

  it('pages through matching rows only; the pinned backfill appends only a matching chat', async () => {
    const { app, alice, SAGE } = await fixture();
    const matching: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      matching.push(await session(alice, i % 2 ? `${SAGE}@${i}` : SAGE, i * 2 + 1));
      await session(alice, 'sprouty', i * 2 + 2);
    }
    const pinnedMatch = await session(alice, SAGE, 600);
    const pinnedOther = await session(alice, 'sprouty', 601);
    await db.sessionGroups.pin(alice.id, pinnedMatch);
    await db.sessionGroups.pin(alice.id, pinnedOther);

    const seen: string[] = [];
    const pages: ListResult[] = [];
    let offset = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const res = await list(app, alice, {
        scope: 'mine',
        profile: SAGE,
        page_meta: '1',
        limit: '2',
        offset: String(offset),
      });
      expect(res.status).toBe(200);
      pages.push(res);
      seen.push(...res.ids.filter((id) => id !== pinnedMatch));
      if (!res.page?.has_more) break;
      offset = res.page.next_offset;
    }

    expect(pages.map((p) => p.page)).toEqual([
      { has_more: true, next_offset: 2 },
      { has_more: true, next_offset: 4 },
      { has_more: false, next_offset: 6 },
    ]);
    expect(seen).toEqual(matching);
    // The pinned chat with this Bot surfaces on every page; the pinned Sprouty chat never does.
    for (const page of pages) {
      expect(page.ids).toContain(pinnedMatch);
      expect(page.ids).not.toContain(pinnedOther);
    }
  });

  it('composes with status, tags and the shared-with-me rows of the unscoped list', async () => {
    const { app, alice, bob, SAGE } = await fixture();
    const active = await session(alice, SAGE, 1);
    const archived = await session(alice, SAGE, 2);
    await db.sessions.update(archived, { status: 'archived' });
    const otherBot = await session(alice, 'sprouty', 3);
    const theirsMatching = await session(bob, SAGE, 4);
    const theirsOther = await session(bob, 'sprouty', 5);
    await db.sessionShares.createMany([
      { session_id: theirsMatching, shared_with: alice.id, shared_by: bob.id },
      { session_id: theirsOther, shared_with: alice.id, shared_by: bob.id },
    ]);

    expect((await list(app, alice, { profile: SAGE, status: 'archived' })).ids).toEqual([archived]);

    const tag = await db.sessionTags.create({ user_id: alice.id, name: 'q4' });
    await db.sessionTags.addTagToSession(active, tag.id);
    await db.sessionTags.addTagToSession(otherBot, tag.id);
    expect((await list(app, alice, { profile: SAGE, tag_id: String(tag.id) })).ids).toEqual([active]);

    // No scope (team member): own rows plus the shared backfill, both filtered.
    const unscoped = await list(app, alice, { profile: SAGE });
    expect(unscoped.ids).toContain(theirsMatching);
    expect(unscoped.ids).not.toContain(theirsOther);
    expect(unscoped.ids).not.toContain(otherBot);
    expect((await list(app, alice, { scope: 'shared', profile: SAGE })).ids).toEqual([theirsMatching]);
  });

  it('rejects a malformed profile before listing anything', async () => {
    const { app, alice, sprouty, SAGE } = await fixture();
    await session(alice, SAGE, 1);
    for (const profile of [
      '',
      'Sprouty',
      'sprouty@1',
      'team',
      'custom:7',
      'bot:abc',
      `${SAGE}@2`,
      `${SAGE} `,
      `bot:${sprouty.id.toUpperCase()}`,
    ]) {
      const res = await list(app, alice, { scope: 'mine', profile });
      expect(res.status, JSON.stringify(profile)).toBe(400);
      expect(res.error).toBe('profile must be "sprouty" or "bot:<id>"');
    }
  });
});
