/**
 * Port previews (preview.ts): the ticket (signed, bound to member and port,
 * expiring, never another kind of ticket), the ports a preview may open, and
 * the proxy itself against a real HTTP service reached through a fake host —
 * what reaches the service (never the member's credentials) and what comes
 * back (sandboxed, cookie-free, redirects kept inside the preview).
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TOKEN_SIGNING_KEY ??= randomBytes(32).toString('hex');

const computer = { state: 'running' as string, container_name: 'c1' };
const member = { id: 'u1', status: 'active', auth_version: 1, role: 'team' };
vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    botComputers: { get: async (userId: string) => (userId === 'u1' ? { user_id: 'u1', ...computer } : undefined) },
    users: { getById: async (id: string) => (id === member.id ? member : undefined) },
  }),
}));
vi.mock('../../../auth/features.js', () => ({ userHasFeature: async () => true }));

const {
  createPreviewTicket,
  previewPortAllowed,
  rewriteLocation,
  servePreview,
  verifyPreviewTicket,
  PREVIEW_TICKET_TTL_MS,
} = await import('../preview.js');
const { createViewToken } = await import('../view-token.js');
import type { ComputerProcess } from '../host.js';

/** The service in the "computer": records what it was sent. */
let service: Server;
let servicePort = 0;
const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];

beforeAll(async () => {
  service = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/after?x=1' });
        return res.end();
      }
      if (req.url === '/elsewhere') {
        res.writeHead(302, { location: 'https://example.com/out' });
        return res.end();
      }
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': ['session=abc; Path=/', 'other=1'],
        'x-from-service': 'yes',
      });
      res.end(`<a href="next.html">next</a> ${req.method} ${req.url}`);
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  servicePort = (service.address() as AddressInfo).port;
});
afterAll(() => service.close());
beforeEach(() => {
  seen.length = 0;
  computer.state = 'running';
  member.auth_version = 1;
});

/** openPort: a TCP connection to the test service, whatever port was asked (recorded). */
const opened: Array<{ container: string; port: number }> = [];
const deps = {
  host: () => ({
    openPort(container: string, port: number): ComputerProcess {
      opened.push({ container, port });
      const socket = connect(servicePort, '127.0.0.1');
      const proc = new EventEmitter() as EventEmitter & ComputerProcess;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      stdin.pipe(socket);
      socket.pipe(stdout);
      Object.assign(proc, { stdin, stdout, stderr: new PassThrough(), kill: () => (socket.destroy(), true) });
      return proc;
    },
  }),
  touch: vi.fn(async () => undefined),
};

const PORT = 8000;
const ticket = (port = PORT) => createPreviewTicket({ id: 'u1', authVersion: 1 }, port);
const call = (path: string, init?: RequestInit) => servePreview(new Request(`http://green.test${path}`, init), deps);

describe('preview tickets and ports', () => {
  it('opens only unprivileged ports that are not the bridges or the provider agent', () => {
    expect([1024, 3000, 8000, 65535].every(previewPortAllowed)).toBe(true);
    expect([0, 22, 80, 1023, 7681, 7682, 49983, 65536, 8000.5].some(previewPortAllowed)).toBe(false);
  });

  it('is bound to its port, expires, and cannot be forged or swapped for another kind of ticket', () => {
    const { token } = ticket();
    expect(verifyPreviewTicket(token, PORT)).toMatchObject({ uid: 'u1', p: PORT });
    expect(verifyPreviewTicket(token, 8001)).toBeNull();
    expect(verifyPreviewTicket(token, PORT, Date.now() + PREVIEW_TICKET_TTL_MS + 1)).toBeNull();
    const [body] = token.split('.');
    expect(verifyPreviewTicket(`${body}.forged`, PORT)).toBeNull();
    // A viewer ticket (another purpose) never opens a preview.
    const viewer = createViewToken({ id: 'u1', authVersion: 1 }, 'c1').token;
    expect(verifyPreviewTicket(viewer, PORT)).toBeNull();
  });

  it('keeps redirects to the service itself inside the preview, and leaves other sites alone', () => {
    const base = '/api/bots-preview/T/8000/';
    expect(rewriteLocation('/login', base, 8000)).toBe('/api/bots-preview/T/8000/login');
    expect(rewriteLocation('http://localhost:8000/a?b=1#c', base, 8000)).toBe('/api/bots-preview/T/8000/a?b=1#c');
    expect(rewriteLocation('http://127.0.0.1:8000/', base, 8000)).toBe('/api/bots-preview/T/8000/');
    expect(rewriteLocation('http://localhost:9000/', base, 8000)).toBe('http://localhost:9000/');
    expect(rewriteLocation('https://example.com/x', base, 8000)).toBe('https://example.com/x');
    expect(rewriteLocation('//evil.example/x', base, 8000)).toBe('//evil.example/x');
    expect(rewriteLocation('next', base, 8000)).toBe('next');
  });
});

