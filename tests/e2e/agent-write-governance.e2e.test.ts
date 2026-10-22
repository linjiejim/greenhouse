/**
 * E2E — governed MCP writes over real HTTP.
 *
 * A machine client with write scope calls /api/mcp. A shared-data write comes
 * back as needs_approval (a normal tool result), the client's creator decides
 * through /api/agent-access, the write runs exactly once, and the agent reads
 * the outcome with agent_write_status. The transition switch keeps confirm:true
 * working for r2 writes.
 *
 * Use `pnpm test:e2e:ci`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createSuperToken } from './helpers.js';

const UNIQUE = Date.now().toString(36);
const ADMIN = `${BASE_URL}/api/admin/platform/oauth`;
let superToken: string;
let superUserId: string;
let accessToken: string;
let clientId = '';
let rpcId = 0;

function h(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function mcp(method: string, params: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: { ...h(accessToken), Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean; tools?: Array<Record<string, any>> };
    error?: unknown;
  };
}

async function callTool(name: string, args: Record<string, unknown>) {
  const body = await mcp('tools/call', { name, arguments: args });
  return body.result!;
}

function json(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

beforeAll(async () => {
  const health = await fetch(`${BASE_URL}/health`);
  if (!health.ok) throw new Error(`Server not running at ${BASE_URL}`);
  superToken = createSuperToken();
  superUserId = process.env.E2E_SUPER_USER_ID!;

  // Bound to the super itself so the knowledge write is permitted; the
  // creator (also the super) is the approver for a machine client.
  const created = await fetch(`${ADMIN}/machine-clients`, {
    method: 'POST',
    headers: h(superToken),
    body: JSON.stringify({
      client_name: `e2e-agent-write-${UNIQUE}`,
      bound_user_id: superUserId,
      scopes: ['mcp:read', 'mcp:write', 'mcp:knowledge'],
    }),
  });
  expect(created.status).toBe(201);
  const client = (await created.json()) as { client_id: string; client_secret: string };
  clientId = client.client_id;

  const token = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret,
      scope: 'mcp:read mcp:write mcp:knowledge',
    }),
  });
  expect(token.status).toBe(200);
  accessToken = ((await token.json()) as { access_token: string }).access_token;
});

afterAll(async () => {
  if (clientId)
    await fetch(`${ADMIN}/clients/${clientId}`, { method: 'DELETE', headers: h(superToken) }).catch(() => {});
});

describe('E2E: governed MCP writes', () => {
  it('lists agent_write_status and keeps confirm optional while the transition switch is on', async () => {
    const tools = (await mcp('tools/list', {})).result!.tools!;
    expect(tools.map((tool) => tool.name)).toContain('agent_write_status');
    const write = tools.find((tool) => tool.name === 'knowledge_mutation')!;
    expect(write.inputSchema.properties.confirm).toBeDefined();
    expect(write.inputSchema.required ?? []).not.toContain('confirm');
  });

  it('holds a shared write for approval, runs it once when approved, and lets the agent read the result', async () => {
    const title = `E2E governed ${UNIQUE}`;
    const held = await callTool('knowledge_mutation', {
      action: 'knowledge.create_doc',
      scope: 'team',
      title,
      content: 'Written by a governed agent.',
    });
    expect(held.isError).toBeFalsy();
    const pending = json(held);
    expect(pending).toMatchObject({ status: 'needs_approval', risk: 'r2' });
    expect(pending.approve_url).toContain('#/settings/agent-connections/requests/');

    // The same write again while it waits is the same request.
    const repeated = json(
      await callTool('knowledge_mutation', {
        action: 'knowledge.create_doc',
        scope: 'team',
        title,
        content: 'Written by a governed agent.',
      }),
    );
    expect(repeated.request_id).toBe(pending.request_id);

    const list = await fetch(`${BASE_URL}/api/agent-access/requests?view=pending`, { headers: h(superToken) });
    const rows = ((await list.json()) as { requests: Array<{ request_id: string; interrupt_id: string }> }).requests;
    const row = rows.find((candidate) => candidate.request_id === pending.request_id)!;
    expect(row).toBeDefined();

    const decided = await fetch(`${BASE_URL}/api/agent-access/requests/${row.interrupt_id}/decision`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as { request: { status: string } }).request.status).toBe('executed');

    // A second decision loses.
    const again = await fetch(`${BASE_URL}/api/agent-access/requests/${row.interrupt_id}/decision`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(again.status).toBe(409);

    const status = json(await callTool('agent_write_status', { request_id: pending.request_id }));
    expect(status.status).toBe('executed');
    expect(JSON.stringify(status.output)).toContain('created');

    const search = json(await callTool('knowledge_query', { action: 'search', scope: 'team', query: title }));
    expect(JSON.stringify(search)).toContain(title);
  });

  it('still honours confirm:true for a shared write during the transition, recorded as legacy', async () => {
    const result = await callTool('knowledge_mutation', {
      action: 'knowledge.create_doc',
      scope: 'team',
      title: `E2E legacy ${UNIQUE}`,
      content: 'Legacy confirm path.',
      confirm: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content.at(-1)!.text).toMatch(/legacy_confirm/);
  });

  it('runs a personal doc create at once and refuses a status read for an unknown request', async () => {
    const personal = await callTool('knowledge_mutation', {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: `E2E personal ${UNIQUE}`,
      content: 'Mine.',
    });
    expect(personal.isError).toBeFalsy();
    expect(personal.content.at(-1)!.text).toMatch(/own_reversible/);

    const unknown = await callTool('agent_write_status', { request_id: 'rtr_does_not_exist' });
    expect(unknown.isError).toBe(true);
  });

  it('rejects a standing grant for a delete', async () => {
    const res = await fetch(`${BASE_URL}/api/agent-access/grants`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ tool_id: 'tables_mutation', action: 'records.delete', days: 7 }),
    });
    expect(res.status).toBe(400);
  });
});
