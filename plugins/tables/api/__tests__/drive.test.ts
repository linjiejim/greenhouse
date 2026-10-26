import { describe, expect, it, vi } from 'vitest';
import { tablesDriveScope } from '../drive.js';
import type { DatabaseProvider } from '@greenhouse/db';
vi.mock('../../../../apps/api/src/platform/runtime.js', () => ({
  PLATFORM_ORG_ID: 'default',
  getPlatformRuntime: () => ({ authorize: async () => ({ allowed: true }) }),
}));
vi.mock('../../../../apps/api/src/auth/features.js', () => ({ userHasFeature: async () => true }));
describe('Tables drive scope', () => {
  it.each([
    ['owner', 'owner'],
    ['builder', 'editor'],
    ['editor', 'editor'],
    ['viewer', 'reader'],
    [null, null],
  ] as const)('maps base role %s to %s', async (role, expected) => {
    const tables = {
      getBase: async () => ({ owner_id: 'owner', visibility: 'private' }),
      getBaseMember: async () => (role ? { role } : undefined),
    };
    const db = { extensions: { tables: { tables } } } as unknown as DatabaseProvider;
    expect(
      await tablesDriveScope.authorizeNode!(
        { scope: 'tables', base_id: 'b' },
        { userId: role === 'owner' ? 'owner' : 'member', userRole: 'team', db, operation: 'read' },
      ),
    ).toBe(expected);
  });
  it('preserves the base_id placement contract', () => {
    expect(tablesDriveScope.placement!({ base_id: 'b' }, 'u')).toEqual({
      base_id: 'b',
      visibility: null,
      owner_user_id: null,
      owner_key: null,
    });
    expect(tablesDriveScope.placement!({}, 'u')).toEqual({ error: 'base_id is required for tables scope' });
  });
});
