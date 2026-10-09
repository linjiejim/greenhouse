/**
 * /api/admin/mcp-servers against real PostgreSQL and a real MCP server.
 *
 * Pins what the rest of the feature leans on: super-only (mounted behind the
 * same guard as production), discovery on save, the credential being
 * write-only and encrypted at rest, the allow-list and the enabled switch
 * reaching the in-memory directory `mcp_call` reads, and an unreachable server
 * being saved with its error but offering nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);
process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ?? '22'.repeat(32);

import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { requireSuper } from '../../auth/middleware.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { getMcpDirectory } from '../../mcp-client/directory.js';
import { startMcpTestServer, type McpTestServer } from '../../mcp-client/__tests__/fixture-server.js';
import adminMcpServerRoutes from '../admin-mcp-servers.js';

let db: DatabaseProvider;
let boss: UserRow;
let member: UserRow;
let fixture: McpTestServer;
let slug: string;

function app() {
  const users = new Map([boss, member].map((u) => [u.id, u]));
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role as 'team' | 'super' });
    return next();
  });
  // Same mount as apps/api/src/index.ts.
  hono.use('/api/admin/*', requireSuper());
  hono.route('/api/admin/mcp-servers', adminMcpServerRoutes);
  return hono;
}

async function call(as: UserRow, method: string, path: string, body?: unknown) {
  const res = await app().request(`/api/admin/mcp-servers${path}`, {
    method,
    headers: { 'x-test-user': as.id, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, any>;
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, json, raw: text };
}

const inDirectory = (s: string) => getMcpDirectory().find((server) => server.slug === s);

beforeAll(async () => {
  fixture = await startMcpTestServer({ token: 'fixture-token' });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const stamp = `${Date.now()}-${Math.random()}`;
  boss = await createInternalTestUser(db, { email: `mcp-boss-${stamp}@test.local`, role: 'super' });
  member = await createInternalTestUser(db, { email: `mcp-member-${stamp}@test.local`, role: 'team' });
  slug = `orders-${Math.floor(Math.random() * 1e9).toString(36)}`;
});

describe('/api/admin/mcp-servers', () => {
  it('is super-only', async () => {
    expect((await call(member, 'GET', '')).status).toBe(403);
    expect((await call(member, 'POST', '', { slug, name: 'x', url: fixture.url })).status).toBe(403);
  });

  it('registers a server, discovers its tools and never returns the credential', async () => {
    const created = await call(boss, 'POST', '', {
      slug,
      name: 'Order desk',
      description: 'Orders and tickets',
      url: fixture.url,
      auth_value: 'Bearer fixture-token',
    });
    expect(created.status).toBe(201);
    expect(created.json.refresh).toEqual({ ok: true, error: null });
    expect(created.json.server).toMatchObject({
      slug,
      auth_header: 'Authorization',
      has_auth_value: true,
      enabled: true,
      last_error: null,
    });
    expect(created.json.server.tools.map((t: { name: string }) => t.name)).toEqual([
      'lookup_order',
      'create_ticket',
      'chart_png',
      'leaky',
    ]);
    expect(created.raw).not.toContain('fixture-token');

    // Encrypted at rest: the stored column is ciphertext, not the header value.
    const row = await db.mcpServers.getBySlug(slug);
    expect(row?.auth_value_encrypted).toBeTruthy();
    expect(row?.auth_value_encrypted).not.toContain('fixture-token');

    // The chat turn's directory sees it straight away.
    expect(inDirectory(slug)?.tools).toHaveLength(4);
  });

  it('the allow-list and the enabled switch reach the directory', async () => {
    const { json } = await call(boss, 'POST', '', {
      slug,
      name: 'Desk',
      url: fixture.url,
      auth_value: 'Bearer fixture-token',
    });
    const id = json.server.id as number;

    await call(boss, 'PUT', `/${id}`, { allowed_tools: ['lookup_order'] });
    expect(inDirectory(slug)?.tools.map((t) => t.name)).toEqual(['lookup_order']);

    const disabled = await call(boss, 'PUT', `/${id}`, { enabled: false });
    expect(disabled.json.server.enabled).toBe(false);
    expect(inDirectory(slug)).toBeUndefined();

    expect((await call(boss, 'DELETE', `/${id}`)).status).toBe(200);
    expect(await db.mcpServers.getById(id)).toBeUndefined();
  });

  it('a wrong credential is saved with its error and offers nothing until fixed', async () => {
    const created = await call(boss, 'POST', '', { slug, name: 'Desk', url: fixture.url, auth_value: 'Bearer nope' });
    expect(created.status).toBe(201);
    expect(created.json.refresh.ok).toBe(false);
    expect(created.json.server.last_error).toMatch(/rejected the credential/);
    expect(inDirectory(slug)).toBeUndefined();

    // Fixing the credential re-runs discovery on its own.
    const fixed = await call(boss, 'PUT', `/${created.json.server.id}`, { auth_value: 'Bearer fixture-token' });
    expect(fixed.json.refresh).toEqual({ ok: true, error: null });
    expect(fixed.json.server.last_error).toBeNull();
    expect(inDirectory(slug)?.tools).toHaveLength(4);
  });

  it('rejects a bad id, a non-http url, a duplicate, and a credential in the url', async () => {
    expect((await call(boss, 'POST', '', { slug: 'Bad Slug', name: 'x', url: fixture.url })).status).toBe(400);
    expect((await call(boss, 'POST', '', { slug, name: 'x', url: 'ftp://example.com' })).status).toBe(400);
    expect((await call(boss, 'POST', '', { slug, name: 'x', url: 'https://u:p@example.com/mcp' })).status).toBe(400);

    expect((await call(boss, 'POST', '', { slug, name: 'x', url: 'http://127.0.0.1:9/mcp' })).status).toBe(201);
    const dup = await call(boss, 'POST', '', { slug, name: 'y', url: 'http://127.0.0.1:9/mcp' });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toContain(`"${slug}"`);
  });
});
