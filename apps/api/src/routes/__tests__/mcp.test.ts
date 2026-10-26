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

// Writes are recorded in agent-access (covered end to end by
// tests/api/agent-write-governance.db.test.ts); here the route's own job is
// asserted: strip confirm and pass it on, and shape each outcome for the agent.
const governance = vi.hoisted(() => ({ govern: vi.fn() }));
vi.mock('../../agent-access/context.js', () => ({
  baseWriteRisk: () => 'r2',
  resolveWriteCaller: async (_db: unknown, input: { userId: string; clientId: string; authMethod: string }) => ({
    ...input,
    clientName: 'Codex',
  }),
}));
vi.mock('../../agent-access/governed-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-access/governed-write.js')>();
  return { ...actual, governProxyWrite: governance.govern };
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
    status: 'executed',
    tool_id: 'knowledge_mutation',
    action: 'document.update',
    risk: 'r2',
    client_id: 'c1',
    client_name: 'Codex',
    basis: 'direct',
    target_label: null,
    input: {},
    output: null,
    error: null,
    created_at: '2026-10-23T00:00:00.000Z',
    settled_at: '2026-10-23T00:00:01.000Z',
    ...over,
  };
}

import { buildMcpServer, mcpToolAnnotations, toMcpInputSchema } from '../mcp.js';
import { UsageBudgetAdmissionError, budgetExceededMessage } from '../../usage/budget-errors.js';
import { currentMeteringScope } from '../../usage/metering.js';
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
            allowedTools: ['knowledge_query', 'knowledge_mutation'],
            allowedWriteTools: ['knowledge_mutation'],
          }
        : key === 'oauthClientId'
          ? clientId
          : undefined,
    req: { method: 'POST', header: () => undefined },
  } as unknown as Context;
}
const fakeC = contextFor('client-a');

// Fake registry keyed by REAL tool ids (so getToolMeta resolves their meta), with
// stub execute/inputSchema. knowledge_query = read, knowledge_mutation = write.
function makeCtx() {
  const registry = {
    knowledge_query: {
      inputSchema: z.object({ q: z.string().optional(), rows: z.number().optional() }),
      execute: async (input: { q?: string; rows?: number }) => ({
        ok: true,
        echo: input,
        ...(input.rows
          ? { rows: Array.from({ length: input.rows }, (_, i) => ({ id: i, note: 'n'.repeat(50) })) }
          : {}),
      }),
    },
    knowledge_mutation: {
      inputSchema: z.object({ name: z.string() }),
      execute: async (input: unknown) => ({ created: input }),
    },
  } as unknown as ToolRegistry;
  return { toolIds: ['knowledge_query', 'knowledge_mutation'], registry };
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
  it('lists the tools in the request context with annotations, and a write note on writes', async () => {
    const { client, server } = await connect(makeCtx());
    const { tools } = await client.listTools();

    // team_context and data_catalog are protocol tools every grant lists (content cut to the grant).
    expect(tools.map((t) => t.name).sort()).toEqual([
      'data_catalog',
      'knowledge_mutation',
      'knowledge_query',
      'team_context',
      'tool_output_read',
    ]);
    expect(tools.find((t) => t.name === 'team_context')!.annotations).toMatchObject({ readOnlyHint: true });

    const write = tools.find((t) => t.name === 'knowledge_mutation')!;
    // No action enum to prove it only adds things: destructive, so clients ask.
    expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(write.description).toMatch(/recorded in their name/);
    // This write cannot delete, so it has no confirm flag at all.
    expect((write.inputSchema as { properties: Record<string, unknown> }).properties.confirm).toBeUndefined();

    const read = tools.find((t) => t.name === 'knowledge_query')!;
    expect(read.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'tool_output_read')!.annotations).toMatchObject({ readOnlyHint: true });

    await client.close();
    await server.close();
  });
});

