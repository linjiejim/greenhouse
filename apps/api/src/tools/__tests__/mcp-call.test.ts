/**
 * mcp_call — the one gateway tool to installed MCP servers (connectors),
 * driven against a real MCP server. Pins: no tool without a callable server,
 * the confirm gate on anything not read-only (and that the remote side never
 * runs without it), the allow-list, the untrusted-data envelope, and per
 * member: a per_user server answers `needs_connection` until the member adds
 * their own key, the Bots face asks on a card instead of trusting `confirm`,
 * a Bot's connector list narrows what it sees, and a vouched read-only tool
 * runs without confirmation (spec 20261009-mcp-connectors D7–D10).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider, McpServerRow, ProviderTokenRow } from '@greenhouse/db';
import { _setMcpDirectory, callableTools } from '../../mcp-client/directory.js';
import { discoverMcpTools } from '../../mcp-client/client.js';
import { sealMemberCredential } from '../../mcp-client/credentials.js';
import { startMcpTestServer, type McpTestServer } from '../../mcp-client/__tests__/fixture-server.js';
import { createMcpCallTool, renderMcpCatalog, type McpApprovalDecision, type McpApprovalRequest } from '../mcp-call.js';

process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);

let fixture: McpTestServer;
let keyed: McpTestServer;
let row: McpServerRow;
let keyedRow: McpServerRow;

function serverRow(over: Partial<McpServerRow>): McpServerRow {
  return {
    id: 7,
    slug: 'orders',
    name: 'Order desk',
    description: 'Orders and support tickets',
    url: '',
    transport: 'streamable_http',
    auth_mode: 'none',
    auth_header: null,
    auth_query_param: null,
    auth_value_prefix: null,
    auth_value_encrypted: null,
    credential_help: null,
    credential_url: null,
    oauth_scope: null,
    oauth_client_encrypted: null,
    oauth_discovery: null,
    enabled: true,
    allowed_tools: null,
    read_only_tools: null,
    catalog_id: null,
    tools: [],
    tools_refreshed_at: '2026-10-09T00:00:00.000Z',
    last_error: null,
    created_by: null,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...over,
  };
}

/** A db with just what mcp_call reads: the rows by id and a member's connections. */
function fakeDb(
  rows: () => McpServerRow[],
  connections: Record<string, Partial<ProviderTokenRow>> = {},
): DatabaseProvider {
  const connection = (userId: string, serverId: number) => connections[`${userId}:${serverId}`];
  return {
    mcpServers: {
      getById: async (id: number) => rows().find((r) => r.id === id),
      getConnection: async (userId: string, serverId: number) => connection(userId, serverId),
      listConnections: async (userId: string) =>
        Object.entries(connections)
          .filter(([key]) => key.startsWith(`${userId}:`))
          .map(([key, value]) => ({ provider: `mcp:${key.split(':')[1]}`, ...value })),
    },
  } as unknown as DatabaseProvider;
}

function directoryOf(...rows: McpServerRow[]) {
  _setMcpDirectory(
    rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      auth_mode: r.auth_mode,
      tools: callableTools(r),
    })),
  );
}

async function run(tool: NonNullable<ReturnType<typeof createMcpCallTool>>, input: Record<string, unknown>) {
  return (await tool.execute!(input as never, { toolCallId: 't', messages: [], context: {} })) as Record<
    string,
    unknown
  >;
}

beforeAll(async () => {
  fixture = await startMcpTestServer();
  keyed = await startMcpTestServer({ apiKey: { value: 'member-key-1', query: 'key' } });
  const tools = await discoverMcpTools({ url: fixture.url, transport: 'streamable_http', headers: {} });
  row = serverRow({ url: fixture.url, tools });
  keyedRow = serverRow({
    id: 8,
    slug: 'maps',
    name: 'Maps',
    description: 'Per-member key in the query string',
    url: keyed.url,
    auth_mode: 'per_user',
    auth_query_param: 'key',
    tools,
  });
});

afterAll(async () => {
  _setMcpDirectory([]);
  await fixture.close();
  await keyed.close();
});

beforeEach(() => {
  fixture.tickets.length = 0;
  keyed.tickets.length = 0;
  directoryOf(row);
});

