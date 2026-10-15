/** The MCP client against a real (local) MCP server: both transports, keys, results and errors. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, describeError, flattenResult, isAuthFailure, listTools, type Target } from '../mcp.js';
import { connectorFetch } from '../network.js';
import { startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server.js';

const targetOf = (url: string, overrides: Partial<Target> = {}): Target => ({
  url,
  transport: 'streamable_http',
  headers: {},
  fetch: connectorFetch(url, 'development', 10_000),
  ...overrides,
});

describe('the MCP client', () => {
  let open: FakeMcpServer;
  let keyed: FakeMcpServer;

  beforeAll(async () => {
    open = await startFakeMcpServer();
    keyed = await startFakeMcpServer({ apiKey: { value: 'k-123456', query: 'key' } });
  });
  afterAll(async () => {
    await open.close();
    await keyed.close();
  });

  it('lists tools with their annotations and calls one, over Streamable HTTP and SSE', async () => {
    const tools = await listTools(targetOf(open.url));
    expect(tools.map((tool) => tool.name)).toContain('lookup_order');
    expect(tools.find((tool) => tool.name === 'lookup_order')).toMatchObject({ readOnly: true, destructive: false });
    expect(tools.find((tool) => tool.name === 'drop_table')).toMatchObject({ readOnly: false, destructive: true });
    expect(tools.find((tool) => tool.name === 'create_ticket')?.inputSchema).toMatchObject({ required: ['title'] });
    // A name that tries to write instructions is never listed.
    expect(tools.some((tool) => tool.name.includes(' '))).toBe(false);
    expect(tools).toHaveLength(8);

    expect(await callTool(targetOf(open.url), 'lookup_order', { order_id: 'A-1' })).toEqual({
      isError: false,
      text: 'Order A-1: shipped on 2026-10-01',
    });

    const sse = targetOf(open.sseUrl, { transport: 'sse' });
    expect((await listTools(sse)).length).toBe(tools.length);
    expect((await callTool(sse, 'create_ticket', { title: 'Printer' })).text).toBe('Created ticket T-1: Printer');
    expect(open.tickets).toEqual(['Printer']);
  });

  it('sends a key where it is placed, and a refused key reads as an auth failure', async () => {
    const withKey = targetOf(`${keyed.url}?key=k-123456`);
    expect((await callTool(withKey, 'whoami', {})).text).toBe('You are the key holder');
    const failure = await listTools(targetOf(`${keyed.url}?key=wrong`)).catch((error: unknown) => error);
    expect(isAuthFailure(failure)).toBe(true);
    expect(describeError(failure)).toMatch(/refused the credential/);
  });

  it('flattens results into text and names what it cannot show', () => {
    expect(
      flattenResult({
        content: [
          { type: 'text', text: 'Chart:' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource_link', uri: 'https://example.com/a', name: 'A' },
          { type: 'resource', resource: { uri: 'x://y', mimeType: 'application/pdf', blob: 'AAAA' } },
        ],
        structuredContent: { points: 3 },
        isError: true,
      }),
    ).toEqual({
      isError: true,
      data: { points: 3 },
      text: 'Chart:\n[image (image/png), not shown]\n[resource: https://example.com/a "A"]\n[resource: x://y (application/pdf), not shown]\n{"points":3}',
    });
    expect(flattenResult({ toolResult: { ok: 1 } }).text).toBe('{"ok":1}');
  });

  it('says plainly when a server cannot be reached', async () => {
    const closed = await startFakeMcpServer();
    await closed.close();
    const failure = await listTools(targetOf(closed.url)).catch((error: unknown) => error);
    expect(describeError(failure)).toMatch(/Could not reach the server/);
  });
});
