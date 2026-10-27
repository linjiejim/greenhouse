import { afterEach, expect, it } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../runtime.js';
import { stationManifest } from '../station-manifest.js';
afterEach(() => {
  resetPlatformRuntimeForTests();
  _resetProvider();
});
it('keeps the v1 fields and v2 envelope when the station has no plugins', async () => {
  const db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  try {
    initializePlatformRuntime(db, []);
    const user = await createInternalTestUser(db, { email: `manifest-off-${crypto.randomUUID()}@test.local` });
    expect(await stationManifest(db, { id: user.id, role: 'team' }, [])).toMatchObject({
      manifest_version: 2,
      core: { client_api: 4 },
      plugins: [],
      extensions: [],
      entityKinds: [],
    });
  } finally {
    await db.close();
  }
});
