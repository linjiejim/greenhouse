/**
 * Where a connector may point, and the one fetch that reaches it.
 *
 * - An address is http(s). Personal connectors, and team connectors without
 *   「内网服务」, reach public addresses only: a literal private / loopback /
 *   link-local address or a `localhost` name is refused when the connector is
 *   saved, and every hop is checked again when it connects (a DNS answer can
 *   change). Direct connections resolve through `publicOnlyLookup`, so the check
 *   happens on the socket itself; proxied connections (HTTPS_PROXY, host not in
 *   NO_PROXY) are checked by a lookup just before the request.
 * - A team connector a super marked `private_network` may point at a private
 *   address, but only its configured host gets that exemption; everything its
 *   metadata names elsewhere is held to the public rule.
 * - A server's OAuth metadata names further addresses (authorization server,
 *   token, registration and revocation endpoints): only its own origin or https
 *   ones are followed, and a redirect never leaves the origin it was sent to
 *   (it would carry the credential along).
 * - Every request has a deadline and an 8 MB response cap.
 *
 * MCP traffic has its own undici dispatchers: the API's global dispatcher sends
 * everything through HTTPS_PROXY (index.ts), which an internal MCP server
 * behind NO_PROXY must not go through. `fetch` therefore comes from the same
 * undici package as the dispatchers (see apps/api/src/AGENTS.md) and every
 * response is re-wrapped as the GLOBAL `Response`: the MCP SDK reads an OAuth
 * error body only after `instanceof Response`, and undici's own class is a
 * different one, so `invalid_grant` would otherwise read as a generic failure.
 *
 * Development and test (NODE_ENV) additionally allow loopback addresses for
 * every connector, so a local fixture server can stand in for a remote one.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { isPublicNetworkAddress, publicOnlyLookup } from '../security/network.js';

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** One response may carry at most this much; an MCP answer is JSON, not a download. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Statuses whose response may not carry a body (the Response constructor refuses one). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);

export interface NetworkPolicy {
  /** The one host (lowercase, no brackets) allowed to be private, or null. */
  privateHost: string | null;
}

const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
const isLocalhostName = (host: string) => host === 'localhost' || host.endsWith('.localhost');

/** Development and test runs may reach loopback (a local fixture server). Never in production. */
export function loopbackAllowed(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

function isAllowedLoopback(host: string): boolean {
  return loopbackAllowed() && (isLocalhostName(host) || LOOPBACK_ADDRESSES.has(host) || host.startsWith('127.'));
}

/**
 * Why an address cannot be a connector's, without looking it up: null when the
 * shape is fine. `privateNetwork` = a team connector a super marked as internal.
 */
export function connectorUrlProblem(raw: string, opts: { privateNetwork: boolean }): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Use a full address, such as https://example.com/mcp.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an https:// address.';
  if (url.username || url.password) return 'Put credentials in the key settings, never in the address.';
  if (opts.privateNetwork) return null;
  const host = hostOf(url);
  if (isAllowedLoopback(host)) return null;
  if (isLocalhostName(host) || host.endsWith('.internal') || host.endsWith('.local')) {
    return 'This address points into a private network. Only an administrator can add one, as a team connector marked as an internal service.';
  }
  if (isIP(host) && !isPublicNetworkAddress(host)) {
    return 'This address points into a private network. Only an administrator can add one, as a team connector marked as an internal service.';
  }
  return null;
}

// ─── Dispatchers ─────────────────────────────────────────

let publicAgent: Agent | null = null;
let openAgent: Agent | null = null;
let proxyAgents: { http: ProxyAgent | null; https: ProxyAgent | null; key: string } | null = null;

function directAgent(isPublicOnly: boolean): Agent {
  if (isPublicOnly) {
    publicAgent ??= new Agent({ connect: { lookup: publicOnlyLookup } });
    return publicAgent;
  }
  openAgent ??= new Agent();
  return openAgent;
}

function proxyEnv() {
  const http = process.env.http_proxy || process.env.HTTP_PROXY || '';
  const https = process.env.https_proxy || process.env.HTTPS_PROXY || http;
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  return { http, https, noProxy };
}

