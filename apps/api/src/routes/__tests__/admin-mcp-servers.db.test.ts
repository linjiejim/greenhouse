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
      // A credential without a mode is the shared one, as before auth modes existed.
      auth_mode: 'shared',
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
      'whoami',
    ]);
    expect(created.raw).not.toContain('fixture-token');

    // Encrypted at rest: the stored column is ciphertext, not the header value.
    const row = await db.mcpServers.getBySlug(slug);
    expect(row?.auth_value_encrypted).toBeTruthy();
    expect(row?.auth_value_encrypted).not.toContain('fixture-token');

    // The chat turn's directory sees it straight away.
    expect(inDirectory(slug)?.tools).toHaveLength(5);
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
    expect(inDirectory(slug)?.tools).toHaveLength(5);
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
  it("a per-member server is listed with the acting admin's own connection — none yet, nothing recorded", async () => {
    const keyed = await startMcpTestServer({ apiKey: { value: 'boss-key', query: 'key' } });
    try {
      const created = await call(boss, 'POST', '', {
        slug,
        name: 'Maps',
        url: keyed.url,
        auth_mode: 'per_user',
        auth_query_param: 'key',
        credential_help: 'Your maps key',
      });
      expect(created.status).toBe(201);
      expect(created.json.refresh.ok).toBe(false);
      expect(created.json.refresh.error).toMatch(/Add your own key/);
      // The admin's missing key is their state, not the server's.
      expect(created.json.server.last_error).toBeNull();
      expect(created.json.server).toMatchObject({ auth_mode: 'per_user', auth_query_param: 'key', auth_header: null });
      expect(inDirectory(slug)).toBeUndefined();
    } finally {
      await keyed.close();
    }
  });

  it('rejects auth settings that cannot work together', async () => {
    const base = { slug, name: 'x', url: fixture.url };
    // A shared server needs its credential …
    expect((await call(boss, 'POST', '', { ...base, auth_mode: 'shared' })).json.error).toMatch(/needs the credential/);
    // … and the others must not store one.
    expect((await call(boss, 'POST', '', { ...base, auth_mode: 'oauth', auth_value: 'x' })).status).toBe(400);
    // Header or query parameter, not both.
    expect(
      (await call(boss, 'POST', '', { ...base, auth_mode: 'per_user', auth_header: 'X-Key', auth_query_param: 'k' }))
        .status,
    ).toBe(400);
  });

  it("removing a server, or moving it, drops every member's connection to it", async () => {
    const { json } = await call(boss, 'POST', '', {
      slug,
      name: 'Maps',
      url: 'http://127.0.0.1:9/mcp',
      auth_mode: 'per_user',
      auth_header: 'X-Key',
    });
    const id = json.server.id as number;
    await db.mcpServers.saveConnection(member.id, id, { credential: 'sealed-member-key' });
    await db.mcpServers.saveConnection(boss.id, id, { credential: 'sealed-boss-key' });
    expect((await call(boss, 'GET', '')).json.servers.find((s: { id: number }) => s.id === id).connection_count).toBe(
      2,
    );

    // Same address, new header name: connections stay.
    await call(boss, 'PUT', `/${id}`, { auth_header: 'X-Api-Key' });
    expect(await db.mcpServers.getConnection(member.id, id)).toBeTruthy();

    // A new address: every key was for the old server.
    await call(boss, 'PUT', `/${id}`, { url: 'http://127.0.0.1:10/mcp' });
    expect(await db.mcpServers.getConnection(member.id, id)).toBeUndefined();

    await db.mcpServers.saveConnection(member.id, id, { credential: 'sealed-member-key' });
    expect((await call(boss, 'DELETE', `/${id}`)).status).toBe(200);
    expect(await db.mcpServers.getConnection(member.id, id)).toBeUndefined();
  });

  it("installs a catalog entry as vetted, with key help in the installer's language", async () => {
    await db.users.update(boss.id, { locale: 'zh' });
    const installed = await call(boss, 'POST', '/catalog/install', { id: 'io.github.github/github-mcp-server', slug });
    expect(installed.status).toBe(201);
    expect(installed.json.server).toMatchObject({
      slug,
      catalog_id: 'io.github.github/github-mcp-server',
      auth_mode: 'per_user',
      auth_header: 'Authorization',
      auth_value_prefix: 'Bearer ',
    });
    expect(installed.json.server.credential_help).toMatch(/个人访问令牌/);

    const catalog = await call(boss, 'GET', '/catalog');
    const github = catalog.json.entries.find((e: { id: string }) => e.id === 'io.github.github/github-mcp-server');
    expect(github.installed_slug).toBe(slug);

    expect((await call(boss, 'POST', '/catalog/install', { id: 'no.such/entry' })).status).toBe(404);
    expect((await call(member, 'POST', '/catalog/install', { id: 'app.linear/linear' })).status).toBe(403);
  });

  it('a manual OAuth client keeps its secret write-only', async () => {
    const created = await call(boss, 'POST', '', {
      slug,
      name: 'GitHub (OAuth app)',
      url: 'https://api.githubcopilot.com/mcp/',
      auth_mode: 'oauth',
      oauth_client_id: 'Iv1.client-123',
      oauth_client_secret: 'very-secret-value',
    });
    expect(created.status).toBe(201);
    expect(created.json.server.oauth_client).toEqual({
      source: 'manual',
      client_id: 'Iv1.client-123',
      has_secret: true,
    });
    expect(created.raw).not.toContain('very-secret-value');
    const row = await db.mcpServers.getById(created.json.server.id);
    expect(row?.oauth_client_encrypted).not.toContain('very-secret-value');
  });
});
