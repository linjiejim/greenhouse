/**
 * Where a connector may point, and the one fetch that reaches it.
 *
 * - An address is https. Plain http only to this machine (localhost), and only in development.
 * - In production nothing on a private, loopback or link-local address: checked when it is
 *   saved, and again at connect time for every hop, because a DNS answer can change.
 * - A server's OAuth metadata names further addresses (its authorization server, token and
 *   registration endpoints): only its own origin or https ones are followed, and a redirect
 *   never leaves the origin it was sent to (it would carry the key along).
 * - Every request has a deadline and a size limit.
 */

import { isIP } from 'node:net';
import { assertPublicEndpoint, isPrivateAddress } from '../../security/network.js';
import { publicFetch } from '../../security/public-fetch.js';

export type NetworkMode = 'development' | 'test' | 'production';
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** One response may carry at most this much; an MCP answer is JSON, not a download. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Statuses whose response may not carry a body (the Response constructor refuses one). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');

/**
 * Why an address cannot be a connector's, without looking it up: null when the shape is fine.
 * In production the name is also resolved (assertConnectorUrl).
 */
export function connectorUrlProblem(raw: string, mode: NetworkMode): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Use a full address, such as https://example.com/mcp.';
  }
  if (url.username || url.password) return 'Put credentials in the key settings, never in the address.';
  const host = hostOf(url);
  if (url.protocol === 'http:') {
    if (mode === 'development' && isLoopbackHost(host)) return null;
    return mode === 'development'
      ? 'Use an https:// address; plain http is only for this machine (localhost).'
      : 'Use an https:// address.';
  }
  if (url.protocol !== 'https:') return 'Use an https:// address.';
  if (mode === 'production') {
    if (isLoopbackHost(host) || host.endsWith('.internal') || host.endsWith('.local')) {
      return 'This address is not reachable from the server.';
    }
    if (isIP(host) && isPrivateAddress(host)) return 'This address points into a private network.';
  }
  return null;
}

/** The address rules, with a DNS lookup in production: every address a name resolves to must be public. */
export async function assertConnectorUrl(raw: string, mode: NetworkMode): Promise<void> {
  const problem = connectorUrlProblem(raw, mode);
  if (problem) throw new Error(problem);
  if (mode === 'production') await assertPublicEndpoint(raw);
}

/** Where a browser may be sent to sign in: the same rules, so a server cannot hand out a `javascript:` link. */
export function isBrowserSafeUrl(raw: string, mode: NetworkMode): boolean {
  return connectorUrlProblem(raw, mode) === null;
}

/** Counts the bytes of a body and stops it past the limit. */
function limited(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error(`The server sent more than ${max / 1024 / 1024} MB.`));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * The global Response, whatever fetch produced it: the MCP SDK reads an OAuth error body only
 * after `instanceof Response`, and undici's own Response is another class, so `invalid_grant`
 * would otherwise read as a generic failure. The body stays a stream (an SSE reply keeps flowing).
 */
function asGlobalResponse(response: Response): Response {
  const body = NULL_BODY_STATUSES.has(response.status) || !response.body ? null : response.body;
  return new Response(body ? limited(body as ReadableStream<Uint8Array>, MAX_RESPONSE_BYTES) : null, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers([...response.headers]),
  });
}

function deadline(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

/**
 * fetch for one connector: its own origin, or https anywhere; private addresses refused in
 * production; redirects followed only within the origin they started at; a deadline on each request.
 */
export function connectorFetch(serverUrl: string, mode: NetworkMode, timeoutMs: number): FetchLike {
  const home = new URL(serverUrl).origin;
  const network = (mode === 'production' ? publicFetch : globalThis.fetch) as typeof fetch;
  return async (input, init = {}) => {
    let target = new URL(String(input));
    const signal = deadline(init.signal, timeoutMs);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (target.origin !== home && target.protocol !== 'https:') {
        throw new Error(`Refused to reach ${target.origin}: only https or the connector's own address.`);
      }
      const problem = mode === 'production' ? connectorUrlProblem(target.href, mode) : null;
      if (problem) throw new Error(problem);
      const response = await network(target.href, { ...init, method, body, signal, redirect: 'manual' });
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
      if (!location) return asGlobalResponse(response);
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, target);
      if (next.origin !== target.origin) {
        throw new Error(`The server redirected to ${next.origin}; use that address instead.`);
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      target = next;
    }
    throw new Error('Too many redirects.');
  };
}

/** fetch for a fixed outside service (the MCP Registry): public only in production, with a deadline. */
export function serviceFetch(mode: NetworkMode, timeoutMs: number): FetchLike {
  const network = (mode === 'production' ? publicFetch : globalThis.fetch) as typeof fetch;
  return async (input, init = {}) =>
    asGlobalResponse(await network(String(input), { ...init, signal: deadline(init.signal, timeoutMs) }));
}
