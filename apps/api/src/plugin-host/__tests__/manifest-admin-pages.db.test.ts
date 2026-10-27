import { afterEach, expect, it } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../runtime.js';
import { defineExtension } from '../define.js';
import { stationManifest } from '../station-manifest.js';
afterEach(() => {
  resetPlatformRuntimeForTests();
  _resetProvider();
});
it('serves Admin sections (native and settings form) to supers alone', async () => {
  const db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  try {
    initializePlatformRuntime(db, []);
    const extension = defineExtension({
      id: 'fixture-admin',
      name: 'Fixture admin',
      sdk: 2,
      surfaces: {
        nav: [{ id: 'app', label: 'App', icon: 'Box', page: 'app', placement: 'more' }],
        pages: [
          { id: 'app', kind: 'native', screen: 'fixture-app', title: 'App' },
          { id: 'queue', kind: 'native', screen: 'fixture-queue', title: 'Queue', parent: 'administration' },
          { id: 'settings', kind: 'settings-form', title: 'Settings', settings: [], parent: 'administration' },
        ],
      },
    });
    const member = await createInternalTestUser(db, { email: `admin-pages-${crypto.randomUUID()}@test.local` });
    const admin = await createInternalTestUser(db, {
      email: `admin-pages-${crypto.randomUUID()}@test.local`,
      role: 'super',
    });
    const pages = async (user: { id: string; role: 'team' | 'super' }) =>
      (await stationManifest(db, user, [extension])).plugins[0]?.pages.map((page) => page.id);
    expect(await pages({ id: member.id, role: 'team' })).toEqual(['app']);
    expect(await pages({ id: admin.id, role: 'super' })).toEqual(['app', 'queue', 'settings']);
  } finally {
    await db.close();
  }
});
