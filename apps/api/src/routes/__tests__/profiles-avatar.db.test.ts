/**
 * Custom-Agent avatars through /api/profiles against real PostgreSQL: the plant
 * and mood survive create / update / read, junk never reaches storage or the
 * client, legacy rows are read (never rewritten), and a fork keeps its source's
 * look while a fork of the built-in Sprouty gets its own.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { legacyToPlant } from '@greenhouse/types';
import profiles from '../profiles.js';

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
  hono.route('/api/profiles', profiles);
  return hono;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await app().request(`/api/profiles${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

function numericId(profileId: string): number {
  return Number(profileId.replace('custom:', ''));
}

async function createAgent(avatar: unknown, name = 'Docs helper') {
  const res = await call('POST', '/custom', { name, system_prompt: 'Help with docs.', tools: [], avatar });
  expect(res.status).toBe(201);
  return res.json;
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

describe('custom Agent avatars', () => {
  it('keep the plant, mood and palette through create, read and update; junk never reaches storage', async () => {
    const created = await createAgent({ ...PLANT_AVATAR, model: 'gpt', leafStyle: 'huge' });
    expect(created.avatar).toEqual(PLANT_AVATAR);
    const id = numericId(created.id);

    expect((await call('GET', `/custom/${id}`)).json.avatar).toEqual(PLANT_AVATAR);
    const listed = (await call('GET', '')).json.profiles.find((p: { id: string }) => p.id === created.id);
    expect(listed.avatar).toEqual(PLANT_AVATAR);

    const updated = await call('PUT', `/custom/${id}`, { avatar: { plant: 'maple', mood: 'drowsy', color: 'autumn' } });
    expect(updated.status).toBe(200);
    expect(updated.json.avatar).toEqual({ plant: 'maple', mood: 'drowsy', color: 'autumn' });
    expect((await call('GET', `/custom/${id}`)).json.avatar).toEqual({
      plant: 'maple',
      mood: 'drowsy',
      color: 'autumn',
    });

    // The version history shows what was stored: normalised, and v1 untouched by the update.
    const versions = (await call('GET', `/custom/${id}/versions`)).json.versions as Array<{
      version: number;
      avatar: unknown;
    }>;
    const byVersion = Object.fromEntries(versions.map((v) => [v.version, v.avatar]));
    expect(byVersion).toEqual({ 1: PLANT_AVATAR, 2: { plant: 'maple', mood: 'drowsy', color: 'autumn' } });
  });

  it('reads a legacy row as stored and never rewrites it', async () => {
    const row = await db.customProfiles.create({
      slug: 'legacy',
      user_id: owner.id,
      name: 'Legacy',
      base_profile_id: 'sprouty',
      model_id: 'flash',
      tools: [],
      system_prompt: 'Old.',
      max_steps: 12,
      is_shared: false,
      avatar: { color: 'mint', eyeStyle: 'focused', faceStyle: 'happy', rogue: 1 },
      created_by: owner.id,
    });
    expect((await call('GET', `/custom/${row.id}`)).json.avatar).toEqual({
      color: 'mint',
      eyeStyle: 'focused',
      faceStyle: 'happy',
    });
    const stored = await db.customProfiles.getVersion(row.id, 1);
    expect(JSON.parse(stored!.avatar)).toEqual({ color: 'mint', eyeStyle: 'focused', faceStyle: 'happy', rogue: 1 });
  });

  it('a fork of a custom Agent keeps its look; a fork of the built-in Sprouty gets its own', async () => {
    const source = await createAgent({ ...PLANT_AVATAR, accessories: ['pencil'] }, 'Source');
    const fork = await call('POST', '/custom/fork', { source_profile_id: source.id, name: 'Source copy' });
    expect(fork.status).toBe(201);
    expect(fork.json.avatar).toEqual({ ...PLANT_AVATAR, accessories: ['pencil'] });
    expect((await call('GET', `/custom/${numericId(fork.json.id)}`)).json.avatar).toEqual(fork.json.avatar);

    const sproutyFork = await call('POST', '/custom/fork', { source_profile_id: 'sprouty', name: 'My Sprouty' });
    expect(sproutyFork.status).toBe(201);
    expect(sproutyFork.json.avatar).toEqual({});
  });

  it('answers 409, not 500, for a duplicate name on create and fork', async () => {
    const first = await createAgent({}, 'Twin');
    const again = await call('POST', '/custom', { name: 'Twin', system_prompt: 'Help.', tools: [], avatar: {} });
    expect(again.status).toBe(409);
    const fork = await call('POST', '/custom/fork', { source_profile_id: first.id, name: 'Twin' });
    expect(fork.status).toBe(409);
  });

  it('a fork of a legacy Agent pins the plant the source renders as, instead of re-hashing its own id', async () => {
    // `{}`, a forest avatar with no hint, and an unknown plant id all resolve by the source's stable id.
    for (const [index, legacy] of [{}, { color: 'forest' }, { plant: 'cultivar-x', color: 'forest' }].entries()) {
      const source = await createAgent(legacy, `Legacy source ${index}`);
      const expected = legacyToPlant(source.avatar, null, source.id);
      const fork = await call('POST', '/custom/fork', { source_profile_id: source.id, name: `Legacy copy ${index}` });
      expect(fork.status).toBe(201);
      expect(fork.json.avatar.plant).toBe(expected);
      expect(legacyToPlant(fork.json.avatar, null, fork.json.id)).toBe(expected);
      // The source itself is never rewritten.
      expect((await call('GET', `/custom/${numericId(source.id)}`)).json.avatar.plant).toBe(legacy.plant);
    }
  });
});
