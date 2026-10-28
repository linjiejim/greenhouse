import { services as tableServices } from '../services.js';
import {
  fullGrantReach,
  webCatalog as readWebCatalog,
  mcpCatalog,
} from '../../../../apps/api/src/hub-context/__tests__/catalog-fixture.js';
/**
 * Data catalog (数据目录) permission filtering on the real database, with the
 * core compiled without any plugin requirement.
 *
 * Pinned here: Tables bases come from the Tables application's own listing (a
 * private base of another member never appears; counts are row counts only);
 * a grant without `mcp:tables` lists no bases. Plugin-source coverage lives with the plugin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import { moveToRestrictedRole, withoutCapability } from '../../../../tests/helpers/restricted-role.js';
import { tablesManifest } from '../platform/manifest.js';
import {
  initializePlatformRuntime,
  resetPlatformRuntimeForTests,
} from '../../../../apps/api/src/plugin-host/runtime.js';
import { extensionApplicationRegistrations } from '../../../../apps/api/src/plugin-host/boot.js';
import { humanActor } from '../../../../apps/api/src/plugin-host/actor.js';
import { buildTeamContextBundle } from '../../../../apps/api/src/hub-context/team-context.js';
vi.setConfig({ testTimeout: 20000 });
let db: DatabaseProvider;
let owner: UserRow;
let member: UserRow;
let teamBaseId: string;
let ownBaseId: string;
let foreignBaseId: string;
function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
async function base(ownerId: string, name: string, visibility: 'team' | 'private', rows: number) {
  const created = await tableServices(db).tables.createBase({
    name,
    visibility,
    owner_id: ownerId,
    created_by: ownerId,
  });
  const schema = await tableServices(db).tables.createTable({
    base_id: created.id,
    name: `${name} table`,
    created_by: ownerId,
  });
  for (let index = 0; index < rows; index++) {
    await tableServices(db).tables.createRecord({
      table_id: schema.table.id,
      values: { [schema.fields[0]!.id]: `Row ${index}` },
      user_id: ownerId,
    });
  }
  return created.id;
}
const webCatalog = (user: UserRow) => readWebCatalog(db, user);
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(db, extensionApplicationRegistrations());
  owner = await createInternalTestUser(db, {
    email: `${unique('catalog-owner')}@test.local`,
    nickname: 'Base Owner',
  });
  member = await createInternalTestUser(db, { email: `${unique('catalog-member')}@test.local` });
  teamBaseId = await base(owner.id, unique('Team base'), 'team', 2);
  ownBaseId = await base(member.id, unique('My base'), 'private', 0);
  foreignBaseId = await base(owner.id, unique('Owner private'), 'private', 1);
});
afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});
describe('data catalog: Tables bases', () => {
  it('uses the existing bases wire field without a duplicate generic Tables entry', async () => {
    expect((await webCatalog(member)).extensions.some((source) => source.id === 'tables')).toBe(false);
  });
  it('lists the bases the member can read, with row counts, owner and the tool to reach them', async () => {
    const catalog = await webCatalog(member);
    const ids = catalog.bases.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining([teamBaseId, ownBaseId]));
    expect(ids).not.toContain(foreignBaseId);
    const team = catalog.bases.find((entry) => entry.id === teamBaseId)!;
    expect(team.owner).toEqual({ id: owner.id, name: 'Base Owner' });
    expect(team.tables).toHaveLength(1);
    expect(team.tables[0]).toMatchObject({ row_count: 2 });
    expect(team.tables[0]!.last_changed_at).toEqual(expect.any(String));
    expect(team.url).toBe(`#/tables/${teamBaseId}`);
    expect(team.reach.map((entry) => entry.tool)).toContain('tables_query');
    // A viewer of someone else's team base gets no write path; the owner of a base does.
    const own = catalog.bases.find((entry) => entry.id === ownBaseId)!;
    expect(own.reach.map((entry) => entry.tool)).toEqual(['tables_query', 'tables_mutation']);
  });
  it('leaves row counts and record activity out where the member may not read records', async () => {
    await moveToRestrictedRole(db, member.id, {
      capabilities: withoutCapability('tables.data.read', {
        'tables.*': [...new Set(Object.values(tablesManifest.actions).map((action) => action.capability))],
      }),
    });
    for (const catalog of [await webCatalog(member), await mcpCatalog(member, ['mcp:read', 'mcp:tables'])]) {
      const team = catalog.bases.find((entry) => entry.id === teamBaseId)!;
      // Structure is still listed through the guarded listing…
      expect(team.tables).toHaveLength(1);
      expect(team.tables[0]!.name).toEqual(expect.any(String));
      // …but how many records it holds is not this member's to know.
      expect(team.tables[0]!.row_count).toBeNull();
    }
  });
  it('keeps the table total and flags a base whose tables were cut, here and in team_context', async () => {
    const big = await tableServices(db).tables.createBase({
      name: unique('Big base'),
      visibility: 'team',
      owner_id: owner.id,
      created_by: owner.id,
    });
    for (let index = 0; index < 52; index++) {
      await tableServices(db).tables.createTable({ base_id: big.id, name: `T${index}`, created_by: owner.id });
    }
    const entry = (await webCatalog(member)).bases.find((candidate) => candidate.id === big.id)!;
    expect(entry.tables).toHaveLength(50);
    expect(entry.table_count).toBe(52);
    expect(entry.tables_truncated).toBe(true);
    const team = (await webCatalog(member)).bases.find((candidate) => candidate.id === teamBaseId)!;
    expect(team).toMatchObject({ table_count: 1, tables_truncated: false });
    const bundle = await buildTeamContextBundle({
      db,
      userId: member.id,
      role: 'team',
      reachable: await fullGrantReach(member),
      actor: humanActor(member),
    });
    expect(bundle.data_sources.tables).toBeGreaterThanOrEqual(52 + 1 + 1);
    expect(bundle.data_sources).toMatchObject({ truncated: true });
  });
  it('lists no bases for a member whose Tables access is switched off', async () => {
    await db.userFeatures.upsert({ user_id: member.id, feature: 'tables', enabled: false });
    expect((await webCatalog(member)).bases).toEqual([]);
  });
  it('follows the grant on MCP: no tables group, no bases', async () => {
    expect((await mcpCatalog(member, ['mcp:read', 'mcp:tables'])).bases.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([teamBaseId, ownBaseId]),
    );
    expect((await mcpCatalog(member, ['mcp:read', 'mcp:knowledge'])).bases).toEqual([]);
  });
});
