/** Where a connector may point and what its fetch follows: the rules per environment, without the internet. */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertConnectorUrl,
  connectorFetch,
  connectorUrlProblem,
  isBrowserSafeUrl,
  MAX_RESPONSE_BYTES,
} from '../network.js';

describe('connector addresses', () => {
  it('in production: https to public addresses only', async () => {
    expect(connectorUrlProblem('https://8.8.8.8/mcp', 'production')).toBeNull();
    expect(connectorUrlProblem('https://mcp.example.com/mcp', 'production')).toBeNull();
    for (const raw of [
      'http://mcp.example.com/mcp',
      'http://localhost:3000/mcp',
      'https://localhost/mcp',
      'https://api.localhost/mcp',
      'https://printer.local/mcp',
      'https://metadata.google.internal/',
      'https://10.0.0.1/mcp',
      'https://172.16.4.2/mcp',
      'https://192.168.1.10/mcp',
      'https://169.254.169.254/latest',
      'https://127.0.0.1/mcp',
      'https://[::1]/mcp',
      'https://[fd00::1]/mcp',
      'https://[::ffff:10.0.0.1]/mcp',
      'javascript:alert(1)',
      'file:///etc/passwd',
    ]) {
      expect(connectorUrlProblem(raw, 'production'), raw).not.toBeNull();
    }
    await expect(assertConnectorUrl('https://10.1.2.3/mcp', 'production')).rejects.toThrow(/private network/);
    await expect(assertConnectorUrl('https://8.8.8.8/mcp', 'production')).resolves.toBeUndefined();
  });

  it('in development: plain http only to this machine; private networks are fine', () => {
    expect(connectorUrlProblem('http://localhost:3000/mcp', 'development')).toBeNull();
    expect(connectorUrlProblem('http://127.0.0.1:8080/mcp', 'development')).toBeNull();
    expect(connectorUrlProblem('http://[::1]:8080/mcp', 'development')).toBeNull();
    expect(connectorUrlProblem('https://10.0.0.5/mcp', 'development')).toBeNull();
    expect(connectorUrlProblem('http://10.0.0.5/mcp', 'development')).toMatch(/localhost/);
    expect(connectorUrlProblem('http://mcp.example.com/mcp', 'development')).toMatch(/https/);
  });

  it('in tests: https, private allowed, no plain http', () => {
    expect(connectorUrlProblem('http://localhost:3000/mcp', 'test')).toMatch(/https/);
    expect(connectorUrlProblem('https://10.0.0.5/mcp', 'test')).toBeNull();
  });

  it('never keeps credentials in the address', () => {
    expect(connectorUrlProblem('https://user:secret@mcp.example.com/mcp', 'development')).toMatch(/credentials/);
  });

  it('sends a browser only to a web address', () => {
    expect(isBrowserSafeUrl('https://auth.example.com/authorize?x=1', 'production')).toBe(true);
    expect(isBrowserSafeUrl('javascript:alert(document.cookie)', 'development')).toBe(false);
    expect(isBrowserSafeUrl('data:text/html,<script>1</script>', 'development')).toBe(false);
  });
});

describe('the connector fetch', () => {
  let server: Server;
  let other: Server;
  let origin = '';
  let otherOrigin = '';

  beforeAll(async () => {
    other = createServer((_, response) => response.end('other'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    server = createServer((request, response) => {
      switch (request.url) {
        case '/hop':
          response.writeHead(307, { location: '/mcp' }).end();
          return;
        case '/away':
          response.writeHead(302, { location: `${otherOrigin}/steal` }).end();
          return;
        case '/slow':
          return; // never answers
        case '/big': {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          const chunk = Buffer.alloc(1024 * 1024, 'a');
          let sent = 0;
          const write = () => {
            while (sent < MAX_RESPONSE_BYTES + 2 * chunk.length) {
              sent += chunk.length;
              if (!response.write(chunk)) return response.once('drain', write);
            }
            response.end();
          };
          write();
          return;
        }
        default:
          response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    other.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => other.close(resolve));
  });

  it('answers with the global Response class, so OAuth error bodies are read as such', async () => {
    const response = await connectorFetch(`${origin}/mcp`, 'development', 5_000)(`${origin}/mcp`);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('follows a redirect within the origin, never out of it, and nothing but https elsewhere', async () => {
    const fetchLike = connectorFetch(`${origin}/mcp`, 'development', 5_000);
    expect((await fetchLike(`${origin}/hop`, { method: 'POST', body: '{}' })).status).toBe(401);
    await expect(fetchLike(`${origin}/away`)).rejects.toThrow(/redirected/);
    await expect(fetchLike(`${otherOrigin}/steal`)).rejects.toThrow(/only https/);
  });

  it('refuses plain http and private addresses in production, at every hop', async () => {
    await expect(connectorFetch(`${origin}/mcp`, 'production', 5_000)(`${origin}/mcp`)).rejects.toThrow(/https/);
    await expect(
      connectorFetch('https://mcp.example.com/mcp', 'production', 5_000)('https://169.254.169.254/latest'),
    ).rejects.toThrow(/private network/);
  });

  it('gives up at the deadline and past the size limit', async () => {
    await expect(connectorFetch(`${origin}/mcp`, 'development', 200)(`${origin}/slow`)).rejects.toThrow();
    const big = await connectorFetch(`${origin}/mcp`, 'development', 10_000)(`${origin}/big`);
    await expect(big.arrayBuffer()).rejects.toThrow(/more than 8 MB/);
  });
});
