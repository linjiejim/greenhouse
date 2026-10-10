/**
 * The account's language (real PostgreSQL): `PUT /api/auth/me/preferences`.
 *
 * An account starts on the default `en`, which nobody picked. The mobile app
 * offers its own language for it (`inferred`) so what the server writes —
 * cards, event lines, Sprouty — matches the app; a member's own pick (web or
 * app settings) is never undone by that. Sprouty's built-in words follow the
 * language while the member hasn't rewritten them.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { SPROUTY_BOT_TEMPLATE } from '@greenhouse/types/bots';
import type { AppEnv } from '../../app-env.js';
import { ensureSproutyBot } from '../../bots/sprouty.js';
import authRoutes from '../auth.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;

function createApp(user: UserRow) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/auth', authRoutes);
  return app;
}

async function put(app: Hono<AppEnv>, body: Record<string, unknown>) {
  const res = await app.request('/api/auth/me/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { locale?: string; locale_chosen?: boolean } };
}

async function me(app: Hono<AppEnv>) {
  const res = await app.request('/api/auth/me');
  return ((await res.json()) as { user: { locale: string; locale_chosen: boolean } }).user;
}

let seq = 0;
async function member(): Promise<{ user: UserRow; app: Hono<AppEnv> }> {
  const user = await createInternalTestUser(db, { email: `locale-${Date.now()}-${++seq}@test.local` });
  return { user, app: createApp(user) };
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});

describe('the account language', () => {
  it('a new account is on the default, which nobody picked', async () => {
    const { app } = await member();
    expect(await me(app)).toMatchObject({ locale: 'en', locale_chosen: false });
  });

  it("takes a client's language while nobody picked one, and stays unpicked", async () => {
    const { app } = await member();
    expect(await put(app, { locale: 'zh', inferred: true })).toEqual({
      status: 200,
      body: { notes: null, locale: 'zh', locale_chosen: false },
    });
    expect(await me(app)).toMatchObject({ locale: 'zh', locale_chosen: false });
    // still unpicked: another client's language is taken too
    expect((await put(app, { locale: 'en', inferred: true })).body.locale).toBe('en');
  });

  it("keeps the member's pick against a client's language — the same value counts as a pick", async () => {
    const { app } = await member();
    expect((await put(app, { locale: 'en' })).body).toMatchObject({ locale: 'en', locale_chosen: true });
    expect((await put(app, { locale: 'zh', inferred: true })).body).toMatchObject({
      locale: 'en',
      locale_chosen: true,
    });
    expect(await me(app)).toMatchObject({ locale: 'en', locale_chosen: true });
  });

  it('saving notes picks no language', async () => {
    const { app } = await member();
    expect((await put(app, { notes: 'Short answers, please.' })).body).toMatchObject({
      locale: 'en',
      locale_chosen: false,
    });
  });
});

describe("Sprouty's words follow the language", () => {
  it('re-words the untouched built-in role and instructions, as a new version', async () => {
    const { user, app } = await member();
    const before = await ensureSproutyBot(db, user.id);
    expect(before.instructions).toBe(SPROUTY_BOT_TEMPLATE.copy.en.instructions);

    await put(app, { locale: 'zh', inferred: true });
    const after = await ensureSproutyBot(db, user.id);
    expect(after).toMatchObject({
      role: SPROUTY_BOT_TEMPLATE.copy.zh.role,
      instructions: SPROUTY_BOT_TEMPLATE.copy.zh.instructions,
      current_version: before.current_version + 1,
    });

    // a pick of the language it already speaks changes nothing
    await put(app, { locale: 'zh' });
    expect((await ensureSproutyBot(db, user.id)).current_version).toBe(after.current_version);
  });

  it('leaves instructions the member rewrote alone', async () => {
    const { user, app } = await member();
    const sprouty = await ensureSproutyBot(db, user.id);
    await db.bots.updateBot(user.id, sprouty.id, { instructions: 'Answer in haiku.' });

    await put(app, { locale: 'zh' });
    expect(await ensureSproutyBot(db, user.id)).toMatchObject({
      role: SPROUTY_BOT_TEMPLATE.copy.en.role,
      instructions: 'Answer in haiku.',
    });
  });
});
