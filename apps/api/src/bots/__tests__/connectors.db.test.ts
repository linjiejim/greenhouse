/**
 * A Bot's connector list (spec 20261009-mcp-connectors D9) against real
 * PostgreSQL: validated against the installed connectors, versioned with the
 * manifest, carried into the profile a Chat turn runs as — and a version
 * without a list hashes exactly as it did before connectors existed.
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { getDefaultProfile, profileFromBot } from '../../profiles/profile.js';
import { createBotsRoutes } from '../routes.js';

vi.mock('../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

let db: DatabaseProvider;
let jim: UserRow;
let slug: string;

function app() {
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    c.set('user', { id: jim.id, role: jim.role });
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

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const stamp = `${Date.now()}-${Math.random()}`;
  jim = await createInternalTestUser(db, { email: `bc-${stamp}@test.local`, nickname: 'Jim', role: 'team' });
  slug = `linear-${Math.floor(Math.random() * 1e9).toString(36)}`;
  await db.mcpServers.create({ slug, name: 'Linear', url: 'https://mcp.linear.app/mcp', auth_mode: 'oauth' });
});

describe("a Bot's connectors", () => {
  it('are validated, versioned and editable back to "all"', async () => {
    const created = await call('POST', '', { name: 'Fern', connectors: [slug] });
    expect(created.status).toBe(200);
    expect(created.json.bot.connectors).toEqual([slug]);

    expect((await call('POST', '', { name: 'Moss', connectors: ['no-such-connector'] })).json.error).toMatch(
      /Unknown connectors: no-such-connector/,
    );

    const id = created.json.bot.id as string;
    const cleared = await call('PATCH', `/${id}`, { connectors: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.bot.connectors).toBeNull();

    const versions = await db.bots.listVersions(id);
    expect(versions.map((v) => v.connectors)).toEqual([null, JSON.stringify([slug])]);
  });

  it('reach the profile a Chat turn runs as', async () => {
    const bot = await db.bots.createBot({ user_id: jim.id, name: 'Fern', connectors: [slug] });
    const profile = profileFromBot(bot, getDefaultProfile(), { id: `bot:${bot.id}` });
    expect(profile.mcp_connectors).toEqual([slug]);
    const all = await db.bots.createBot({ user_id: jim.id, name: 'Moss' });
    expect(profileFromBot(all, getDefaultProfile(), { id: `bot:${all.id}` }).mcp_connectors).toBeNull();
  });

  it('a version without a list keeps the manifest hash it had before connectors existed', async () => {
    const bot = await db.bots.createBot({ user_id: jim.id, name: 'Fern', instructions: 'Be brief.' });
    const [v1] = await db.bots.listVersions(bot.id);
    const legacy = createHash('sha256')
      .update(
        JSON.stringify({
          name: v1!.name,
          role: v1!.role,
          description: v1!.description,
          instructions: v1!.instructions,
          tools: v1!.tools,
          model_id: v1!.model_id,
          max_steps: v1!.max_steps,
          avatar: v1!.avatar,
        }),
      )
      .digest('hex');
    expect(v1!.manifest_hash).toBe(legacy);

    const updated = await db.bots.updateBot(jim.id, bot.id, { connectors: [slug] });
    const [v2] = await db.bots.listVersions(bot.id);
    expect(updated?.connectors).toBe(JSON.stringify([slug]));
    expect(v2!.manifest_hash).not.toBe(legacy);
  });
});