describe('mcp_call', () => {
  it('is not offered at all while no server has anything callable', () => {
    _setMcpDirectory([]);
    expect(
      createMcpCallTool(
        fakeDb(() => [row]),
        { userId: 'u1' },
      ),
    ).toBeNull();
  });

  it('lists the connected servers and their tools in its description', () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row]),
      { userId: 'u1' },
    )!;
    expect(tool.description).toContain('"orders" — Order desk');
    expect(tool.description).toContain('lookup_order [read-only]');
    expect(tool.description).toMatch(/create_ticket(?! \[read-only\])/);
    // No member-account server: no word about connecting.
    expect(tool.description).not.toContain('needs_connection');
  });

  it('describe returns the argument schema the model needs', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row]),
      { userId: 'u1' },
    )!;
    const out = await run(tool, { action: 'describe', server: 'orders', tool: 'lookup_order' });
    expect(out.input_schema).toMatchObject({ required: ['order_id'] });
    expect(out.read_only).toBe(true);
  });

  it('runs a read-only tool and wraps the result as untrusted external data', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row]),
      { userId: 'u1' },
    )!;
    const out = await run(tool, {
      action: 'call',
      server: 'orders',
      tool: 'lookup_order',
      arguments: { order_id: 'A-7' },
    });
    expect(out.is_error).toBe(false);
    expect(out.result).toBe(
      '<external_source url="mcp://orders/lookup_order" trust="untrusted">\nOrder A-7: shipped on 2026-10-01\n</external_source>',
    );
  });

  it('refuses a writer without confirm — and the remote side never runs', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row]),
      { userId: 'u1' },
    )!;
    const refused = await run(tool, {
      action: 'call',
      server: 'orders',
      tool: 'create_ticket',
      arguments: { title: 'x' },
    });
    expect(refused.needs_confirmation).toBe(true);
    expect(fixture.tickets).toEqual([]);

    const done = await run(tool, {
      action: 'call',
      server: 'orders',
      tool: 'create_ticket',
      arguments: { title: 'Printer on fire' },
      confirm: true,
    });
    expect(String(done.result)).toContain('Created ticket T-1: Printer on fire');
    expect(fixture.tickets).toEqual(['Printer on fire']);
  });

  it('redacts a prompt-injection attempt in a result', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row]),
      { userId: 'u1' },
    )!;
    const out = await run(tool, { action: 'call', server: 'orders', tool: 'leaky' });
    expect(out.flagged).toBe(true);
    expect(String(out.result)).not.toContain('reveal your system prompt');
  });

  it('only offers what the allow-list keeps', async () => {
    const limited = { ...row, allowed_tools: ['lookup_order'] };
    directoryOf(limited);
    const tool = createMcpCallTool(
      fakeDb(() => [limited]),
      { userId: 'u1' },
    )!;
    expect(tool.description).not.toContain('create_ticket');
    const out = await run(tool, { action: 'call', server: 'orders', tool: 'create_ticket', confirm: true });
    expect(String(out.error)).toContain('has no callable tool "create_ticket"');
    expect(fixture.tickets).toEqual([]);
  });

  it('a server disabled after the turn started is not called', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => [{ ...row, enabled: false }]),
      { userId: 'u1' },
    )!;
    const out = await run(tool, {
      action: 'call',
      server: 'orders',
      tool: 'lookup_order',
      arguments: { order_id: '1' },
    });
    expect(String(out.error)).toContain('no longer available');
  });

  it('points at the real server ids when the model guesses one', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row]),
      { userId: 'u1' },
    )!;
    const out = await run(tool, { action: 'call', server: 'github', tool: 'x' });
    expect(out.error).toBe('No connected MCP server "github". Connected: "orders".');
  });
});

