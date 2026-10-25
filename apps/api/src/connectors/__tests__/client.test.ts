/**
 * The MCP client against a REAL MCP server (the SDK's own server over
 * Streamable HTTP on a local port) — discovery, calls, credentials, the result
 * flattening the model reads, and the NO_PROXY path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  callMcpTool,
  describeMcpError,
  discoverMcpTools,
  explainFailedConnect,
  flattenMcpResult,
  type McpConnectTarget,
} from '../client.js';
import { startMcpTestServer, type McpTestServer } from './fixture-server.js';

let open: McpTestServer;
let locked: McpTestServer;

const target = (url: string, authValue: string | null = null): McpConnectTarget => ({
  url,
  transport: 'streamable_http',
  headers: authValue ? { Authorization: authValue } : {},
  policy: { privateHost: null },
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
  it('lists the advertised tools with their schema and read-only / destructive hints', async () => {
    const tools = await discoverMcpTools(target(open.url));
    expect(tools.map((t) => t.name)).toEqual([
      'lookup_order',
      'create_ticket',
      'delete_ticket',
      'chart_png',
      'leaky',
      'whoami',
    ]);
    const lookup = tools.find((t) => t.name === 'lookup_order')!;
    expect(lookup).toMatchObject({ read_only: true, destructive: false });
    expect(lookup.input_schema).toMatchObject({ required: ['order_id'] });
    expect(tools.find((t) => t.name === 'create_ticket')).toMatchObject({ read_only: false, destructive: false });
    expect(tools.find((t) => t.name === 'delete_ticket')).toMatchObject({ read_only: false, destructive: true });
  });

  it('sends the credential, and names a rejected one plainly', async () => {
    expect((await discoverMcpTools(target(locked.url, 'Bearer sekret'))).length).toBe(6);
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

describe('explainFailedConnect', () => {
  it("names a vendor's own error body instead of the SDK's timeout", async () => {
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
      expect(await explainFailedConnect(target(open.url))).toBeNull();
    } finally {
      vendor.close();
    }
  });
});

describe('callMcpTool', () => {
  it('runs a tool and returns its text and size', async () => {
    const outcome = await callMcpTool(target(open.url), 'lookup_order', { order_id: 'A-1001' });
    expect(outcome).toEqual({ isError: false, text: 'Order A-1001: shipped on 2026-10-01', bytes: 35 });
  });

  it('never hands binary to the model — an image becomes a note, structured content stays', async () => {
    const outcome = await callMcpTool(target(open.url), 'chart_png', {});
    expect(outcome.text).toContain('[image result (image/png) — not shown]');
    expect(outcome.text).toContain('{"points":3}');
    expect(outcome.text).not.toContain('iVBORw0KGgo');
  });

  it('passes a server-side tool error through as isError', async () => {
    expect((await callMcpTool(target(open.url), 'nope', {})).isError).toBe(true);
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
  const KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;
  const setProxyEnv = (proxy: string, noProxy: string) => {
    for (const key of KEYS) process.env[key] = /no_proxy/i.test(key) ? noProxy : proxy;
  };

  it('honours NO_PROXY, so a server the proxy cannot reach still works', async () => {
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    try {
      // A proxy that is not there: anything routed through it fails.
      setProxyEnv('http://127.0.0.1:9', 'localhost,127.0.0.1');
      expect((await discoverMcpTools(target(open.url))).length).toBe(6);
      setProxyEnv('http://127.0.0.1:9', '');
      const err = await discoverMcpTools(target(open.url)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});
