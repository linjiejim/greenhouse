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

import { buildMcpServer, toMcpInputSchema, MCP_EXPOSED_TOOL_IDS } from '../mcp.js';
import { createEmailQueryTool, createEmailMutationTool } from '../../tools/email/index.js';
import type { ToolRegistry } from '../../agent.js';
import { resolveProxyToolIds } from '../../agent-runtime/tool-proxy.js';
import type { ProxyToolManifestEntry } from '../../agent-runtime/tool-proxy.js';

// Minimal Hono context stub; audit reads it and is a no-op here.
const fakeC = { get: () => undefined, req: { method: 'POST', header: () => undefined } } as unknown as Context;

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

describe('Email read/write split', () => {
  // Schema-level: validation never touches the db, so a stub is enough.
  const db = {} as never;
  type SchemaHolder = { inputSchema: { safeParse: (v: unknown) => { success: boolean } } };

  it('email_query accepts read actions and rejects write actions', () => {
    const schema = (createEmailQueryTool(db, { userId: 'u' }) as unknown as SchemaHolder).inputSchema;
    expect(schema.safeParse({ action: 'list_accounts' }).success).toBe(true);
    expect(schema.safeParse({ action: 'search_emails', account_id: 1, query: 'order' }).success).toBe(true);
    expect(schema.safeParse({ action: 'read_email', account_id: 1, message_id: 'm1' }).success).toBe(true);
    expect(schema.safeParse({ action: 'draft_email', account_id: 1, subject: 'X' }).success).toBe(false);
    expect(schema.safeParse({ action: 'send_email', draft_token: 'T' }).success).toBe(false);
  });

  it('email_mutation accepts write actions and rejects read actions', () => {
    const schema = (createEmailMutationTool(db, { userId: 'u' }) as unknown as SchemaHolder).inputSchema;
    expect(
      schema.safeParse({ action: 'draft_email', account_id: 1, to: [{ address: 'a@b.co' }], subject: 'Hi' }).success,
    ).toBe(true);
    expect(schema.safeParse({ action: 'send_email', draft_token: 'T', user_confirmed: true }).success).toBe(true);
    expect(schema.safeParse({ action: 'search_emails', account_id: 1 }).success).toBe(false);
    expect(schema.safeParse({ action: 'list_accounts' }).success).toBe(false);
  });

  it('is exposed over MCP and lands in the right proxy tiers', () => {
    expect(MCP_EXPOSED_TOOL_IDS.has('email_query')).toBe(true);
    expect(MCP_EXPOSED_TOOL_IDS.has('email_mutation')).toBe(true);

    const effective = ['email_query', 'email_mutation'];
    // Read side is reachable without any write scope; write side is default-deny.
    expect(resolveProxyToolIds(effective)).toEqual(['email_query']);
    // Write side appears only when the credential's write scope includes it.
    expect(resolveProxyToolIds(effective, { allowedWriteTools: ['email_mutation'] })).toEqual([
      'email_query',
      'email_mutation',
    ]);
  });

  it('tools/list marks email_mutation as confirm-required but not email_query', async () => {
    const registry = {
      email_query: createEmailQueryTool(db, { userId: 'u' }),
      email_mutation: createEmailMutationTool(db, { userId: 'u' }),
    } as unknown as ToolRegistry;
    const { client, server } = await connect({ toolIds: ['email_query', 'email_mutation'], registry });
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(['email_mutation', 'email_query']);
    const write = tools.find((t) => t.name === 'email_mutation')!;
    expect((write.inputSchema as { required?: string[] }).required).toContain('confirm');
    expect(write.description).toMatch(/requires confirm:true/);
    const read = tools.find((t) => t.name === 'email_query')!;
    expect((read.inputSchema as { properties?: Record<string, unknown> }).properties?.confirm).toBeUndefined();

    await client.close();
    await server.close();
  });

  it('blocks send_email via MCP without confirm:true', async () => {
    const registry = {
      email_mutation: createEmailMutationTool(db, { userId: 'u' }),
    } as unknown as ToolRegistry;
    const { client, server } = await connect({ toolIds: ['email_mutation'], registry });
    const res = await client.callTool({
      name: 'email_mutation',
      arguments: { action: 'send_email', draft_token: 'T', user_confirmed: true },
    });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/confirm/i);
    await client.close();
    await server.close();
  });
});
