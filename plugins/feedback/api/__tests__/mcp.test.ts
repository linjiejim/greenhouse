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
// plugins/knowledge/tests/tests/api/agent-write-governance.db.test.ts); here the route's own job is
// asserted: strip confirm and pass it on, and shape each outcome for the agent.
const governance = vi.hoisted(() => ({ govern: vi.fn() }));
vi.mock('../../../../apps/api/src/agent-access/context.js', () => ({
  baseWriteRisk: () => 'r2',
  resolveWriteCaller: async (
    _db: unknown,
    input: {
      userId: string;
      clientId: string;
      authMethod: string;
    },
  ) => ({
    ...input,
    clientName: 'Codex',
  }),
}));
vi.mock('../../../../apps/api/src/agent-access/governed-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/api/src/agent-access/governed-write.js')>();
  return { ...actual, governProxyWrite: governance.govern };
});
// Oversized replies go to the object store; an in-memory map keeps this test off disk.
const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('../../../../apps/api/src/storage/uploads.js', () => ({
  toolOutputKeyPrefix: () => 'drive/mcp-output/',
  putObjectAtKey: async (key: string, buffer: Buffer) => void objects.set(key, buffer),
  getObjectAtKey: async (key: string) =>
    objects.has(key) ? { buffer: objects.get(key)!, contentType: 'application/json' } : null,
  deleteObjectAtKey: async (key: string) => void objects.delete(key),
  listObjectKeys: async () => [...objects.keys()],
}));

import { buildMcpServer } from '../../../../apps/api/src/routes/mcp.js';
import type { ToolRegistry } from '../../../../apps/api/src/agent.js';
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
function _makeCtx() {
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
async function connect(ctx: ReturnType<typeof _makeCtx>, c: Context = fakeC) {
  const server = buildMcpServer(c, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('MCP server — Issues & requests tools', () => {
  it('lists feedback_query read-only and the two filing tools as writes without a delete preview', async () => {
    const { createFeedbackQueryTool } = await import('../tools/feedback-query.js');
    const { createFeatureRequestTool } = await import('../tools/feature-request.js');
    const { createLogFrictionTool } = await import('../tools/log-friction.js');
    const db = {} as never;
    const ctx = {
      toolIds: ['feedback_query', 'feature_request', 'log_friction'],
      registry: {
        feedback_query: createFeedbackQueryTool(db, { userId: 'mcp-test-user', userRole: 'team' }),
        feature_request: createFeatureRequestTool(db, { userId: 'mcp-test-user', userRole: 'team' }),
        log_friction: createLogFrictionTool(db, {}),
      } as unknown as ToolRegistry,
    };
    const { client, server } = await connect(ctx);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'feedback_query')!.annotations).toMatchObject({ readOnlyHint: true });
    // Neither only adds: a repeated friction replaces its detail and reopens a
    // resolved entry; a super can update a request through feature_request.
    expect(tools.find((t) => t.name === 'log_friction')!.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.find((t) => t.name === 'feature_request')!.annotations).toMatchObject({ destructiveHint: true });
    for (const name of ['feature_request', 'log_friction']) {
      const write = tools.find((t) => t.name === name)!;
      expect(write.annotations).toMatchObject({ readOnlyHint: false });
      expect(write.description).toMatch(/recorded in their name/);
      expect(
        (
          write.inputSchema as {
            properties: Record<string, unknown>;
          }
        ).properties.confirm,
      ).toBeUndefined();
    }
    await client.close();
    await server.close();
  });
});