/** NO_PROXY the standard way: `*`, exact hosts and domain suffixes, optional `:port`. */
export function bypassesProxy(url: URL, noProxy: string): boolean {
  const entries = noProxy
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return false;
  if (entries.includes('*')) return true;
  const host = hostOf(url);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  for (const entry of entries) {
    const match = /^(.*?)(?::(\d+))?$/.exec(entry.replace(/^\[|\]$/g, ''));
    let name = (match?.[1] ?? entry).replace(/^\*?\./, '');
    name = name.replace(/^\[|\]$/g, '');
    const entryPort = match?.[2] ? Number(match[2]) : null;
    if (entryPort && entryPort !== port) continue;
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return false;
}

function proxyFor(url: URL): ProxyAgent | null {
  const env = proxyEnv();
  const uri = url.protocol === 'https:' ? env.https : env.http;
  if (!uri || bypassesProxy(url, env.noProxy)) return null;
  const key = `${env.http}|${env.https}`;
  if (!proxyAgents || proxyAgents.key !== key) {
    proxyAgents = {
      key,
      http: env.http ? new ProxyAgent(env.http) : null,
      https: env.https ? new ProxyAgent(env.https) : null,
    };
  }
  return url.protocol === 'https:' ? proxyAgents.https : proxyAgents.http;
}

/** A proxied hop cannot use the socket lookup: resolve once and require every answer public. */
async function assertResolvesPublic(host: string): Promise<void> {
  if (isIP(host)) {
    if (!isPublicNetworkAddress(host)) throw new Error('Remote host is not public');
    return;
  }
  const answers = await dnsLookup(host, { all: true, verbatim: true });
  if (answers.length === 0 || answers.some((a) => !isPublicNetworkAddress(a.address))) {
    throw new Error('Remote host resolved to a non-public address');
  }
}

// ─── Fetch ───────────────────────────────────────────────

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

/** The global Response, whatever fetch produced it (see the file header). The body stays a stream. */
export function asGlobalResponse(response: {
  status: number;
  statusText: string;
  headers: Iterable<[string, string]>;
  body: unknown;
}): Response {
  const body =
    NULL_BODY_STATUSES.has(response.status) || !response.body ? null : (response.body as ReadableStream<Uint8Array>);
  return new Response(body ? limited(body, MAX_RESPONSE_BYTES) : null, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers([...response.headers]),
  });
}

function deadline(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

async function send(target: URL, init: RequestInit, policy: NetworkPolicy): Promise<Response> {
  const host = hostOf(target);
  const exempt = (policy.privateHost !== null && host === policy.privateHost) || isAllowedLoopback(host);
  const proxy = proxyFor(target);
  if (proxy && !exempt) await assertResolvesPublic(host);
  const dispatcher: Dispatcher = proxy ?? directAgent(!exempt);
  const res = await undiciFetch(target.href, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher });
  return asGlobalResponse(res as unknown as Parameters<typeof asGlobalResponse>[0]);
}

/**
 * fetch for one connector: its own origin, or https anywhere; non-public
 * addresses refused unless exempt; redirects followed only within the origin
 * they started at; a deadline on each request.
 */
export function connectorFetch(serverUrl: string, policy: NetworkPolicy, timeoutMs: number): FetchLike {
  const home = new URL(serverUrl).origin;
  return async (input, init = {}) => {
    let target = new URL(String(input));
    const signal = deadline(init.signal, timeoutMs);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (target.origin !== home && target.protocol !== 'https:') {
        throw new Error(`Refused to reach ${target.origin}: only https or the connector's own address.`);
      }
      const host = hostOf(target);
      const exempt = policy.privateHost !== null && host === policy.privateHost;
      const problem = exempt ? null : connectorUrlProblem(target.href, { privateNetwork: false });
      if (problem) throw new Error(problem);
      const response = await send(target, { ...init, method, body, signal, redirect: 'manual' }, policy);
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
      if (!location) return response;
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

/** The network policy of a connector row. */
export function policyFor(row: { scope: string; private_network: boolean; url: string }): NetworkPolicy {
  if (row.scope !== 'team' || !row.private_network) return { privateHost: null };
  try {
    return { privateHost: hostOf(new URL(row.url)) };
  } catch {
    return { privateHost: null };
  }
}