describe('the preview proxy', () => {
  it('serves the service sandboxed: no cookies back, no credentials in, the ticket kept out of referrers', async () => {
    const { path } = ticket();
    const res = await call(`${path}page.html?q=1`, {
      headers: { authorization: 'Bearer member-token', cookie: 'gh_session=member', 'x-custom': 'kept' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<a href="next.html">next</a> GET /page.html?q=1');
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(res.headers.get('content-security-policy')).not.toMatch(/allow-same-origin/);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-from-service')).toBe('yes');
    const [request] = seen;
    expect(request!.headers.authorization).toBeUndefined();
    expect(request!.headers.cookie).toBeUndefined();
    expect(request!.headers.host).toBe(`localhost:${PORT}`);
    expect(request!.headers['x-custom']).toBe('kept');
    expect(opened.at(-1)).toEqual({ container: 'c1', port: PORT });
    expect(deps.touch).toHaveBeenCalledWith('u1');
  });

  it('forwards a form post, and keeps a redirect inside the preview', async () => {
    const { path } = ticket();
    const posted = await call(`${path}submit`, { method: 'POST', body: 'a=1&b=2' });
    expect(posted.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/submit', body: 'a=1&b=2' });
    const redirected = await call(`${path}redirect`, { redirect: 'manual' });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get('location')).toBe(`${path}after?x=1`);
    const away = await call(`${path}elsewhere`);
    expect(away.headers.get('location')).toBe('https://example.com/out');
  });

  it('adds the slash relative links need', async () => {
    const { path } = ticket();
    const res = await call(path.slice(0, -1));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(path);
  });

  it('refuses a bad, expired or other-port ticket, and a member whose credentials changed', async () => {
    const { token, path } = ticket();
    expect((await call(`/api/bots-preview/${token}/8001/`)).status).toBe(404);
    expect((await call('/api/bots-preview/garbage/8000/')).status).toBe(404);
    expect((await call(`/api/bots-preview/${token}/7681/`)).status).toBe(404);
    member.auth_version = 2; // a password reset since the ticket was issued
    expect((await call(path)).status).toBe(403);
    expect(seen).toEqual([]); // the service was never reached
  });

  it('says the computer is asleep instead of waking it, and says when nothing answers', async () => {
    const { path } = ticket();
    computer.state = 'absent';
    const asleep = await call(path);
    expect(asleep.status).toBe(503);
    expect(await asleep.text()).toContain('The computer is asleep');
    computer.state = 'running';
    const closedPort = await (async () => {
      const blocked = createServer();
      await new Promise<void>((resolve) => blocked.listen(0, '127.0.0.1', resolve));
      const port = (blocked.address() as AddressInfo).port;
      await new Promise<void>((resolve) => blocked.close(() => resolve()));
      return port;
    })();
    const nothing = await servePreview(new Request(`http://green.test${path}`), {
      ...deps,
      host: () => ({
        openPort: (): ComputerProcess => {
          const socket = connect(closedPort, '127.0.0.1');
          const proc = new EventEmitter() as EventEmitter & ComputerProcess;
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          stdin.pipe(socket);
          socket.pipe(stdout);
          socket.on('error', () => stdout.end());
          Object.assign(proc, { stdin, stdout, stderr: new PassThrough(), kill: () => (socket.destroy(), true) });
          return proc;
        },
      }),
    });
    expect(nothing.status).toBe(502);
    expect(await nothing.text()).toContain(`Nothing answered on port ${PORT}`);
  });
});