describe('MCP server — Files tools', () => {
  it('lists files_query read-only and files_mutation as a deleting write with a confirm flag', async () => {
    const { createFilesQueryTool } = await import('../../tools/files-query.js');
    const { createFilesMutationTool } = await import('../../tools/files-mutation.js');
    const db = {} as never;
    const ctx = {
      toolIds: ['files_query', 'files_mutation'],
      registry: {
        files_query: createFilesQueryTool(db, { userId: 'mcp-test-user' }),
        files_mutation: createFilesMutationTool(db, { userId: 'mcp-test-user' }),
      } as unknown as ToolRegistry,
    };
    const { client, server } = await connect(ctx);
    const { tools } = await client.listTools();

    const read = tools.find((t) => t.name === 'files_query')!;
    expect(read.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect((read.inputSchema as { properties: Record<string, unknown> }).properties.confirm).toBeUndefined();

    const write = tools.find((t) => t.name === 'files_mutation')!;
    expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(write.description).toMatch(/recorded in their name/);
    // files.delete / folders.delete are delete-like, so the preview round trip applies.
    expect((write.inputSchema as { properties: Record<string, { type?: string }> }).properties.confirm.type).toBe(
      'boolean',
    );

    await client.close();
    await server.close();
  });
});

describe('MCP server — tools/call', () => {
  it('runs a read tool and returns its output as JSON text', async () => {
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'knowledge_query', arguments: { q: 'hi' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(firstText(res))).toMatchObject({ ok: true, echo: { q: 'hi' } });
    await client.close();
    await server.close();
  });

  it('runs a write at once, strips confirm and passes it on, and says where it is recorded', async () => {
    governance.govern.mockResolvedValue({ status: 'executed', view: view({ output: { created: { name: 'X' } } }) });
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'knowledge_mutation', arguments: { name: 'X' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(firstText(res))).toEqual({ created: { name: 'X' } });
    expect((res.content as Array<{ text: string }>).at(-1)!.text).toBe('Recorded in Greenhouse as write rtr_1.');
    expect(governance.govern.mock.calls.at(-1)![0]).toMatchObject({ input: { name: 'X' }, confirmed: false });

    await client.callTool({ name: 'knowledge_mutation', arguments: { name: 'X', confirm: true } });
    expect(governance.govern.mock.calls.at(-1)![0]).toMatchObject({ input: { name: 'X' }, confirmed: true });
    governance.govern.mockReset();
    await client.close();
    await server.close();
  });

  it('answers a delete without confirm with its preview, not an error', async () => {
    governance.govern.mockResolvedValueOnce({
      status: 'needs_confirmation',
      preview: {
        status: 'needs_confirmation',
        tool: 'knowledge_mutation',
        action: 'records.delete',
        risk: 'r3',
        target: null,
        input: { record_id: 'r1' },
        message: 'Nothing has been deleted yet.',
      },
    });
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'knowledge_mutation', arguments: { name: 'X' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(firstText(res))).toMatchObject({ status: 'needs_confirmation', risk: 'r3' });
    await client.close();
    await server.close();
  });

  it('reports a failed write as a tool error, and an unknown outcome as a status to check', async () => {
    governance.govern.mockResolvedValueOnce({
      status: 'failed',
      view: view({ status: 'failed', error: 'revision conflict' }),
    });
    const { client, server } = await connect(makeCtx());
    const failed = await client.callTool({ name: 'knowledge_mutation', arguments: { name: 'X' } });
    expect(failed.isError).toBe(true);
    expect(firstText(failed)).toBe('revision conflict');

    governance.govern.mockResolvedValueOnce({
      status: 'outcome_unknown',
      view: view({ status: 'outcome_unknown', error: 'The write ran but its result could not be recorded' }),
    });
    const unknown = await client.callTool({ name: 'knowledge_mutation', arguments: { name: 'X' } });
    expect(unknown.isError).toBeFalsy();
    expect(JSON.parse(firstText(unknown))).toMatchObject({ status: 'outcome_unknown', write_id: 'rtr_1' });
    await client.close();
    await server.close();
  });

  it('returns an over-budget refusal as a tool error in its own words', async () => {
    const ctx = makeCtx();
    const refusal = { unit: 'usd_micros' as const, level: 'member' as const };
    (ctx.registry as Record<string, any>).knowledge_query.execute = async () => {
      // Wrapped the way the AI SDK / a tool would wrap it.
      throw new Error('tool failed', {
        cause: new UsageBudgetAdmissionError(
          budgetExceededMessage(refusal),
          429,
          'usage_budget_exceeded',
          undefined,
          refusal,
        ),
      });
    };
    const { client, server } = await connect(ctx);
    const res = await client.callTool({ name: 'knowledge_query', arguments: {} });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toBe(budgetExceededMessage(refusal));
    expect(firstText(res)).toContain('联系管理员');
    await client.close();
    await server.close();
  });

  it('runs every tool call as the member, client mcp and the agent’s OAuth client', async () => {
    const ctx = makeCtx();
    (ctx.registry as Record<string, any>).knowledge_query.execute = async () => ({ scope: currentMeteringScope() });
    const { client, server } = await connect(ctx, contextFor('client-codex'));
    const res = await client.callTool({ name: 'knowledge_query', arguments: {} });
    expect(JSON.parse(firstText(res))).toEqual({
      scope: { userId: 'mcp-test-user', client: 'mcp', oauthClientId: 'client-codex' },
    });
    await client.close();
    await server.close();
  });

  it('rejects a tool not in the request context (not widened)', async () => {
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'tables_query', arguments: {} });
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
    const res = await client.callTool({ name: 'knowledge_query', arguments: { rows: 600 } });
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

  it('bounds an executed write and keeps the record line last', async () => {
    objects.clear();
    const big = { rows: Array.from({ length: 600 }, (_, i) => ({ id: i, note: 'n'.repeat(50) })) };
    governance.govern.mockResolvedValueOnce({ status: 'executed', view: view({ output: big }) });
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'knowledge_mutation', arguments: { name: 'X' } });
    const blocks = res.content as Array<{ text: string }>;
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ truncated: true });
    expect(blocks.at(-1)!.text).toBe('Recorded in Greenhouse as write rtr_1.');
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

  it('adds an optional confirm flag only to writes that can delete', () => {
    const plain = base({
      mutating: true,
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    });
    expect((toMcpInputSchema(plain).properties as Record<string, unknown>).confirm).toBeUndefined();

    const deleting = base({
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['records.update', 'records.delete'] } },
        required: ['action'],
      },
    });
    const schema = toMcpInputSchema(deleting);
    expect((schema.properties as Record<string, { type?: string }>).confirm.type).toBe('boolean');
    expect(schema.required).toEqual(['action']);
    expect(mcpToolAnnotations(deleting)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(mcpToolAnnotations(plain)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const additive = base({
      mutating: true,
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['comment.add'] } } },
    });
    expect(mcpToolAnnotations(additive)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(mcpToolAnnotations(base({}))).toEqual({ readOnlyHint: true, openWorldHint: false });
  });
});
