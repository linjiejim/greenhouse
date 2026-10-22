/**
 * Admin configuration writes leave a platform audit trail — key names only.
 *
 * Workspace settings hold the LLM / media / search credentials, so the audit
 * event must name what changed without ever carrying a value.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import adminSettingsRoutes from '../admin-settings.js';
import adminRoutes from '../admin.js';
import { PLATFORM_ORG_ID } from '../../platform/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let admin: UserRow;
const previousKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
const SECRET = 'tvly-audit-test-secret-value';

function app() {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: admin.id, role: 'super' });
      return next();
    })
    .route('/api/admin/settings', adminSettingsRoutes)
    .route('/api/admin', adminRoutes);
}

async function auditEvents(actionId: string) {
  return (await db.platform.listAuditEvents(PLATFORM_ORG_ID, 500)).filter(
    (event) => event.actor_id === admin.id && event.action_id === actionId,
  );
}

describe('admin configuration audit', () => {
  beforeEach(async () => {
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = '0'.repeat(64);
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    admin = await createInternalTestUser(db, { email: `config-audit-${Date.now()}@test.local`, role: 'super' });
  });

  afterEach(async () => {
    if (previousKey === undefined) delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    else process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = previousKey;
    await db.close();
    _resetProvider();
  });

  it('records which workspace settings were set and cleared, never their values', async () => {
    const res = await app().request('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: { 'search.tavily_api_key': SECRET, 'branding.product_name': 'Audit Garden', 'llm.model_pro': null },
      }),
    });
    expect(res.status).toBe(200);

    const [event] = await auditEvents('updateWorkspaceSettings');
    expect(event).toBeDefined();
    expect(event!.capability).toBe('platform.settings.manage');
    expect(JSON.parse(event!.summary)).toEqual({
      set: ['search.tavily_api_key', 'branding.product_name'],
      cleared: ['llm.model_pro'],
      secret_keys: ['search.tavily_api_key'],
    });
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(JSON.stringify(event)).not.toContain('Audit Garden');

    // Clean the overlay the write applied to this worker's process.env.
    await app().request('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { 'search.tavily_api_key': null, 'branding.product_name': null } }),
    });
  });

  it('records nothing for an empty or rejected batch', async () => {
    const empty = await app().request('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: {} }),
    });
    expect(empty.status).toBe(200);
    const rejected = await app().request('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { 'no.such.key': 'x' } }),
    });
    expect(rejected.status).toBe(400);
    expect(await auditEvents('updateWorkspaceSettings')).toEqual([]);
  });

  it('records a per-user feature toggle with config key names only', async () => {
    const member = await createInternalTestUser(db, { email: `config-audit-member-${Date.now()}@test.local` });
    const res = await app().request('/api/admin/features', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: member.id, feature: 'memory', enabled: false, config: { quota: 12345 } }),
    });
    expect(res.status).toBe(200);
    const [event] = await auditEvents('setUserFeature');
    expect(event!.record_id).toBe(member.id);
    expect(JSON.parse(event!.summary)).toEqual({ feature: 'memory', enabled: false, config_keys: ['quota'] });
    expect(event!.summary).not.toContain('12345');
  });
});
