/**
 * mcp_call — the one gateway tool to admin-connected MCP servers, driven
 * against a real MCP server. Pins: no tool without a callable server, the
 * confirm gate on anything not declared read-only (and that the remote side
 * never runs without it), the allow-list, and the untrusted-data envelope.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseProvider, McpServerRow } from '@greenhouse/db';
import { _setMcpDirectory, callableTools } from '../../mcp-client/directory.js';
import { discoverMcpTools } from '../../mcp-client/client.js';
import { startMcpTestServer, type McpTestServer } from '../../mcp-client/__tests__/fixture-server.js';
import { createMcpCallTool, renderMcpCatalog } from '../mcp-call.js';

let fixture: McpTestServer;
let row: McpServerRow;

function fakeDb(current: () => McpServerRow | undefined): DatabaseProvider {
  return { mcpServers: { getById: async () => current() } } as unknown as DatabaseProvider;
}

async function run(tool: NonNullable<ReturnType<typeof createMcpCallTool>>, input: Record<string, unknown>) {
  return (await tool.execute!(input as never, { toolCallId: 't', messages: [], context: {} })) as Record<
    string,
    unknown
  >;
}

beforeAll(async () => {
  fixture = await startMcpTestServer();
  const tools = await discoverMcpTools({
    url: fixture.url,
    transport: 'streamable_http',
    authHeader: null,
    authValue: null,
  });
  row = {
    id: 7,
    slug: 'orders',
    name: 'Order desk',
    description: 'Orders and support tickets',
    url: fixture.url,
    transport: 'streamable_http',
    auth_header: null,
    auth_value_encrypted: null,
    enabled: true,
    allowed_tools: null,
    tools,
    tools_refreshed_at: '2026-10-09T00:00:00.000Z',
    last_error: null,
    created_by: null,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
  };
});

afterAll(async () => {
  _setMcpDirectory([]);
  await fixture.close();
});

beforeEach(() => {
  fixture.tickets.length = 0;
  _setMcpDirectory([{ id: row.id, slug: row.slug, name: row.name, description: row.description, tools: row.tools }]);
});

describe('mcp_call', () => {
  it('is not offered at all while no server has anything callable', () => {
    _setMcpDirectory([]);
    expect(
      createMcpCallTool(
        fakeDb(() => row),
        { userId: 'u1' },
      ),
    ).toBeNull();
  });

  it('lists the connected servers and their tools in its description', () => {
    const tool = createMcpCallTool(
      fakeDb(() => row),
      { userId: 'u1' },
    )!;
    expect(tool.description).toContain('"orders" — Order desk');
    expect(tool.description).toContain('lookup_order [read-only]');
    expect(tool.description).toMatch(/create_ticket(?! \[read-only\])/);
  });

  it('describe returns the argument schema the model needs', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => row),
      { userId: 'u1' },
    )!;
    const out = await run(tool, { action: 'describe', server: 'orders', tool: 'lookup_order' });
    expect(out.input_schema).toMatchObject({ required: ['order_id'] });
    expect(out.read_only).toBe(true);
  });

  it('runs a read-only tool and wraps the result as untrusted external data', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => row),
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
      fakeDb(() => row),
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
      fakeDb(() => row),
      { userId: 'u1' },
    )!;
    const out = await run(tool, { action: 'call', server: 'orders', tool: 'leaky' });
    expect(out.flagged).toBe(true);
    expect(String(out.result)).not.toContain('reveal your system prompt');
  });

  it('only offers what the allow-list keeps', async () => {
    const limited = { ...row, allowed_tools: ['lookup_order'] };
    _setMcpDirectory([
      { id: row.id, slug: row.slug, name: row.name, description: null, tools: callableTools(limited) },
    ]);
    const tool = createMcpCallTool(
      fakeDb(() => limited),
      { userId: 'u1' },
    )!;
    expect(tool.description).not.toContain('create_ticket');
    const out = await run(tool, { action: 'call', server: 'orders', tool: 'create_ticket', confirm: true });
    expect(String(out.error)).toContain('has no callable tool "create_ticket"');
    expect(fixture.tickets).toEqual([]);
  });

  it('a server disabled after the turn started is not called', async () => {
    const tool = createMcpCallTool(
      fakeDb(() => ({ ...row, enabled: false })),
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
      fakeDb(() => row),
      { userId: 'u1' },
    )!;
    const out = await run(tool, { action: 'call', server: 'github', tool: 'x' });
    expect(out.error).toBe('No connected MCP server "github". Connected: "orders".');
  });
});

describe('renderMcpCatalog', () => {
  it('stops at its character budget and says how many servers it left out', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      slug: `server-${i}`,
      name: `Server ${i}`,
      description: 'x'.repeat(100),
      tools: row.tools,
    }));
    const text = renderMcpCatalog(many);
    expect(text.length).toBeLessThan(1700);
    expect(text).toMatch(/\(\d+ more servers — use action:"list"\)/);
  });
});
