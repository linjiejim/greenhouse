/**
 * mcp_call against a real MCP fixture server and the real database: list /
 * describe / call, the per-turn connector block, needs_connection for a member
 * who has not connected, switched-off writes, destructive preview → confirm,
 * write runs and audit rows, and the automation / external-agent rules.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { PLATFORM_ORG_ID } from '../../platform/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { _setConnectorDirectory } from '../../connectors/directory.js';
import { createConnector, updateConnector } from '../../connectors/manage.js';
import { sealMemberKey } from '../../connectors/credentials.js';
import { startMcpTestServer, type McpTestServer } from '../../connectors/__tests__/fixture-server.js';
import { listActivity } from '../../activity/activity-log.js';
import { buildConnectorsContext, executeMcpCall, type McpCallToolContext } from '../mcp-call.js';

vi.setConfig({ testTimeout: 20_000 });
process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);

let open: McpTestServer;
let keyed: McpTestServer;
let db: DatabaseProvider;
let admin: UserRow;
let alice: UserRow;

beforeAll(async () => {
  open = await startMcpTestServer();
  keyed = await startMcpTestServer({ apiKey: { value: 'member-key-1', header: 'x-api-key' } });
});
afterAll(async () => {
  await Promise.all([open.close(), keyed.close()]);
});

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = randomBytes(4).toString('hex');
  admin = await createInternalTestUser(db, { email: `madmin_${tag}@example.test`, role: 'super' });
  alice = await createInternalTestUser(db, { email: `malice_${tag}@example.test` });
  _setConnectorDirectory([]);
  open.tickets.length = 0;
  open.deleted.length = 0;
});
afterEach(async () => {
  await db.close();
  _resetProvider();
});

const actor = () => ({ userId: admin.id, role: admin.role });
const slug = () => `m${randomBytes(3).toString('hex')}`;

async function deskWithWrites(policy: Record<string, 'on' | 'off'> = { create_ticket: 'on', delete_ticket: 'on' }) {
  const row = await createConnector(db, actor(), 'team', { slug: slug(), name: 'Desk', url: open.url });
  return updateConnector(db, actor(), row, { tool_policy: policy });
}

function ctx(overrides: Partial<McpCallToolContext> = {}): McpCallToolContext {
  return { db, userId: alice.id, sessionId: null, surface: 'chat', client: 'web_chat', connectors: null, ...overrides };
}

async function auditRows(connectorId: string) {
  const rows = await db.platform.listAuditEventsForApp(PLATFORM_ORG_ID, 'connectors', 200);
  return rows.filter((r) => r.action_id === 'callConnectorTool' && r.record_id === connectorId);
}

describe('mcp_call', () => {
  it('list / describe / call a read-only tool; the call is audited without its arguments', async () => {
    const row = await deskWithWrites({});
    const listed = (await executeMcpCall(ctx(), { action: 'list' })) as {
      connectors: Array<{ connector: string; tools: Array<{ name: string; kind: string }> }>;
    };
    const desk = listed.connectors.find((c) => c.connector === row.slug)!;
    expect(desk.tools.map((t) => t.name).sort()).toEqual(['chart_png', 'leaky', 'lookup_order', 'whoami']);

    const described = await executeMcpCall(ctx(), { action: 'describe', connector: row.slug, tool: 'lookup_order' });
    expect(described).toMatchObject({ kind: 'read', input_schema: { type: 'object' } });

    const called = await executeMcpCall(ctx(), {
      action: 'call',
      connector: row.slug,
      tool: 'lookup_order',
      arguments: { order_id: 'A-SECRET-77' },
    });
    expect(called).toMatchObject({ is_error: false, result: expect.stringContaining('shipped on 2026-10-01') });
    expect(called).not.toHaveProperty('recorded_as');

    const audits = await auditRows(row.id);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain('A-SECRET-77');
    expect(audits[0]!.result).toBe('success');
  });

  it('switched-off writes are named as switched off; an enabled write runs directly and is recorded as a run', async () => {
    const off = await deskWithWrites({});
    const refused = (await executeMcpCall(ctx(), { action: 'call', connector: off.slug, tool: 'create_ticket' })) as {
      error: string;
    };
    expect(refused.error).toMatch(/switched off/);
    const listed = (await executeMcpCall(ctx(), { action: 'list' })) as {
      connectors: { connector: string; tools: { name: string }[]; switched_off?: string[] }[];
    };
    const desk = listed.connectors.find((c) => c.connector === off.slug);
    expect(desk?.tools.map((t) => t.name)).not.toContain('create_ticket');
    expect(desk?.switched_off).toContain('create_ticket');
    expect(open.tickets).toEqual([]);

    const on = await deskWithWrites();
    const res = (await executeMcpCall(ctx({ sessionId: null }), {
      action: 'call',
      connector: on.slug,
      tool: 'create_ticket',
      arguments: { title: 'Printer jam' },
    })) as { recorded_as: string; result: string };
    expect(open.tickets).toEqual(['Printer jam']);
    const run = await db.runtime.getRun(res.recorded_as);
    expect(run).toMatchObject({ kind: 'connector_write', owner_user_id: alice.id, status: 'succeeded' });

    // It shows in the member's Activity log under 连接器, as their agent's.
    const page = await listActivity(db, alice, { module: 'connectors' }, { manifests: [] });
    expect(page.items[0]).toMatchObject({
      source: 'agent',
      module: 'connectors',
      action: 'create_ticket',
      status: 'succeeded',
      target: { label: 'Desk' },
      run: { id: res.recorded_as, kind: 'connector_write' },
    });
  });

  it('a destructive tool returns a preview first and runs only with confirm:true', async () => {
    const row = await deskWithWrites();
    const preview = await executeMcpCall(ctx(), {
      action: 'call',
      connector: row.slug,
      tool: 'delete_ticket',
      arguments: { id: 'T-9' },
    });
    expect(preview).toMatchObject({ status: 'needs_confirmation', arguments: { id: 'T-9' } });
    expect(open.deleted).toEqual([]);
    const done = await executeMcpCall(ctx(), {
      action: 'call',
      connector: row.slug,
      tool: 'delete_ticket',
      arguments: { id: 'T-9' },
      confirm: true,
    });
    expect(done).toMatchObject({ is_error: false, recorded_as: expect.any(String) });
    expect(open.deleted).toEqual(['T-9']);
  });

  it('automations: reads and enabled writes, never destructive (not even with confirm)', async () => {
    const row = await deskWithWrites();
    const auto = ctx({ surface: 'automation', client: 'automation' });
    const write = await executeMcpCall(auto, {
      action: 'call',
      connector: row.slug,
      tool: 'create_ticket',
      arguments: { title: 'x' },
    });
    expect(write).toMatchObject({ is_error: false });
    const destructive = await executeMcpCall(auto, {
      action: 'call',
      connector: row.slug,
      tool: 'delete_ticket',
      arguments: { id: '1' },
      confirm: true,
    });
    expect(destructive).toHaveProperty('error');
    expect(open.deleted).toEqual([]);
    const block = await buildConnectorsContext(auto);
    expect(block).toContain('create_ticket [写]');
    expect(block).not.toContain('delete_ticket');
  });

  it('external agents: no writes without mcp:write; a team credential writes only when allowed', async () => {
    const row = await deskWithWrites();
    const external = (writesAllowed: boolean) => ctx({ surface: 'mcp', client: 'mcp', writesAllowed });
    expect(
      await executeMcpCall(external(false), {
        action: 'call',
        connector: row.slug,
        tool: 'create_ticket',
        arguments: { title: 'x' },
      }),
    ).toHaveProperty('error');
    // A public (team) connector without allow_external_writes stays read-only even with mcp:write.
    expect(
      await executeMcpCall(external(true), {
        action: 'call',
        connector: row.slug,
        tool: 'create_ticket',
        arguments: { title: 'x' },
      }),
    ).toHaveProperty('error');
    await updateConnector(db, actor(), row, { allow_external_writes: true });
    expect(
      await executeMcpCall(external(true), {
        action: 'call',
        connector: row.slug,
        tool: 'create_ticket',
        arguments: { title: 'x' },
      }),
    ).toMatchObject({ is_error: false });
    expect(open.tickets).toEqual(['x']);
  });

  it('per-member connector: needs_connection until the member adds a key, then calls with their key', async () => {
    const row = await createConnector(db, actor(), 'team', {
      slug: slug(),
      name: 'Keyed',
      url: keyed.url,
      auth_mode: 'per_member',
      auth_kind: 'key',
      auth_header: 'x-api-key',
    });
    const block = await buildConnectorsContext(ctx());
    expect(block).toContain(`${row.slug} [未连接]`);
    const before = await executeMcpCall(ctx(), {
      action: 'call',
      connector: row.slug,
      tool: 'lookup_order',
      arguments: {},
    });
    expect(before).toMatchObject({ needs_connection: true, connector_id: row.id, reason: 'not_connected' });

    await db.mcpConnectors.saveConnection(alice.id, row.id, {
      credential: sealMemberKey(row.id, alice.id, 'member-key-1'),
      metadata: { connected_via: 'key' },
    });
    const after = await executeMcpCall(ctx(), {
      action: 'call',
      connector: row.slug,
      tool: 'lookup_order',
      arguments: { order_id: '1' },
    });
    expect(after).toMatchObject({ is_error: false });
    expect(await buildConnectorsContext(ctx())).not.toContain('[未连接]');
  });

  it("an agent's connectors list narrows what it sees", async () => {
    const a = await deskWithWrites({});
    const b = await deskWithWrites({});
    const narrowed = ctx({ connectors: [a.id] });
    const listed = (await executeMcpCall(narrowed, { action: 'list' })) as { connectors: Array<{ connector: string }> };
    expect(listed.connectors.map((c) => c.connector)).toEqual([a.slug]);
    expect(await executeMcpCall(narrowed, { action: 'call', connector: b.slug, tool: 'lookup_order' })).toHaveProperty(
      'error',
    );
  });

  it('prompt-injection text in a result is flagged and wrapped', async () => {
    const row = await deskWithWrites({});
    const res = await executeMcpCall(ctx(), { action: 'call', connector: row.slug, tool: 'leaky' });
    expect(res).toMatchObject({ flagged: true });
  });
});
