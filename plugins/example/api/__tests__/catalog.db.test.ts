import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.GREENHOUSE_EXTENSIONS = 'example';
});
import { initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import {
  webCatalog as readWebCatalog,
  mcpCatalog,
} from '../../../../apps/api/src/hub-context/__tests__/catalog-fixture.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../../../apps/api/src/platform/runtime.js';
import { projectsRegistration } from '../../../projects/api/platform/application.js';
import { knowledgeRegistration } from '../../../../apps/api/src/platform/knowledge/registration.js';
import { tablesRegistration } from '../../../tables/api/platform/application.js';
let db: DatabaseProvider;
let member: UserRow;
const webCatalog = (user: UserRow) => readWebCatalog(db, user);
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(db, [projectsRegistration, knowledgeRegistration, tablesRegistration]);
  member = await createInternalTestUser(db, { email: `plugin-catalog-${Date.now()}@test.local` });
});
afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
});
afterAll(() => {
  delete process.env.GREENHOUSE_EXTENSIONS;
});

describe('data catalog: extension sources', () => {
  it('hides an extension whose tools the member does not reach (its flag is off by default)', async () => {
    expect((await webCatalog(member)).extensions.map((entry) => entry.id)).not.toContain('example');
  });

  it('lists the example extension once the member has it, with its search kinds, exports and tools', async () => {
    await db.userFeatures.upsert({ user_id: member.id, feature: 'example', enabled: true });
    const example = (await webCatalog(member)).extensions.find((entry) => entry.id === 'example');
    expect(example).toMatchObject({
      kind: 'extension',
      name: expect.any(String),
      record_kinds: ['ext:example:note'],
      exports: [expect.objectContaining({ type: 'example_notes' })],
    });
    expect(example!.reach).toEqual([
      expect.objectContaining({ tool: 'example_notes_query', access: 'read', group: 'example' }),
      expect.objectContaining({ tool: 'example_notes_mutation', access: 'write', group: 'example' }),
      expect.objectContaining({ tool: 'export_data', group: null }),
    ]);
  });

  it('on MCP, needs the extension’s own group as well', async () => {
    await db.userFeatures.upsert({ user_id: member.id, feature: 'example', enabled: true });
    expect((await mcpCatalog(member, ['mcp:read', 'mcp:tables'])).extensions.map((entry) => entry.id)).not.toContain(
      'example',
    );
    const granted = await mcpCatalog(member, ['mcp:read', 'mcp:example']);
    expect(granted.extensions.map((entry) => entry.id)).toEqual(['example']);
    expect(granted.bases).toEqual([]);
  });
});
