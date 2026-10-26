/**
 * An extension's write tool is governed exactly like a core one when a member's
 * own agent calls it over `/api/mcp`: it runs as the member, is recorded as an
 * `agent_write` run, and a delete-like action previews first and only runs with
 * `confirm: true`. Drives the real route (OAuth token → identity → MCP server)
 * with the example extension switched on.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Before any import: the extension list is computed when its module loads.
vi.hoisted(() => {
  process.env.GREENHOUSE_EXTENSIONS = 'example';
});

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import { createMcpRoutes } from '../../../../apps/api/src/routes/mcp.js';
import { extensionMigrationSources } from '../../../../apps/api/src/extensions/boot.js';
import { EXTENSIONS } from '../../../../apps/api/src/extensions/index.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../../../apps/api/src/platform/runtime.js';
import { projectsRegistration } from '../../../projects/api/platform/application.js';
import { knowledgeRegistration } from '../../../../apps/api/src/platform/knowledge/registration.js';
import { tablesRegistration } from '../../../../apps/api/src/platform/tables/application.js';
import {
  generateAccessToken,
  getMcpResourceUrl,
  hashOAuthCredential,
} from '../../../../apps/api/src/platform/oauth.js';

const TOOL = 'example_notes_mutation';

// The modules have read it already; do not leak the switch to whatever runs next in this worker.
afterAll(() => {
  delete process.env.GREENHOUSE_EXTENSIONS;
});

let db: DatabaseProvider;
let member: UserRow;
let token: string;
let app: Hono;
let rpcId = 0;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function rpc(method: string, params: Record<string, unknown>) {
  const res = await app.request('/api/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
  if (body.error) throw new Error(`MCP error: ${JSON.stringify(body.error)}`);
  return body.result!;
}

async function call(args: Record<string, unknown>) {
  const result = (await rpc('tools/call', { name: TOOL, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { ...result, text: result.content.map((part) => part.text).join('\n') };
}

async function writeRuns() {
  return (await db.runtime.listRuns({ owner_user_id: member.id, kinds: ['agent_write'], limit: 50 })).items;
}

describe('extension write tools over /api/mcp', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [projectsRegistration, knowledgeRegistration, tablesRegistration]);
    // The example's own tables, inside this test's transaction.
    await db.extensionMigrations.apply(extensionMigrationSources());

    member = await createInternalTestUser(db, { email: `${unique('ext-write')}@test.local` });
    await db.userFeatures.upsert({ user_id: member.id, feature: 'example', enabled: true });

    const client = await db.platformOAuth.registerClient({
      id: unique('client'),
      client_name: 'Codex',
      redirect_uris: [],
      created_by: member.id,
    });
    const scopes = ['mcp:read', 'mcp:write', 'mcp:example'];
    const grant = await db.platformOAuth.upsertGrant({
      user_id: member.id,
      client_id: client.id,
      resource: getMcpResourceUrl(),
      scopes,
    });
    token = generateAccessToken();
    const issued = await db.platformOAuth.createAccessToken(grant.id, {
      token_hash: hashOAuthCredential(token),
      token_type: 'access',
      resource: getMcpResourceUrl(),
      scopes,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(issued).toBeDefined();

    app = new Hono();
    app.route('/api/mcp', createMcpRoutes({}));
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('is active and listed as a destructive write with the confirm flag', async () => {
    expect(EXTENSIONS.map((ext) => ext.id)).toEqual(['example']);
    const { tools } = (await rpc('tools/list', {})) as {
      tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> }; annotations?: unknown }>;
    };
    const listed = tools.find((t) => t.name === TOOL);
    expect(listed?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(listed?.inputSchema.properties).toHaveProperty('confirm');
  });

  it('records an add as an agent_write run, in the member’s name', async () => {
    const added = await call({ action: 'notes.add', body: 'written by an agent' });
    expect(added.isError).toBeFalsy();
    expect(added.text).toMatch(/Recorded in Greenhouse as write/);

    const runs = await writeRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', owner_user_id: member.id });
    expect(runs[0]!.input).toMatchObject({ tool_id: TOOL, action: 'notes.add', risk: 'r2' });
  });

  it('previews a delete, runs nothing, and deletes only with confirm:true', async () => {
    const added = await call({ action: 'notes.add', body: 'to be deleted' });
    const id = Number(/"id":(\d+)/.exec(added.text)?.[1]);
    expect(Number.isInteger(id)).toBe(true);

    const preview = await call({ action: 'notes.delete', id });
    expect(JSON.parse(preview.text)).toMatchObject({
      status: 'needs_confirmation',
      tool: TOOL,
      action: 'notes.delete',
      risk: 'r3',
    });
    expect(await writeRuns()).toHaveLength(1); // only the add
    const kept = await db.executeRaw(sql`SELECT count(*)::int AS n FROM ext_example_notes WHERE id = ${id}`);
    expect((kept as Array<{ n: number }>)[0]!.n).toBe(1);

    const confirmed = await call({ action: 'notes.delete', id, confirm: true });
    expect(confirmed.isError).toBeFalsy();
    const runs = await writeRuns();
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => (run.input as { action?: string }).action === 'notes.delete')?.input).toMatchObject({
      risk: 'r3',
    });
    const gone = await db.executeRaw(sql`SELECT count(*)::int AS n FROM ext_example_notes WHERE id = ${id}`);
    expect((gone as Array<{ n: number }>)[0]!.n).toBe(0);
  });
});
