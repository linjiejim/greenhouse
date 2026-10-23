/**
 * Boolean workspace switches resolve as stored override → env var → default,
 * and the admin views say both what is in effect and what clearing the
 * override would leave — so GATEWAY_ENABLED=true with no stored row reads On
 * and can still be switched off.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import {
  getWorkspaceFlag,
  getWorkspaceFlagState,
  getWorkspaceSettingViews,
  invalidateWorkspaceConfigCache,
} from '../workspace-config.js';

let db: DatabaseProvider;
let admin: UserRow;
const previousEnv = process.env.GATEWAY_ENABLED;

beforeAll(() => {
  // Set before the first read: the config snapshots each env var once per process.
  process.env.GATEWAY_ENABLED = 'true';
});

afterAll(() => {
  if (previousEnv === undefined) delete process.env.GATEWAY_ENABLED;
  else process.env.GATEWAY_ENABLED = previousEnv;
});

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  admin = await createInternalTestUser(db, {
    email: `flags-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    role: 'super',
  });
  invalidateWorkspaceConfigCache();
});

afterEach(async () => {
  invalidateWorkspaceConfigCache();
  await db.close();
  _resetProvider();
});

async function gatewayView() {
  return (await getWorkspaceSettingViews()).find((view) => view.key === 'gateway.enabled')!;
}

describe('boolean workspace switches', () => {
  it('reads the env var when nothing is stored', async () => {
    expect(await getWorkspaceFlagState('gateway.enabled')).toEqual({
      override: null,
      fallback: true,
      effective: true,
      source: 'env',
    });
    const view = await gatewayView();
    expect(view).toMatchObject({
      value: null,
      has_value: false,
      source: 'env',
      flag: { effective: true, fallback: true },
    });
  });

  it('lets a stored override switch an env-enabled flag off, and clearing it brings the env value back', async () => {
    await db.workspaceSettings.set('gateway.enabled', { value: false }, admin.id);
    invalidateWorkspaceConfigCache();
    expect(await getWorkspaceFlagState('gateway.enabled')).toEqual({
      override: false,
      fallback: true,
      effective: false,
      source: 'db',
    });
    expect(await getWorkspaceFlag('gateway.enabled')).toBe(false);
    expect((await gatewayView()).flag).toEqual({ effective: false, fallback: true });

    await db.workspaceSettings.clear('gateway.enabled');
    invalidateWorkspaceConfigCache();
    expect(await getWorkspaceFlag('gateway.enabled')).toBe(true);
  });

  it('gives non-boolean settings no flag', async () => {
    const views = await getWorkspaceSettingViews();
    expect(views.find((view) => view.key === 'llm.model')?.flag).toBeNull();
  });
});
