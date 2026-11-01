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
const embedPlugin = () =>
  defineExtension({
    id: 'fixture-embed',
    name: 'Fixture embed',
    sdk: 2,
    entityKinds: [{ kind: 'ext:fixture-embed:deal', route: '#/fixture-embed/deals/:id', page: 'workspace' }],
    surfaces: {
      nav: [{ id: 'workspace', label: 'Workspace', icon: 'Box', page: 'workspace', placement: 'more' }],
      pages: [{ id: 'workspace', kind: 'embed', title: 'Workspace', url: '/ext/fixture-embed/ui/' }],
    },
  });
it('serves record links that open an embed page, without entity pages', async () => {
  const db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  try {
    initializePlatformRuntime(db, []);
    const member = await createInternalTestUser(db, { email: `embed-links-${crypto.randomUUID()}@test.local` });
    const manifest = await stationManifest(db, { id: member.id, role: 'team' }, [embedPlugin()]);
    expect(manifest.plugins[0]?.entity_kinds).toEqual([
      { kind: 'ext:fixture-embed:deal', route: '#/fixture-embed/deals/:id', page: 'workspace' },
    ]);
  } finally {
    await db.close();
  }
});
it('refuses a record link to a page that is not one of its embeds', () => {
  expect(() =>
    defineExtension({
      id: 'fixture-bad',
      name: 'Fixture bad',
      sdk: 2,
      entityKinds: [{ kind: 'ext:fixture-bad:deal', route: '#/fixture-bad/deals/:id', page: 'missing' }],
    }),
  ).toThrow(/not an embed page/);
});
