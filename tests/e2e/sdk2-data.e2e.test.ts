import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, authHeaders, createSuperToken } from './helpers.js';
const suffix = crypto.randomUUID();
let token: string, machineToken: string, clientId: string, recordId: string;
const endpoint = `${BASE_URL}/api/ext/example/entities/note`;
let seq = 0;
async function mcp(method: string, params: unknown) {
  const response = await fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: { ...authHeaders(machineToken), Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  });
  expect(response.status).toBe(200);
  return response.json();
}
beforeAll(async () => {
  token = createSuperToken();
  const response = await fetch(`${BASE_URL}/api/admin/platform/oauth/machine-clients`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      client_name: `sdk2-${suffix}`,
      bound_user_id: process.env.E2E_SUPER_USER_ID,
      scopes: ['mcp:read', 'mcp:write', 'mcp:example'],
    }),
  });
  expect(response.status).toBe(201);
  const client = await response.json();
  clientId = client.client_id;
  const exchanged = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: client.client_secret,
      scope: 'mcp:read mcp:write mcp:example',
    }),
  });
  expect(exchanged.status).toBe(200);
  machineToken = (await exchanged.json()).access_token;
});
afterAll(async () => {
  if (recordId) await fetch(`${endpoint}/${recordId}`, { method: 'DELETE', headers: authHeaders(token) });
  if (clientId)
    await fetch(`${BASE_URL}/api/admin/platform/oauth/clients/${clientId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
});
describe('SDK 2 example over HTTP and MCP', () => {
  it('serves v2 plus v1 manifest fields and the static plugin page', async () => {
    const manifest = await (await fetch(`${BASE_URL}/api/extensions`, { headers: authHeaders(token) })).json();
    expect(manifest.manifest_version).toBe(2);
    expect(manifest.plugins.find((p: any) => p.id === 'example').entities[0].endpoint).toBe(
      '/api/ext/example/entities/note',
    );
    expect(manifest.extensions.some((p: any) => p.id === 'example')).toBe(true);
    expect(manifest.entityKinds.some((p: any) => p.kind === 'ext:example:note')).toBe(true);
    expect((await (await fetch(`${BASE_URL}/api/bootstrap`)).json()).mobile_api).toBe(4);
    const ui = await fetch(`${BASE_URL}/ext/example/ui/`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  });
  it('uses generated REST and MCP tools and previews deletion before confirmation', async () => {
    const created = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ body: `SDK2 ${suffix}` }),
    });
    expect(created.status).toBe(201);
    const note = await created.json();
    recordId = String(note.id);
    const page = await fetch(`${endpoint}/list`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        filter: [{ key: 'body', method: 'eq', value: [`SDK2 ${suffix}`] }],
        sort: [{ key: 'id', order: 'desc' }],
        limit: 1,
      }),
    });
    expect(await page.json()).toMatchObject({ total: 1, items: [{ body: `SDK2 ${suffix}` }] });
    const query = await mcp('tools/call', {
      name: 'example_query',
      arguments: { entity: 'note', action: 'get', id: recordId },
    });
    expect(query.result.isError).toBeFalsy();
    expect(JSON.stringify(query.result)).toContain(suffix);
    const mutation = { name: 'example_mutation', arguments: { entity: 'note', action: 'delete', id: recordId } };
    const preview = await mcp('tools/call', mutation);
    expect(preview.result.isError).toBeFalsy();
    expect(JSON.stringify(preview.result)).toContain('confirm');
    expect((await fetch(`${endpoint}/${recordId}`, { headers: authHeaders(token) })).status).toBe(200);
    const deleted = await mcp('tools/call', { ...mutation, arguments: { ...mutation.arguments, confirm: true } });
    expect(deleted.result.isError).toBeFalsy();
    expect((await fetch(`${endpoint}/${recordId}`, { headers: authHeaders(token) })).status).toBe(404);
    recordId = '';
  });
});