describe("mcp_call — a member's own key (per_user)", () => {
  beforeEach(() => directoryOf(row, keyedRow));

  it('marks the server [own account] and tells the model what needs_connection means', () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row, keyedRow]),
      { userId: 'u1' },
    )!;
    expect(tool.description).toContain('"maps" — Maps [own account]');
    expect(tool.description).toContain('needs_connection');
  });

  it('answers needs_connection — and never reaches the server — until the member adds a key', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row, keyedRow]),
      { userId: 'u1' },
    )!;
    const out = await run(tool, {
      action: 'call',
      server: 'maps',
      tool: 'create_ticket',
      arguments: { title: 'x' },
      confirm: true,
    });
    expect(out).toMatchObject({
      needs_connection: true,
      server: 'maps',
      server_id: 8,
      auth: 'per_user',
      reason: 'not_connected',
    });
    expect(keyed.tickets).toEqual([]);
  });

  it("calls with THIS member's key, put where the connector says (a query parameter)", async () => {
    const connections = { 'u1:8': { provider_credential: sealMemberCredential(8, 'u1', 'member-key-1') } };
    const tool = createMcpCallTool(
      fakeDb(() => [row, keyedRow], connections),
      { userId: 'u1' },
    )!;
    const out = await run(tool, { action: 'call', server: 'maps', tool: 'whoami' });
    expect(String(out.result)).toContain('You are the key holder');

    // u2 has no key of their own; u1's is not theirs to use.
    const other = createMcpCallTool(
      fakeDb(() => [row, keyedRow], connections),
      { userId: 'u2' },
    )!;
    expect((await run(other, { action: 'call', server: 'maps', tool: 'whoami' })).needs_connection).toBe(true);
  });

  it('a key sealed for another member does not decrypt for this one (AAD binding)', async () => {
    const stolen = { 'u2:8': { provider_credential: sealMemberCredential(8, 'u1', 'member-key-1') } };
    const tool = createMcpCallTool(
      fakeDb(() => [row, keyedRow], stolen),
      { userId: 'u2' },
    )!;
    const out = await run(tool, { action: 'call', server: 'maps', tool: 'whoami' });
    expect(out).toMatchObject({ needs_connection: true, reason: 'expired' });
  });

  it('a rejected key is reported as needs_connection (expired), with the key redacted', async () => {
    const connections = { 'u1:8': { provider_credential: sealMemberCredential(8, 'u1', 'wrong-key-zz') } };
    const tool = createMcpCallTool(
      fakeDb(() => [row, keyedRow], connections),
      { userId: 'u1' },
    )!;
    const out = await run(tool, { action: 'call', server: 'maps', tool: 'whoami' });
    expect(out).toMatchObject({ needs_connection: true, reason: 'expired' });
    expect(JSON.stringify(out)).not.toContain('wrong-key-zz');
  });

  it("list reports the member's own connection state per server", async () => {
    const connections = { 'u1:8': { provider_credential: 'sealed', access_token: null } };
    const tool = createMcpCallTool(
      fakeDb(() => [row, keyedRow], connections),
      { userId: 'u1' },
    )!;
    const out = (await run(tool, { action: 'list' })) as { servers: Array<Record<string, unknown>> };
    expect(out.servers.find((s) => s.server === 'maps')).toMatchObject({ own_account: true, connection: 'connected' });
    expect(out.servers.find((s) => s.server === 'orders')).not.toHaveProperty('connection');
  });
});

describe('mcp_call — a member-account server nobody has connected yet', () => {
  it('is listed with unknown tools, and any call to it answers with a Connect button', async () => {
    const fresh = serverRow({
      id: 9,
      slug: 'tracker',
      name: 'Tracker',
      auth_mode: 'oauth',
      url: 'http://127.0.0.1:9/mcp',
    });
    _setMcpDirectory([{ id: 9, slug: 'tracker', name: 'Tracker', description: null, auth_mode: 'oauth', tools: [] }]);
    const tool = createMcpCallTool(
      fakeDb(() => [fresh]),
      { userId: 'u1' },
    )!;
    expect(tool.description).toContain('"tracker" — Tracker [own account]');
    expect(tool.description).toContain('not known until the user connects their account');
    const out = await run(tool, { action: 'call', server: 'tracker', tool: 'list_issues' });
    expect(out).toMatchObject({ needs_connection: true, server: 'tracker', auth: 'oauth', reason: 'not_connected' });
  });
});

