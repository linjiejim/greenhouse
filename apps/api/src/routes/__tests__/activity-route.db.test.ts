/**
 * /api/activity through the real route: a member's user filter is ignored,
 * bad windows are 400s, and the CSV export carries the same rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { initDatabase, _resetProvider, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createActivityRoutes } from '../activity.js';
import type { AppEnv } from '../../app-env.js';
import { initializePlatformRuntime, PLATFORM_ORG_ID, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function app(user: UserRow) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: user.id, role: user.role, email: user.email, name: user.nickname } as never);
      await next();
    })
    .route('/api/activity', createActivityRoutes());
}

async function createdProject(actor: UserRow, title: string) {
  await db.platform.recordAudit({
    orgId: PLATFORM_ORG_ID,
    actorId: actor.id,
    actorType: 'human',
    requestId: unique('req'),
    resource: { appId: 'projects', entityId: 'project' },
    actionId: 'createProject',
    capability: 'projects.portfolio.create',
    result: 'success',
    summary: { title },
  });
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(db, [projectsRegistration]);
  alice = await createInternalTestUser(db, { email: `${unique('ar-alice')}@test.local`, nickname: 'Alice' });
  bob = await createInternalTestUser(db, { email: `${unique('ar-bob')}@test.local`, nickname: '=Bob' });
  await createdProject(alice, 'a');
  await createdProject(bob, 'b');
});

afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('/api/activity', () => {
  it('ignores a member’s user filter and returns only their own changes', async () => {
    const res = await app(alice).request(`/api/activity?user_id=${bob.id}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: Array<{ actor: { id: string } }>; window: { from: string } };
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.actor.id === alice.id)).toBe(true);
    expect(page.window.from).toMatch(/^\d{4}-/);
  });

  it('rejects an unknown source and an inverted window', async () => {
    expect((await app(alice).request('/api/activity?source=robots')).status).toBe(400);
    expect((await app(alice).request('/api/activity?from=2026-02-01&to=2026-01-01')).status).toBe(400);
  });

  it('exports the same rows as CSV, with formula-looking names neutralized', async () => {
    const res = await app(bob).request('/api/activity/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    const [header, ...rows] = text.replace(/^\uFEFF/, '').split('\r\n');
    expect(header).toBe('time,source,person,agent,module,action,target,status,detail');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.includes(`"'=Bob"`))).toBe(true);
  });
});
