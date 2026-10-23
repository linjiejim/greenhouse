/**
 * Data catalog (数据目录) permission filtering on the real database, with the
 * example extension switched on so an extension data source is in play.
 *
 * Pinned here: Tables bases come from the Tables application's own listing (a
 * private base of another member never appears; counts are row counts only);
 * an extension source appears only when the member reaches one of its MCP tools
 * (its feature flag decides) and, on MCP, only when the grant carries its
 * group; a grant without `mcp:tables` lists no bases.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Registries are computed at load time: switch the example on before any import.
vi.hoisted(() => {
  process.env.GREENHOUSE_EXTENSIONS = 'example';
});

import type { Context } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { DataCatalog } from '@greenhouse/types/hub-context';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { buildMcpServer, composeMcpContext } from '../../routes/mcp.js';
import { identityFromOAuthScopes } from '../../agent-runtime/mcp-auth.js';
import { memberMcpToolIds } from '../../agent-runtime/mcp-tool-visibility.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { humanActor } from '../../platform/actor.js';
import { buildDataCatalog } from '../catalog.js';

vi.setConfig({ testTimeout: 20_000 });

let db: DatabaseProvider;
let owner: UserRow;
let member: UserRow;
let teamBaseId: number;
let ownBaseId: number;
let foreignBaseId: number;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function base(ownerId: string, name: string, visibility: 'team' | 'private', rows: number) {
  const created = await db.tables.createBase({ name, visibility, owner_id: ownerId, created_by: ownerId });
  const schema = await db.tables.createTable({ base_id: created.id, name: `${name} table`, created_by: ownerId });
  for (let index = 0; index < rows; index++) {
    await db.tables.createRecord({
      table_id: schema.table.id,
      values: { [schema.fields[0]!.id]: `Row ${index}` },
      user_id: ownerId,
    });
  }
  return created.id;
}

async function webCatalog(user: UserRow): Promise<DataCatalog> {
  return buildDataCatalog({
    db,
    actor: humanActor(user),
    reachable: await memberMcpToolIds(user.id, user.role as 'team' | 'super'),
  });
}

async function mcpCatalog(user: UserRow, scopes: string[]): Promise<DataCatalog> {
  const identity = identityFromOAuthScopes({ id: user.id, role: user.role as 'team' | 'super' }, scopes);
  const ctx = await composeMcpContext(identity, {});
  const c = {
    get: (key: string) => (key === 'agentIdentity' ? identity : key === 'oauthClientId' ? 'catalog-client' : undefined),
    req: { method: 'POST', header: () => undefined },
  } as unknown as Context;
  const server = buildMcpServer(c, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  const result = (await client.callTool({ name: 'data_catalog', arguments: {} })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as DataCatalog;
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(db, [projectsRegistration, knowledgeRegistration, tablesRegistration]);
  owner = await createInternalTestUser(db, {
    email: `${unique('catalog-owner')}@test.local`,
    nickname: 'Base Owner',
  });
  member = await createInternalTestUser(db, { email: `${unique('catalog-member')}@test.local` });
  teamBaseId = await base(owner.id, unique('Team base'), 'team', 2);
  ownBaseId = await base(member.id, unique('My base'), 'private', 0);
  foreignBaseId = await base(owner.id, unique('Owner private'), 'private', 1);
});

afterAll(() => {
  delete process.env.GREENHOUSE_EXTENSIONS;
});

afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('data catalog: Tables bases', () => {
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
