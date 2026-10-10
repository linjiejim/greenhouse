/**
 * Port previews: the member opens a web service running in their computer —
 * one a Bot built and started — in their own browser, through the API.
 *
 *   GET|POST|… /api/bots-preview/<ticket>/<port>/<path>
 *
 * The ticket is the credential: a top-level navigation (and the page's own
 * requests for its scripts and styles) carries no Bearer header, so
 * isPublicPath exempts the prefix and this route checks the ticket itself —
 * signed under its own purpose, bound to the member, their credential
 * generation (a password reset or a disable ends it) and the port, valid
 * PREVIEW_TICKET_TTL_MS, re-checked against the member on every request.
 * Relative links in the page keep it.
 *
 * What the page runs must never act as Greenhouse. Every response carries
 * `Content-Security-Policy: sandbox …` WITHOUT allow-same-origin: the page
 * gets an opaque origin, so it can neither read Greenhouse's storage nor call
 * its API as the member. Set-Cookie is dropped (it would land on Greenhouse's
 * origin), the member's Authorization and cookies are never forwarded, and
 * `Referrer-Policy: no-referrer` keeps the ticket out of other sites' logs.
 *
 * Limits of serving under a path on Greenhouse's origin: only relative URLs
 * stay inside the preview (an absolute `/static/app.js` or `fetch('/api/x')`
 * goes to Greenhouse), there are no cookies or local storage, and no
 * WebSockets (dev servers' hot reload). The Bot is told to serve with
 * relative paths; a dedicated preview origin is the way past this.
 */

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Duplex, Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';

import { hmacSign } from '../../auth/token.js';
import type { ComputerProcess, ComputerExec } from './host.js';
import { ticketHolderStatus } from './view-token.js';

export const PREVIEW_PREFIX = '/api/bots-preview';
export const PREVIEW_TICKET_PURPOSE = 'bots-computer-preview';
export const PREVIEW_TICKET_TTL_MS = 2 * 60 * 60_000;
/** Never a preview: the two bridges and the provider's own agent (envd). gh-bridge checks the same. */
const PORT_DENY = new Set([7681, 7682, 49983]);
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
/** How long the service in the computer may take to start answering. */
const UPSTREAM_TIMEOUT_MS = 60_000;
/** Scripts, forms, popups and downloads work; the origin stays opaque (no allow-same-origin). */
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
/** Never forwarded into the computer: the member's own credentials, and what the proxy sets itself. */
const REQUEST_DROP = new Set([...HOP_BY_HOP, 'host', 'authorization', 'cookie', 'origin', 'referer']);
/** Never passed back: what would act on Greenhouse's origin, and what the proxy sets itself. */
const RESPONSE_DROP = new Set([...HOP_BY_HOP, 'set-cookie', 'set-cookie2']);

export function previewPortAllowed(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && !PORT_DENY.has(port);
}

interface PreviewClaims {
  uid: string;
  /** users.auth_version at issue time. */
  av: number;
  /** The one port it opens. */
  p: number;
  exp: number;
  /** Makes two tickets for the same port differ. */
  n: string;
}

