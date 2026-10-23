/**
 * E2E — recorded MCP writes over real HTTP.
 *
 * A machine client with write scope calls /api/mcp. A permitted write runs at
 * once and shows up under /api/agent-access/writes; a delete first comes back
 * as a preview (a normal tool result) and runs only when sent again with
 * confirm:true. Tools carry the MCP annotations clients use to ask their user.
 * A read too long for one reply comes back bounded (preview + output_id) and
 * only the producing client can page it with tool_output_read.
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
let otherClientId = '';
let otherAccessToken = '';
let rpcId = 0;

function h(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function mcp(method: string, params: Record<string, unknown>, token = accessToken) {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: { ...h(token), Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean; tools?: Array<Record<string, any>> };
    error?: unknown;
  };
}

async function callTool(name: string, args: Record<string, unknown>, token = accessToken) {
  const body = await mcp('tools/call', { name, arguments: args }, token);
  return body.result!;
}

/** A machine client bound to the e2e super, with its own client_credentials token. */
async function machineClient(label: string) {
  const created = await fetch(`${ADMIN}/machine-clients`, {
    method: 'POST',
    headers: h(superToken),
    body: JSON.stringify({
      client_name: `e2e-${label}-${UNIQUE}`,
      bound_user_id: superUserId,
      scopes: ['mcp:read', 'mcp:write', 'mcp:knowledge', 'mcp:tables'],
    }),
  });
  expect(created.status).toBe(201);
  const client = (await created.json()) as { client_id: string; client_secret: string };
  const token = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret,
      scope: 'mcp:read mcp:write mcp:knowledge mcp:tables',
    }),
  });
  expect(token.status).toBe(200);
  return { clientId: client.client_id, accessToken: ((await token.json()) as { access_token: string }).access_token };
}

