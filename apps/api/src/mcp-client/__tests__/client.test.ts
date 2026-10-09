/**
 * The MCP client against a REAL MCP server (the SDK's own server over
 * Streamable HTTP on a local port) — discovery, calls, credentials and the
 * result flattening the model reads.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  callMcpTool,
  describeMcpError,
  discoverMcpTools,
  explainFailedConnect,
  flattenMcpResult,
  guardedMcpFetch,
  type McpConnectTarget,
} from '../client.js';
import { startMcpTestServer, type McpTestServer } from './fixture-server.js';

let open: McpTestServer;
let locked: McpTestServer;

const target = (url: string, authValue: string | null = null): McpConnectTarget => ({
  url,
  transport: 'streamable_http',
  headers: authValue ? { Authorization: authValue } : {},
});

beforeAll(async () => {
  open = await startMcpTestServer();
  locked = await startMcpTestServer({ token: 'sekret' });
});

afterAll(async () => {
  await open.close();
  await locked.close();
});

describe('discoverMcpTools', () => {
  it('lists the advertised tools with their schema and read-only/destructive hints', async () => {
    const tools = await discoverMcpTools(target(open.url));
    expect(tools.map((t) => t.name)).toEqual(['lookup_order', 'create_ticket', 'chart_png', 'leaky', 'whoami']);
    const lookup = tools.find((t) => t.name === 'lookup_order')!;
    expect(lookup.read_only).toBe(true);
    expect(lookup.input_schema).toMatchObject({ required: ['order_id'] });
    // Not declared read-only → treated as a writer, whatever else it says.
    expect(tools.find((t) => t.name === 'create_ticket')!.read_only).toBe(false);
  });

  it('sends the stored credential, and names a rejected one plainly', async () => {
    expect((await discoverMcpTools(target(locked.url, 'Bearer sekret'))).length).toBe(5);

    const err = await discoverMcpTools(target(locked.url, 'Bearer wrong')).catch((e: unknown) => e);
    expect(describeMcpError(err)).toMatch(/rejected the credential/);
  });

  it("turns the SDK's schema-validation dump into one sentence", () => {
    const dump = new Error('[\n  {\n    "code": "invalid_union",\n    "errors": []\n  }\n]');
    expect(describeMcpError(dump)).toBe('the server answered with something that is not valid MCP (JSON-RPC)');
  });

  it('says the server is unreachable instead of hanging', async () => {
    const err = await discoverMcpTools(target('http://127.0.0.1:9/mcp')).catch((e: unknown) => e);
    expect(describeMcpError(err)).toMatch(/could not reach the server/);
  });
});

describe('guardedMcpFetch', () => {
  // OAuth discovery follows URLs the remote server's metadata names; a server
  // must not be able to aim the API at a plain-http address of its choosing.
  it('refuses plain http to another origin, allows the server itself and https anywhere', async () => {
    const fetchFn = guardedMcpFetch(open.url);
    await expect(fetchFn('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/only https or the MCP server/);
    await expect(fetchFn('http://10.0.0.5/admin')).rejects.toThrow(/only https or the MCP server/);
    const own = await fetchFn(open.url.replace('/mcp', '/nothing-here'));
    expect(own.status).toBe(404);
  });
});

describe('explainFailedConnect', () => {
  it("names a vendor's own error body instead of the SDK's timeout", async () => {
    // Amap answers a bad key with HTTP 200 and a non-JSON-RPC body.
    const vendor = createServer((_req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json;charset=UTF-8' })
        .end(JSON.stringify({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001', detail: 'x'.repeat(600) }));
    });
    await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/mcp?key=bad`;
    try {
      const explained = await explainFailedConnect(target(url));
      expect(explained).toMatch(
        /^the server answered with something that is not MCP: \{"status":"0","info":"INVALID_USER_KEY"/,
      );
      expect(explained!.length).toBeLessThan(300);
      // A real MCP server has nothing to add.
      expect(await explainFailedConnect(target(open.url))).toBeNull();
    } finally {
      vendor.close();
    }
  });
});

describe('callMcpTool', () => {
  it('runs a tool and returns its text', async () => {
    const outcome = await callMcpTool(target(open.url), 'lookup_order', { order_id: 'A-1001' });
    expect(outcome).toEqual({ isError: false, text: 'Order A-1001: shipped on 2026-10-01' });
  });

  it('never hands binary to the model — an image becomes a note, structured content stays', async () => {
    const outcome = await callMcpTool(target(open.url), 'chart_png', {});
    expect(outcome.text).toContain('[image result (image/png) — not shown]');
    expect(outcome.text).toContain('{"points":3}');
    expect(outcome.text).not.toContain('iVBORw0KGgo');
  });

  it('passes a server-side tool error through as is_error', async () => {
    const outcome = await callMcpTool(target(open.url), 'nope', {});
    expect(outcome.isError).toBe(true);
  });
});

describe('flattenMcpResult', () => {
  it('reads embedded text resources, links and the pre-2025 toolResult shape', () => {
    expect(
      flattenMcpResult({
        content: [
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'alpha' } },
          { type: 'resource_link', uri: 'file:///b.pdf', name: 'b' },
        ],
      }).text,
    ).toBe('alpha\n[resource: file:///b.pdf "b"]');
    expect(flattenMcpResult({ toolResult: { ok: 1 } }).text).toBe('{"ok":1}');
  });
});

describe('behind an HTTPS proxy', () => {
  it('honours NO_PROXY, so an internal server the proxy cannot reach still works', async () => {
    const saved = { https: process.env.HTTPS_PROXY, no: process.env.NO_PROXY };
    // A proxy that is not there: anything routed through it fails.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    try {
      vi.resetModules();
      const fresh = await import('../client.js');
      const tools = await fresh.discoverMcpTools(target(open.url));
      expect(tools.length).toBe(5);
    } finally {
      if (saved.https === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved.https;
      if (saved.no === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = saved.no;
      vi.resetModules();
    }
  });
});