export function createPreviewTicket(
  user: { id: string; authVersion: number },
  port: number,
  now = Date.now(),
): { token: string; expires_at: string; path: string } {
  const claims: PreviewClaims = {
    uid: user.id,
    av: user.authVersion,
    p: port,
    exp: now + PREVIEW_TICKET_TTL_MS,
    n: randomBytes(8).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${body}.${hmacSign(body, PREVIEW_TICKET_PURPOSE)}`;
  return { token, expires_at: new Date(claims.exp).toISOString(), path: `${PREVIEW_PREFIX}/${token}/${port}/` };
}

/** The ticket's claims when it is ours, unexpired and for this port; null otherwise. */
export function verifyPreviewTicket(token: string, port: number, now = Date.now()): PreviewClaims | null {
  if (!token || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmacSign(body, PREVIEW_TICKET_PURPOSE));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  const claims = safeJsonParse(Buffer.from(body, 'base64url').toString('utf8'), null) as Partial<PreviewClaims> | null;
  if (
    !claims ||
    typeof claims.uid !== 'string' ||
    typeof claims.av !== 'number' ||
    typeof claims.p !== 'number' ||
    typeof claims.exp !== 'number'
  ) {
    return null;
  }
  if (claims.p !== port || claims.exp <= now) return null;
  return claims as PreviewClaims;
}

/**
 * A redirect stays inside the preview when it points at the service itself (an absolute
 * path, or its own localhost address); one to any other site is left alone.
 */
export function rewriteLocation(location: string, base: string, port: number): string {
  if (location.startsWith('/') && !location.startsWith('//')) return `${base}${location.slice(1)}`;
  try {
    const url = new URL(location);
    const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname);
    const urlPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (local && urlPort === port) return `${base}${`${url.pathname}${url.search}${url.hash}`.slice(1)}`;
  } catch {
    // A relative location: the browser resolves it against the preview path.
  }
  return location;
}

/** A ComputerProcess's stdio as the socket Node's HTTP client expects. */
function socketOf(proc: ComputerProcess): Duplex {
  const duplex = Duplex.from({ readable: proc.stdout!, writable: proc.stdin! }) as Duplex & Record<string, unknown>;
  for (const method of ['setNoDelay', 'setKeepAlive', 'setTimeout', 'ref', 'unref']) duplex[method] = () => duplex;
  return duplex;
}

/** Passes at most `max` bytes, then fails the stream (a request body too large to forward). */
function limited(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > max) callback(new Error('The request is too large for a preview'));
      else callback(null, chunk);
    },
  });
}

/** A small page for the member when the preview cannot be shown (never the service's own content). */
function notice(status: number, title: string, detail: string): Response {
  const escape = (text: string) =>
    text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const html = `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font:15px system-ui;margin:3rem;max-width:36rem"><h1 style="font-size:1.2rem">${escape(title)}</h1><p>${escape(detail)}</p>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': SANDBOX_CSP,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

export interface PreviewDeps {
  host(): Pick<ComputerExec, 'openPort'>;
  /** Mark the member's computer as in use (a preview keeps it awake like any other use). */
  touch(userId: string): Promise<void>;
}

/** The handler behind PREVIEW_PREFIX (exported for tests: a fake host, a real HTTP service). */
export async function servePreview(request: Request, deps: PreviewDeps): Promise<Response> {
  const url = new URL(request.url);
  const rest = url.pathname.startsWith(`${PREVIEW_PREFIX}/`) ? url.pathname.slice(PREVIEW_PREFIX.length + 1) : '';
  const [token = '', portText = '', ...tail] = rest.split('/');
  const port = Number(portText);
  const claims = previewPortAllowed(port) ? verifyPreviewTicket(token, port) : null;
  if (!claims) return notice(404, 'This preview link is not valid', 'It may have expired — ask the Bot for a new one.');
  if ((await ticketHolderStatus(claims.uid, claims.av).catch(() => 'unauthorized')) !== 'ok') {
    return notice(
      403,
      'This preview link is no longer yours to use',
      'Sign in to Greenhouse and ask the Bot for a new one.',
    );
  }
  const base = `${PREVIEW_PREFIX}/${token}/${port}/`;
  // /<ticket>/<port> without the slash: relative links would resolve one level up.
  if (tail.length === 0) return new Response(null, { status: 308, headers: { location: base } });
  const computer = await getDb().botComputers.get(claims.uid);
  if (!computer || computer.state !== 'running') {
    return notice(
      503,
      'The computer is asleep',
      'Open Greenhouse and wake the computer (or ask a Bot to use it), then reload this page.',
    );
  }
  void deps.touch(claims.uid).catch(() => undefined);

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_REQUEST_BYTES) return notice(413, 'Too large', 'A preview forwards at most 20 MB per request.');
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!REQUEST_DROP.has(name.toLowerCase())) headers[name] = value;
  });
  headers.host = `localhost:${port}`;
  headers.connection = 'close';

  let proc: ComputerProcess;
  try {
    proc = deps.host().openPort(computer.container_name, port);
  } catch {
    return notice(503, 'Computers are unavailable', 'Computers are not running on this server right now.');
  }
  const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(
      {
        method: request.method,
        path: `/${tail.join('/')}${url.search}`,
        headers,
        createConnection: () => socketOf(proc) as never,
      },
      resolve,
    );
    const timer = setTimeout(() => req.destroy(new Error('The service did not answer in time')), UPSTREAM_TIMEOUT_MS);
    req.once('response', () => clearTimeout(timer));
    req.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      Readable.fromWeb(request.body as WebReadableStream<Uint8Array>)
        .pipe(limited(MAX_REQUEST_BYTES))
        .on('error', (err) => req.destroy(err))
        .pipe(req);
    } else {
      req.end();
    }
  }).catch((err: unknown) => {
    proc.kill('SIGKILL');
    logger.info('[bots-computer] preview could not reach the service', { port, error: toErrorMessage(err) });
    return null;
  });
  if (!upstream) {
    return notice(
      502,
      `Nothing answered on port ${port}`,
      'The service in the computer is not running (or not listening on that port). Ask the Bot to start it again.',
    );
  }

  const out = new Headers();
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || RESPONSE_DROP.has(name)) continue;
    if (name === 'location') {
      out.set(name, rewriteLocation(String(value), base, port));
      continue;
    }
    for (const one of Array.isArray(value) ? value : [value]) out.append(name, one);
  }
  // Ours on top of whatever the service sends (several CSP headers all apply).
  out.append('content-security-policy', SANDBOX_CSP);
  out.set('referrer-policy', 'no-referrer');
  out.set('x-content-type-options', 'nosniff');
  const status = upstream.statusCode ?? 502;
  const bodyless = request.method === 'HEAD' || status === 204 || status === 304;
  if (bodyless) {
    upstream.resume();
    return new Response(null, { status, headers: out });
  }
  upstream.once('close', () => proc.kill('SIGKILL'));
  return new Response(Readable.toWeb(upstream) as unknown as ReadableStream, { status, headers: out });
}

export function createComputerPreviewRoutes(deps: PreviewDeps) {
  return new Hono().all('/*', (c) => servePreview(c.req.raw, deps));
}
