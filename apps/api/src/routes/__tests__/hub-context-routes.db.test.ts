/**
 * The v1.7 HTTP surfaces behind the same guards `index.ts` mounts them with:
 * Administration › Team context and the retro button (super only), the data
 * catalog page (any internal member, their own permissions) and the connect
 * wizard's "检查连接" (the member's own connections only).
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type {
  AgentConnectionsCheck,
  DataCatalog,
  RetroResult,
  TeamContextSettingsView,
} from '@greenhouse/types/hub-context';

import type { AppEnv } from '../../app-env.js';
import { requireInternal, requireSuper } from '../../auth/middleware.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { adminRetroRoutes, adminTeamContextRoutes } from '../admin-team-context.js';
import dataCatalogRoutes from '../data-catalog.js';
import { createAgentAccessRoutes } from '../agent-access.js';
import { invalidateWorkspaceConfigCache } from '../../settings/workspace-config.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { stopUpkeepJobs } from '../../scheduler/upkeep-jobs.js';

vi.setConfig({ testTimeout: 20_000 });

let db: DatabaseProvider;
let member: UserRow;
let admin: UserRow;
const savedEnv = { ...process.env };

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function app() {
  const users = new Map([member, admin].map((user) => [user.id, user]));
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role } as never);
    return next();
  });
  hono.use('/api/admin/*', requireSuper());
  hono.route('/api/admin/team-context', adminTeamContextRoutes);
  hono.route('/api/admin/retro', adminRetroRoutes);
  hono.use('/api/data-catalog', requireInternal());
  hono.route('/api/data-catalog', dataCatalogRoutes);
  hono.use('/api/agent-access/*', requireInternal());
  hono.route('/api/agent-access', createAgentAccessRoutes());
  return hono;
}

async function call(as: UserRow, method: string, path: string, body?: unknown) {
  const res = await app().request(path, {
    method,
    headers: { 'x-test-user': as.id, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function doc(title: string, visibility: 'team' | 'private') {
  return db.knowledgeBase.create({
    doc_id: unique('doc'),
    scope: 'shared',
    title,
    content: title,
    visibility,
    status: 'published',
    created_by: admin.id,
    owner_user_id: admin.id,
  });
}

beforeEach(async () => {
  process.env.USAGE_BUDGET_ORG_SCOPE_ID = unique('org');
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(db, [knowledgeRegistration, tablesRegistration]);
  invalidateWorkspaceConfigCache();
  member = await createInternalTestUser(db, { email: `${unique('hub-member')}@test.local` });
  admin = await createInternalTestUser(db, { email: `${unique('hub-admin')}@test.local`, role: 'super' });
});

afterEach(async () => {
  stopUpkeepJobs();
  invalidateWorkspaceConfigCache();
  process.env = { ...savedEnv };
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('Administration › Team context', () => {
  it('is super-only', async () => {
    expect((await call(member, 'GET', '/api/admin/team-context')).status).toBe(403);
    expect((await call(member, 'PUT', '/api/admin/team-context', { conventions: [], glossary: null })).status).toBe(
      403,
    );
    expect((await call(member, 'POST', '/api/admin/retro', {})).status).toBe(403);
  });

  it('saves team documents only, and reports a pick that stopped serving', async () => {
    const conventions = await doc('How we work', 'team');
    const glossary = await doc('Terms', 'team');
    const secret = await doc('Private notes', 'private');

    const refused = await call(admin, 'PUT', '/api/admin/team-context', {
      conventions: [conventions.doc_id, secret.doc_id],
      glossary: null,
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/not visible to the whole team/);
    expect(
      (await call(admin, 'PUT', '/api/admin/team-context', { conventions: [], glossary: null, timezone: 'Mars/Base' }))
        .status,
    ).toBe(400);

    const saved = await call(admin, 'PUT', '/api/admin/team-context', {
      conventions: [conventions.doc_id],
      glossary: glossary.doc_id,
      timezone: 'Europe/Berlin',
    });
    expect(saved.status).toBe(200);
    const view = saved.json as TeamContextSettingsView;
    expect(view.conventions).toEqual([{ doc_id: conventions.doc_id, title: 'How we work', problem: null }]);
    expect(view.glossary).toEqual({ doc_id: glossary.doc_id, title: 'Terms', problem: null });
    expect(view.effective_timezone).toBe('Europe/Berlin');
    expect(view.candidates.map((entry) => entry.doc_id)).toEqual(
      expect.arrayContaining([conventions.doc_id, glossary.doc_id]),
    );
    expect(view.candidates.map((entry) => entry.doc_id)).not.toContain(secret.doc_id);
    // The zone change rescheduled the retro.
    expect(view.retro_next_run_at).toEqual(expect.any(String));

    await db.knowledgeBase.update(glossary.id, { visibility: 'private' }, admin.id);
    const after = (await call(admin, 'GET', '/api/admin/team-context')).json as TeamContextSettingsView;
    expect(after.glossary).toMatchObject({ doc_id: glossary.doc_id, problem: 'not_team' });

    const cleared = (await call(admin, 'PUT', '/api/admin/team-context', { conventions: [], glossary: null }))
      .json as TeamContextSettingsView;
    expect(cleared.conventions).toEqual([]);
    expect(cleared.glossary).toBeNull();
    // Leaving the zone out leaves it as it was.
    expect(cleared.timezone).toBe('Europe/Berlin');
  });
});

describe('retro button', () => {
  it('writes this month’s retro for a super, and refuses a malformed month', async () => {
    const res = await call(admin, 'POST', '/api/admin/retro', {});
    expect(res.status).toBe(200);
    const result = res.json as RetroResult;
    expect(result.month).toBe(new Date().toISOString().slice(0, 7));
    expect(result.doc_id).toBe(`team-retro-${result.month}`);
    expect((await call(admin, 'POST', '/api/admin/retro', { month: 'last' })).status).toBe(400);
  });
});

describe('data catalog page', () => {
  it('serves the member their own catalog', async () => {
    const base = await db.tables.createBase({
      name: 'Mine',
      visibility: 'private',
      owner_id: member.id,
      created_by: member.id,
    });
    await db.tables.createTable({ base_id: base.id, name: 'Rows', created_by: member.id });
    const res = await call(member, 'GET', '/api/data-catalog');
    expect(res.status).toBe(200);
    const catalog = res.json as DataCatalog;
    expect(catalog.bases.map((entry) => entry.id)).toContain(base.id);
    expect(catalog.bases.find((entry) => entry.id === base.id)!.reach[0]!.tool).toBe('tables_query');
  });
});

describe('connect wizard check', () => {
  it('shows when each of my connected agents last reached MCP, and nobody else’s', async () => {
    const clientId = unique('client');
    await db.platformOAuth.registerClient({ id: clientId, client_name: 'Claude Code', redirect_uris: [] });
    const grant = await db.platformOAuth.upsertGrant({
      user_id: member.id,
      client_id: clientId,
      resource: 'http://localhost/api/mcp',
      scopes: ['mcp:read'],
    });
    const token = await db.platformOAuth.createAccessToken(grant.id, {
      token_hash: unique('hash'),
      token_type: 'access',
      resource: 'http://localhost/api/mcp',
      scopes: ['mcp:read'],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    let check = (await call(member, 'GET', '/api/agent-access/connections')).json as AgentConnectionsCheck;
    expect(check.connections).toEqual([
      expect.objectContaining({ client_id: clientId, kind: 'claude-code', last_seen_at: null }),
    ]);

    await db.platformOAuth.touchAccessToken(token!.id);
    check = (await call(member, 'GET', '/api/agent-access/connections')).json as AgentConnectionsCheck;
    expect(check.connections[0]!.last_seen_at).toEqual(expect.any(String));

    expect(
      ((await call(admin, 'GET', '/api/agent-access/connections')).json as AgentConnectionsCheck).connections,
    ).toEqual([]);
  });
});
