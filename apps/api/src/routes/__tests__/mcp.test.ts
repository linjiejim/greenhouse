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

import { buildMcpServer, toMcpInputSchema } from '../mcp.js';
import type { ToolRegistry } from '../../agent.js';
import type { ProxyToolManifestEntry } from '../../agent-runtime/tool-proxy.js';

// Minimal Hono context stub. The production server receives this identity from
// MCP auth middleware before the protocol adapter is constructed.
const fakeC = {
  get: (key: string) =>
    key === 'agentIdentity'
      ? {
          userId: 'mcp-test-user',
          userRole: 'team',
          allowedTools: ['project_query', 'project_mutation'],
          allowedWriteTools: ['project_mutation'],
        }
      : undefined,
  req: { method: 'POST', header: () => undefined },
} as unknown as Context;

// Fake registry keyed by REAL tool ids (so getToolMeta resolves their meta), with
// stub execute/inputSchema. project_query = read, project_mutation = write.
function makeCtx() {
  const registry = {
    project_query: {
      inputSchema: z.object({ q: z.string().optional() }),
      execute: async (input: unknown) => ({ ok: true, echo: input }),
    },
    project_mutation: {
      inputSchema: z.object({ name: z.string() }),
      execute: async (input: unknown) => ({ created: input }),
    },
  } as unknown as ToolRegistry;
  return { toolIds: ['project_query', 'project_mutation'], registry };
}

async function connect(ctx: ReturnType<typeof makeCtx>) {
  const server = buildMcpServer(fakeC, ctx);
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
  it('lists only the tools in the request context, with confirm on writes', async () => {
    const { client, server } = await connect(makeCtx());
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(['project_mutation', 'project_query']);

    const write = tools.find((t) => t.name === 'project_mutation')!;
    expect((write.inputSchema as { properties: Record<string, unknown> }).properties.confirm).toBeDefined();
    expect((write.inputSchema as { required?: string[] }).required).toContain('confirm');

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

  it('blocks a write without confirm:true', async () => {
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'project_mutation', arguments: { name: 'X' } });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/confirm/i);
    await client.close();
    await server.close();
  });

  it('runs a write with confirm:true and strips confirm before execution', async () => {
    const { client, server } = await connect(makeCtx());
    const res = await client.callTool({ name: 'project_mutation', arguments: { name: 'X', confirm: true } });
    expect(res.isError).toBeFalsy();
    // confirm must not leak into the tool input.
    expect(JSON.parse(firstText(res))).toEqual({ created: { name: 'X' } });
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

  it('injects a required confirm flag for mutating tools', () => {
    const s = toMcpInputSchema(
      base({
        mutating: true,
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      }),
    );
    expect((s.properties as Record<string, { type?: string }>).confirm.type).toBe('boolean');
    expect(s.required).toEqual(expect.arrayContaining(['name', 'confirm']));
  });
});
