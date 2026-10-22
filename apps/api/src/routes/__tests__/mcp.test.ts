/**
 * MCP server protocol tests.
 *
 * Drives buildMcpServer over an in-memory transport with a real MCP Client, so
 * tools/list + tools/call exercise the actual protocol wiring — no HTTP, no DB.
 * Audit is best-effort and DB-bound, so getDb is stubbed to a no-op.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Context } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return { ...actual, getDb: () => ({ apiAudit: { record: async () => {} } }) };
});

// Writes are governed in agent-access (covered end to end by
// tests/api/agent-write-governance.db.test.ts); here the route's own job is
// asserted: strip confirm, honour it only while the switch is on, and shape
// the three outcomes for the agent.
const governance = vi.hoisted(() => ({
  legacy: true,
  govern: vi.fn(),
  status: vi.fn(),
  withdraw: vi.fn(),
}));
vi.mock('../../agent-access/context.js', () => ({
  legacyConfirmEnabled: async () => governance.legacy,
  baseWriteRisk: () => 'r2',
  resolveWriteCaller: async (_db: unknown, input: { userId: string; clientId: string; authMethod: string }) => ({
    ...input,
    clientName: 'Codex',
    approverUserId: input.userId,
  }),
}));
vi.mock('../../agent-access/governed-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-access/governed-write.js')>();
  return {
    ...actual,
    governProxyWrite: governance.govern,
    agentWriteStatus: governance.status,
    withdrawAgentWrite: governance.withdraw,
  };
});

// Oversized replies go to the object store; an in-memory map keeps this test off disk.
const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('../../storage/uploads.js', () => ({
  toolOutputKeyPrefix: () => 'drive/mcp-output/',
  putObjectAtKey: async (key: string, buffer: Buffer) => void objects.set(key, buffer),
  getObjectAtKey: async (key: string) =>
    objects.has(key) ? { buffer: objects.get(key)!, contentType: 'application/json' } : null,
  deleteObjectAtKey: async (key: string) => void objects.delete(key),
  listObjectKeys: async () => [...objects.keys()],
}));

function view(over: Record<string, unknown> = {}) {
  return {
    request_id: 'rtr_1',
    status: 'pending',
    tool_id: 'project_mutation',
    action: 'project.update',
    risk: 'r2',
    client_id: 'c1',
    client_name: 'Codex',
    basis: null,
    input: {},
    output: null,
    error: null,
    created_at: '2026-10-23T00:00:00.000Z',
    settled_at: null,
    expires_at: '2026-10-24T00:00:00.000Z',
    interrupt_id: 'rti_1',
    decided_by_user_id: null,
    ...over,
  };
}

import { buildMcpServer, toMcpInputSchema } from '../mcp.js';
import type { ToolRegistry } from '../../agent.js';
import type { ProxyToolManifestEntry } from '../../agent-runtime/tool-proxy.js';

// Minimal Hono context stub. The production server receives this identity from
// MCP auth middleware before the protocol adapter is constructed.
function contextFor(clientId: string) {
  return {
    get: (key: string) =>
      key === 'agentIdentity'
        ? {
            userId: 'mcp-test-user',
            userRole: 'team',
            allowedTools: ['project_query', 'project_mutation'],
            allowedWriteTools: ['project_mutation'],
          }
        : key === 'oauthClientId'
          ? clientId
          : undefined,
    req: { method: 'POST', header: () => undefined },
  } as unknown as Context;
}
const fakeC = contextFor('client-a');

// Fake registry keyed by REAL tool ids (so getToolMeta resolves their meta), with
// stub execute/inputSchema. project_query = read, project_mutation = write.
function makeCtx() {
  const registry = {
    project_query: {
      inputSchema: z.object({ q: z.string().optional(), rows: z.number().optional() }),
      execute: async (input: { q?: string; rows?: number }) => ({
        ok: true,
        echo: input,
        ...(input.rows
          ? { rows: Array.from({ length: input.rows }, (_, i) => ({ id: i, note: 'n'.repeat(50) })) }
          : {}),
      }),
    },
    project_mutation: {
      inputSchema: z.object({ name: z.string() }),
      execute: async (input: unknown) => ({ created: input }),
    },
  } as unknown as ToolRegistry;
  return { toolIds: ['project_query', 'project_mutation'], registry };
}

async function connect(ctx: ReturnType<typeof makeCtx>, c: Context = fakeC) {
  const server = buildMcpServer(c, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

function firstText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content;
  return content?.[0]?.text ?? '';
}

describe('MCP server — tools/list', () => {
  it('lists only the tools in the request context, plus agent_write_status when writes are reachable', async () => {
    governance.legacy = true;
    const { client, server } = await connect(makeCtx());
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'agent_write_status',
      'project_mutation',
      'project_query',
      'tool_output_read',
    ]);

    const write = tools.find((t) => t.name === 'project_mutation')!;
    // While the transition switch is on, confirm is an optional legacy flag — never required.
    expect((write.inputSchema as { properties: Record<string, unknown> }).properties.confirm).toBeDefined();
    expect((write.inputSchema as { required?: string[] }).required ?? []).not.toContain('confirm');
    expect(write.description).toMatch(/approval/);

    const read = tools.find((t) => t.name === 'project_query')!;
    expect((read.inputSchema as { properties?: Record<string, unknown> }).properties?.confirm).toBeUndefined();

    await client.close();
    await server.close();
  });
});

describe('MCP server — tools/call', () => {
  it('runs a read tool and returns its output as JSON text', async () => {
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'project_query', arguments: { q: 'hi' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(firstText(res))).toMatchObject({ ok: true, echo: { q: 'hi' } });
    await client.close();
    await server.close();
  });

  it('answers a write that needs approval with needs_approval, not an error', async () => {
    governance.govern.mockResolvedValueOnce({ status: 'needs_approval', reused: false, view: view() });
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'project_mutation', arguments: { name: 'X' } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(firstText(res));
    expect(body).toMatchObject({ status: 'needs_approval', request_id: 'rtr_1', risk: 'r2' });
    expect(body.message).toMatch(/agent_write_status/);
    expect(governance.govern.mock.calls.at(-1)![0]).toMatchObject({ toolId: 'project_mutation', legacyConfirm: false });
    await client.close();
    await server.close();
  });

  it('strips confirm before governance and honours it only while the switch is on', async () => {
    governance.govern.mockResolvedValue({
      status: 'executed',
      view: view({ status: 'executed', basis: 'legacy_confirm', output: { created: { name: 'X' } } }),
    });
    governance.legacy = true;
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'project_mutation', arguments: { name: 'X', confirm: true } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(firstText(res))).toEqual({ created: { name: 'X' } });
    expect(governance.govern.mock.calls.at(-1)![0]).toMatchObject({ input: { name: 'X' }, legacyConfirm: true });

    governance.legacy = false;
    await client.callTool({ name: 'project_mutation', arguments: { name: 'X', confirm: true } });
    expect(governance.govern.mock.calls.at(-1)![0]).toMatchObject({ input: { name: 'X' }, legacyConfirm: false });
    governance.govern.mockReset();
    await client.close();
    await server.close();
  });

  it('reports a failed write as a tool error', async () => {
    governance.govern.mockResolvedValueOnce({
      status: 'failed',
      view: view({ status: 'failed', error: 'revision conflict' }),
    });
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'project_mutation', arguments: { name: 'X' } });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toBe('revision conflict');
    await client.close();
    await server.close();
  });

  it('agent_write_status returns the executed output', async () => {
    governance.status.mockResolvedValueOnce(view({ status: 'executed', basis: 'approved', output: { ok: 1 } }));
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({
      name: 'agent_write_status',
      arguments: { request_id: 'rtr_1', wait_seconds: 5 },
    });
    expect(JSON.parse(firstText(res))).toMatchObject({ status: 'executed', output: { ok: 1 } });
    expect(governance.status.mock.calls.at(-1)!.slice(1)).toEqual(['rtr_1', expect.anything(), 5]);
    await client.close();
    await server.close();
  });

  it('rejects a tool not in the request context (not widened)', async () => {
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'knowledge_query', arguments: {} });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/not available/i);
    await client.close();
    await server.close();
  });
});

describe('MCP server — bounded replies', () => {
  it('stores an oversized read result, previews it, and pages the rest for the same client only', async () => {
    objects.clear();
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'project_query', arguments: { rows: 600 } });
    expect(res.isError).toBeFalsy();
    const blocks = res.content as Array<{ text: string }>;
    const handle = JSON.parse(blocks[0]!.text);
    expect(handle).toMatchObject({ truncated: true });
    expect(handle.total_chars).toBeGreaterThan(12_000);
    expect(blocks[1]!.text.length).toBe(handle.next_offset);

    let text = blocks[1]!.text;
    let offset: number | null = handle.next_offset;
    while (offset !== null) {
      const page = await client.callTool({
        name: 'tool_output_read',
        arguments: { output_id: handle.output_id, offset },
      });
      const [position, chunk] = page.content as Array<{ text: string }>;
      const meta = JSON.parse(position!.text);
      expect(meta.returned_chars).toBeLessThanOrEqual(12_000);
      text += chunk!.text;
      offset = meta.next_offset;
    }
    expect(text.length).toBe(handle.total_chars);
    expect(JSON.parse(text).rows).toHaveLength(600);
    await client.close();
    await server.close();

    // Another OAuth client of the same member cannot read it.
    const other = await connect(makeCtx(), contextFor('client-b'));
    const denied = await other.client.callTool({
      name: 'tool_output_read',
      arguments: { output_id: handle.output_id },
    });
    expect(denied.isError).toBe(true);
    expect(firstText(denied)).toMatch(/not found or expired/);
    await other.client.close();
    await other.server.close();
  });

  it('bounds an executed governed write and keeps the request line last', async () => {
    objects.clear();
    const big = { rows: Array.from({ length: 600 }, (_, i) => ({ id: i, note: 'n'.repeat(50) })) };
    governance.govern.mockResolvedValueOnce({
      status: 'executed',
      view: view({ status: 'executed', basis: 'standing_grant', output: big }),
    });
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'project_mutation', arguments: { name: 'X' } });
    const blocks = res.content as Array<{ text: string }>;
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ truncated: true });
    expect(blocks.at(-1)!.text).toMatch(/Recorded as Greenhouse request rtr_1/);
    expect(objects.size).toBe(1);
    await client.close();
    await server.close();
  });
});

describe('toMcpInputSchema', () => {
  const base = (over: Partial<ProxyToolManifestEntry>): ProxyToolManifestEntry => ({
    id: 'x',
    name: 'x',
    description: 'd',
    category: 'c',
    mutating: false,
    ...over,
  });

  it('passes through an object schema for read tools', () => {
    const s = toMcpInputSchema(base({ inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }));
    expect(s.type).toBe('object');
    expect((s.properties as Record<string, unknown>).a).toEqual({ type: 'string' });
    expect((s.properties as Record<string, unknown>).confirm).toBeUndefined();
  });

  it('falls back to an object schema when none is derivable', () => {
    expect(toMcpInputSchema(base({ inputSchema: undefined }))).toMatchObject({ type: 'object' });
  });

  it('adds an optional legacy confirm flag to writes only while the switch is on', () => {
    const entry = base({
      mutating: true,
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    });
    const legacy = toMcpInputSchema(entry, { legacyConfirm: true });
    expect((legacy.properties as Record<string, { type?: string }>).confirm.type).toBe('boolean');
    expect(legacy.required).toEqual(['name']);
    const strict = toMcpInputSchema(entry, { legacyConfirm: false });
    expect((strict.properties as Record<string, unknown>).confirm).toBeUndefined();
  });
});