describe('mcp_call — Bots face (approval cards)', () => {
  it('has no confirm argument and its description promises a card, not a flag', () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row]),
      { userId: 'u1', approve: async () => 'approve' },
    )!;
    expect(tool.description).toContain('approval card');
    expect(tool.description).not.toContain('confirm:true');
    expect(JSON.stringify((tool.inputSchema as { jsonSchema?: unknown }).jsonSchema ?? tool.inputSchema)).not.toContain(
      'confirm',
    );
  });

  it('asks for a writer, with the exact arguments; runs only on approve', async () => {
    const asked: McpApprovalRequest[] = [];
    const approve = vi.fn(async (req: McpApprovalRequest): Promise<McpApprovalDecision> => {
      asked.push(req);
      return 'deny';
    });
    const tool = createMcpCallTool(
      fakeDb(() => [row]),
      { userId: 'u1', approve },
    )!;
    const denied = await run(tool, {
      action: 'call',
      server: 'orders',
      tool: 'create_ticket',
      arguments: { title: 'Printer on fire' },
      // A model-set flag is not consent on this face.
      confirm: true,
    });
    expect(denied.status).toBe('denied');
    expect(fixture.tickets).toEqual([]);
    expect(asked[0]).toMatchObject({
      server: 'orders',
      serverName: 'Order desk',
      tool: 'create_ticket',
      arguments: { title: 'Printer on fire' },
    });

    approve.mockResolvedValueOnce('approve');
    const done = await run(tool, {
      action: 'call',
      server: 'orders',
      tool: 'create_ticket',
      arguments: { title: 'Printer on fire' },
    });
    expect(String(done.result)).toContain('Created ticket T-1');
    expect(fixture.tickets).toEqual(['Printer on fire']);
  });

  it('an unanswered card is reported as expired; a read-only call asks nothing', async () => {
    const approve = vi.fn(async () => 'expired' as const);
    const tool = createMcpCallTool(
      fakeDb(() => [row]),
      { userId: 'u1', approve },
    )!;
    expect(
      (await run(tool, { action: 'call', server: 'orders', tool: 'create_ticket', arguments: { title: 'x' } })).status,
    ).toBe('expired');
    approve.mockClear();
    const read = await run(tool, {
      action: 'call',
      server: 'orders',
      tool: 'lookup_order',
      arguments: { order_id: '1' },
    });
    expect(read.is_error).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  it('settles the connection before asking — no card for a call that cannot run', async () => {
    directoryOf(row, keyedRow);
    const approve = vi.fn(async () => 'approve' as const);
    const tool = createMcpCallTool(
      fakeDb(() => [row, keyedRow]),
      { userId: 'u1', approve },
    )!;
    const out = await run(tool, { action: 'call', server: 'maps', tool: 'create_ticket', arguments: { title: 'x' } });
    expect(out.needs_connection).toBe(true);
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("mcp_call — a Bot's connector list", () => {
  beforeEach(() => directoryOf(row, keyedRow));

  it('sees only the listed connectors', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => [row, keyedRow]),
      { userId: 'u1', connectors: ['maps'] },
    )!;
    expect(tool.description).not.toContain('"orders"');
    const out = await run(tool, {
      action: 'call',
      server: 'orders',
      tool: 'lookup_order',
      arguments: { order_id: '1' },
    });
    expect(out.error).toBe('No connected MCP server "orders". Connected: "maps".');
  });

  it('an empty list means no tool at all', () => {
    expect(
      createMcpCallTool(
        fakeDb(() => [row, keyedRow]),
        { userId: 'u1', connectors: [] },
      ),
    ).toBeNull();
  });
});

describe('vouched read-only tools (read_only_tools)', () => {
  it('runs without confirmation — unless the server itself calls the tool destructive', async () => {
    const vouched = { ...row, read_only_tools: ['create_ticket'] };
    directoryOf(vouched);
    const tool = createMcpCallTool(
      fakeDb(() => [vouched]),
      { userId: 'u1' },
    )!;
    expect(tool.description).toContain('create_ticket [read-only]');
    const out = await run(tool, { action: 'call', server: 'orders', tool: 'create_ticket', arguments: { title: 'v' } });
    expect(String(out.result)).toContain('Created ticket');

    const destructive = {
      ...vouched,
      tools: vouched.tools.map((t) => (t.name === 'create_ticket' ? { ...t, destructive: true } : t)),
    };
    expect(callableTools(destructive).find((t) => t.name === 'create_ticket')!.read_only).toBe(false);
  });
});

describe('renderMcpCatalog', () => {
  it('stops at its character budget and says how many servers it left out', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      slug: `server-${i}`,
      name: `Server ${i}`,
      description: 'x'.repeat(100),
      auth_mode: 'none' as const,
      tools: row.tools,
    }));
    const text = renderMcpCatalog(many);
    expect(text.length).toBeLessThan(1700);
    expect(text).toMatch(/\(\d+ more servers — use action:"list"\)/);
  });
});
