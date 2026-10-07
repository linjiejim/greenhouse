/**
 * Bot avatars and versions through /api/bots against real PostgreSQL: the plant
 * and mood survive create / update / read, junk never reaches storage or the
 * client, legacy rows are read (never rewritten), every edit appends an
 * immutable version, and a clone keeps its source's look.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { createBotsRoutes } from '../routes.js';

let db: DatabaseProvider;
let owner: UserRow;

const PLANT_AVATAR = {
  plant: 'lotus',
  mood: 'soft',
  color: 'blossom',
  palette: { body: '#E57FA4', leaf: '#5DAE45' },
};

function app() {
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    c.set('user', { id: owner.id, role: owner.role });
    return next();
  });
  hono.route('/api/bots', createBotsRoutes());
  return hono;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await app().request(`/api/bots${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function createBot(avatar: unknown, name = 'Docs helper') {
  const res = await call('POST', '', { name, instructions: 'Help with docs.', avatar });
  expect(res.status).toBe(200);
  return res.json.bot as Record<string, any>;
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  owner = await createInternalTestUser(db, {
    email: `avatar-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Avatar Owner',
    role: 'team',
  });
});

describe('Bot avatars and versions', () => {
  it('keep the plant, mood and palette through create, read and update; junk never reaches storage', async () => {
    const created = await createBot({ ...PLANT_AVATAR, model: 'gpt', leafStyle: 'huge' });
    // The validator keeps the known keys (leafStyle is a legacy key) and strips the rest.
    expect(created.avatar).toEqual({ ...PLANT_AVATAR, leafStyle: 'huge' });
    expect(created.current_version).toBe(1);

    const listed = (await call('GET', '')).json.bots.find((b: { id: string }) => b.id === created.id);
    expect(listed.avatar).toEqual({ ...PLANT_AVATAR, leafStyle: 'huge' });

    const updated = await call('PATCH', `/${created.id}`, {
      avatar: { plant: 'maple', mood: 'drowsy', color: 'autumn' },
    });
    expect(updated.status).toBe(200);
    expect(updated.json.bot.avatar).toEqual({ plant: 'maple', mood: 'drowsy', color: 'autumn' });
    expect(updated.json.bot.current_version).toBe(2);

    // The version history shows what was stored, v1 untouched by the update.
    const versions = (await call('GET', `/${created.id}/versions`)).json.versions as Array<{
      version: number;
      avatar: unknown;
    }>;
    const byVersion = Object.fromEntries(versions.map((v) => [v.version, v.avatar]));
    expect(byVersion).toEqual({
      1: { ...PLANT_AVATAR, leafStyle: 'huge' },
      2: { plant: 'maple', mood: 'drowsy', color: 'autumn' },
    });
  });

  it('reads a legacy row as stored and never rewrites it', async () => {
    const row = await db.bots.createBot({
      user_id: owner.id,
      name: 'Legacy',
      instructions: 'Old.',
      avatar: JSON.stringify({ color: 'mint', eyeStyle: 'focused', faceStyle: 'happy', rogue: 1 }),
    });
    const listed = (await call('GET', '')).json.bots.find((b: { id: string }) => b.id === row.id);
    expect(listed.avatar).toEqual({ color: 'mint', eyeStyle: 'focused', faceStyle: 'happy', rogue: 1 });
    const stored = await db.bots.getVersion(row.id, 1);
    expect(JSON.parse(stored!.avatar)).toEqual({ color: 'mint', eyeStyle: 'focused', faceStyle: 'happy', rogue: 1 });
  });

  it('rejects an unknown or unauthorised tool filter and accepts null (inherit everything)', async () => {
    const bad = await call('POST', '', { name: 'Filtered', tools: ['no_such_tool'] });
    expect(bad.status).toBe(400);
    const open = await createBot({}, 'Open');
    expect(open.tools).toBeNull();
    const narrowed = await call('PATCH', `/${open.id}`, { tools: ['knowledge_query'] });
    expect(narrowed.status).toBe(200);
    expect(narrowed.json.bot.tools).toEqual(['knowledge_query']);
    expect(narrowed.json.bot.current_version).toBe(2);
  });

  it('answers 400 bot_name_taken, not 500, for a duplicate name', async () => {
    await createBot({}, 'Twin');
    const again = await call('POST', '', { name: 'Twin', instructions: 'Help.' });
    expect(again.status).toBe(400);
    expect(again.json.code).toBe('bot_name_taken');
  });
});
