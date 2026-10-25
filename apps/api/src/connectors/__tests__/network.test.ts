/**
 * Where a connector may point: private addresses refused unless a super marked
 * a team connector as internal (and then only its own host), plain http only
 * to the connector's own origin, redirects never leave their origin, loopback
 * only in development / test, NO_PROXY matching.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { asGlobalResponse, bypassesProxy, connectorFetch, connectorUrlProblem, policyFor } from '../network.js';

let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/hop') res.writeHead(302, { location: '/landed' }).end();
    else if (req.url === '/away') res.writeHead(302, { location: 'https://elsewhere.example.com/x' }).end();
    else if (req.url === '/empty') res.writeHead(204).end();
    else res.writeHead(200, { 'content-type': 'text/plain' }).end(`at ${req.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const savedEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = savedEnv;
});

describe('connectorUrlProblem', () => {
  it('refuses private and metadata addresses for an ordinary connector', () => {
    for (const url of [
      'http://10.0.0.5/mcp',
      'https://192.168.1.2/mcp',
      'http://169.254.169.254/x',
      'https://[fd00::1]/mcp',
      'https://db.internal/mcp',
    ]) {
      expect(connectorUrlProblem(url, { privateNetwork: false })).toMatch(/private network/);
    }
    expect(connectorUrlProblem('https://mcp.example.com/mcp', { privateNetwork: false })).toBeNull();
  });

  it('accepts a private address only for a connector marked internal', () => {
    expect(connectorUrlProblem('http://10.0.0.5/mcp', { privateNetwork: true })).toBeNull();
  });

  it('refuses credentials in the address and non-http schemes', () => {
    expect(connectorUrlProblem('https://u:p@mcp.example.com/mcp', { privateNetwork: true })).toMatch(/credentials/);
    expect(connectorUrlProblem('ftp://mcp.example.com', { privateNetwork: false })).toMatch(/https/);
  });

  it('allows loopback only in development and test', () => {
    expect(connectorUrlProblem('http://127.0.0.1:4000/mcp', { privateNetwork: false })).toBeNull();
    process.env.NODE_ENV = 'production';
    expect(connectorUrlProblem('http://127.0.0.1:4000/mcp', { privateNetwork: false })).toMatch(/private network/);
    expect(connectorUrlProblem('http://localhost:4000/mcp', { privateNetwork: false })).toMatch(/private network/);
  });
});

describe('policyFor', () => {
  it('exempts only the configured host, and only for a team connector marked internal', () => {
    expect(policyFor({ scope: 'team', private_network: true, url: 'http://10.0.0.5:8080/mcp' })).toEqual({
      privateHost: '10.0.0.5',
    });
    expect(policyFor({ scope: 'team', private_network: false, url: 'http://10.0.0.5/mcp' })).toEqual({
      privateHost: null,
    });
    expect(policyFor({ scope: 'personal', private_network: true, url: 'http://10.0.0.5/mcp' })).toEqual({
      privateHost: null,
    });
  });
});

describe('connectorFetch', () => {
  it('follows a same-origin redirect and refuses one to another origin', async () => {
    const fetchFn = connectorFetch(`${origin}/mcp`, { privateHost: null }, 5_000);
    const res = await fetchFn(`${origin}/hop`);
    expect(await res.text()).toBe('at /landed');
    await expect(fetchFn(`${origin}/away`)).rejects.toThrow(/redirected to https:\/\/elsewhere/);
  });

  it('refuses plain http to another origin and private https targets from server metadata', async () => {
    const fetchFn = connectorFetch(`${origin}/mcp`, { privateHost: null }, 5_000);
    await expect(fetchFn('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/only https/);
    await expect(fetchFn('https://10.0.0.5/token')).rejects.toThrow(/private network/);
  });

  it('a private_network exemption covers only its own host', async () => {
    const fetchFn = connectorFetch('http://10.0.0.5/mcp', { privateHost: '10.0.0.5' }, 5_000);
    await expect(fetchFn('https://10.0.0.6/token')).rejects.toThrow(/private network/);
  });

  it('refuses loopback in production even for the connector itself', async () => {
    process.env.NODE_ENV = 'production';
    const fetchFn = connectorFetch(`${origin}/mcp`, { privateHost: null }, 5_000);
    await expect(fetchFn(`${origin}/mcp`)).rejects.toThrow(/private network/);
  });

  it('answers with the global Response, null body for 204', async () => {
    const fetchFn = connectorFetch(`${origin}/mcp`, { privateHost: null }, 5_000);
    const res = await fetchFn(`${origin}/empty`);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(204);
    expect(asGlobalResponse({ status: 304, statusText: '', headers: [], body: 'x' }).body).toBeNull();
  });
});

describe('bypassesProxy', () => {
  it('matches exact hosts, domain suffixes, ports and *', () => {
    const url = new URL('https://api.corp.example.com:8443/mcp');
    expect(bypassesProxy(url, 'corp.example.com')).toBe(true);
    expect(bypassesProxy(url, '.example.com')).toBe(true);
    expect(bypassesProxy(url, 'corp.example.com:443')).toBe(false);
    expect(bypassesProxy(url, 'corp.example.com:8443')).toBe(true);
    expect(bypassesProxy(url, 'other.com')).toBe(false);
    expect(bypassesProxy(url, '*')).toBe(true);
    expect(bypassesProxy(url, '')).toBe(false);
  });
});