function json(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

beforeAll(async () => {
  const health = await fetch(`${BASE_URL}/health`);
  if (!health.ok) throw new Error(`Server not running at ${BASE_URL}`);
  superToken = createSuperToken();
  superUserId = process.env.E2E_SUPER_USER_ID!;

  // Bound to the super itself so the knowledge write is permitted.
  ({ clientId, accessToken } = await machineClient('agent-write'));
  // Same member, second client: must not read the first client's stored outputs.
  ({ clientId: otherClientId, accessToken: otherAccessToken } = await machineClient('agent-write-other'));
});

afterAll(async () => {
  for (const id of [clientId, otherClientId].filter(Boolean)) {
    await fetch(`${ADMIN}/clients/${id}`, { method: 'DELETE', headers: h(superToken) }).catch(() => {});
  }
});

describe('E2E: recorded MCP writes', () => {
  it('annotates tools for the client and offers confirm only where a tool can delete', async () => {
    const tools = (await mcp('tools/list', {})).result!.tools!;
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('agent_write_status');
    const read = tools.find((tool) => tool.name === 'knowledge_query')!;
    expect(read.annotations).toMatchObject({ readOnlyHint: true });
    const knowledgeWrite = tools.find((tool) => tool.name === 'knowledge_mutation')!;
    expect(knowledgeWrite.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(knowledgeWrite.inputSchema.properties.confirm).toBeUndefined();
    expect(knowledgeWrite.description).toMatch(/recorded in their name/);
    const tablesWrite = tools.find((tool) => tool.name === 'tables_mutation')!;
    expect(tablesWrite.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tablesWrite.inputSchema.properties.confirm).toBeDefined();
    expect(tablesWrite.inputSchema.required ?? []).not.toContain('confirm');
  });

  it('runs a permitted shared-data write at once and records it for the member', async () => {
    const title = `E2E direct ${UNIQUE}`;
    const result = await callTool('knowledge_mutation', {
      action: 'knowledge.create_doc',
      scope: 'team',
      title,
      content: 'Written by an agent as its member.',
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(json(result))).toContain('created');
    const line = result.content.at(-1)!.text;
    expect(line).toMatch(/^Recorded in Greenhouse as write rtr_/);
    const writeId = line.match(/(rtr_\w+)/)![1];

    const search = json(await callTool('knowledge_query', { action: 'search', scope: 'team', query: title }));
    expect(JSON.stringify(search)).toContain(title);

    const activity = await fetch(`${BASE_URL}/api/agent-access/writes`, { headers: h(superToken) });
    expect(activity.status).toBe(200);
    const writes = ((await activity.json()) as { writes: Array<Record<string, unknown>> }).writes;
    expect(writes.find((row) => row.request_id === writeId)).toMatchObject({
      status: 'executed',
      risk: 'r2',
      basis: 'direct',
      action: 'knowledge.create_doc',
    });
  });

  it('answers a delete with a preview and records nothing until the agent confirms', async () => {
    const before = await fetch(`${BASE_URL}/api/agent-access/writes`, { headers: h(superToken) });
    const count = ((await before.json()) as { writes: unknown[] }).writes.length;

    const preview = await callTool('tables_mutation', {
      action: 'records.delete',
      table_id: 999_999,
      record_id: 1,
      revision: 1,
    });
    expect(preview.isError).toBeFalsy();
    expect(json(preview)).toMatchObject({
      status: 'needs_confirmation',
      action: 'records.delete',
      risk: 'r3',
      input: { table_id: 999_999, record_id: 1 },
    });

    const after = await fetch(`${BASE_URL}/api/agent-access/writes`, { headers: h(superToken) });
    expect(((await after.json()) as { writes: unknown[] }).writes).toHaveLength(count);

    // Confirmed, it runs (and the tool itself refuses the unknown table) — recorded either way.
    const confirmed = await callTool('tables_mutation', {
      action: 'records.delete',
      table_id: 999_999,
      record_id: 1,
      revision: 1,
      confirm: true,
    });
    expect(confirmed.isError).toBe(true);
    const later = await fetch(`${BASE_URL}/api/agent-access/writes`, { headers: h(superToken) });
    const rows = ((await later.json()) as { writes: Array<Record<string, unknown>> }).writes;
    expect(rows).toHaveLength(count + 1);
    expect(rows[0]).toMatchObject({ status: 'failed', risk: 'r3', basis: 'confirmed' });
  });

  it('records a personal doc create as r1', async () => {
    const personal = await callTool('knowledge_mutation', {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: `E2E personal ${UNIQUE}`,
      content: 'Mine.',
    });
    expect(personal.isError).toBeFalsy();
    expect(personal.content.at(-1)!.text).toMatch(/^Recorded in Greenhouse as write rtr_/);
  });

  it('bounds a long read reply and pages the rest with tool_output_read, for the producing client only', async () => {
    const tools = (await mcp('tools/list', {})).result!.tools!;
    expect(tools.map((tool) => tool.name)).toContain('tool_output_read');

    // A personal doc runs at once (r1); ~30k characters of body makes `get` too long for one reply.
    const paragraph = (i: number) =>
      `## Section ${i}\n\n${'Bounded replies keep agent context small. '.repeat(12)}\n\n`;
    const content = Array.from({ length: 60 }, (_, i) => paragraph(i)).join('');
    const created = json(
      await callTool('knowledge_mutation', {
        action: 'knowledge.create_doc',
        scope: 'personal',
        title: `E2E long ${UNIQUE}`,
        content,
      }),
    );
    const docId = String(created.document.id);

    const reply = await callTool('knowledge_query', { action: 'get', scope: 'personal', doc_id: docId });
    expect(reply.isError).toBeFalsy();
    const handle = json(reply);
    expect(handle).toMatchObject({ truncated: true });
    expect(handle.output_id).toMatch(/^out_/);
    expect(handle.total_chars).toBeGreaterThan(12_000);
    const preview = reply.content[1]!.text;
    expect(preview.length).toBe(handle.next_offset);
    expect(reply.content.reduce((sum, block) => sum + block.text.length, 0)).toBeLessThan(12_000);

    let full = preview;
    let offset: number | null = handle.next_offset;
    while (offset !== null) {
      const page = await callTool('tool_output_read', { output_id: handle.output_id, offset, limit: 12_000 });
      expect(page.isError).toBeFalsy();
      const position = json(page);
      expect(position.returned_chars).toBeLessThanOrEqual(12_000);
      full += page.content[1]!.text;
      offset = position.next_offset;
    }
    expect(full.length).toBe(handle.total_chars);
    expect(JSON.parse(full).content).toContain('## Section 59');

    const foreign = await callTool('tool_output_read', { output_id: handle.output_id }, otherAccessToken);
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]!.text).toMatch(/not found or expired/);
  });
});
