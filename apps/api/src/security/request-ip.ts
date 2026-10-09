/** Resolve request source IP without trusting attacker-controlled proxy headers. */

import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

const LOOPBACK_PROXIES = ['127.0.0.1', '::1'];

function normalizeIp(input: string | undefined): string | null {
  if (!input) return null;
  let value = input.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.toLowerCase().startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (isIP(mapped) === 4) value = mapped;
  }
  return isIP(value) === 0 ? null : value.toLowerCase();
}

function configuredTrustedProxies(): Set<string> {
  const configured = (process.env.TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => entry !== null);
  return new Set([...LOOPBACK_PROXIES, ...configured]);
}

/**
 * TRUSTED_PROXY_HOPS — how many proxies stand in front of the API, for
 * platforms whose proxies have no fixed address (Railway: a rotating
 * 100.64.0.0/10 router, then an edge that appends its own rotating public
 * address). 0 / unset keeps the exact-address rule above.
 */
function configuredProxyHops(): number {
  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '', 10);
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
}

export interface RequestSourceInput {
  remoteAddress?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxies?: ReadonlySet<string>;
  proxyHops?: number;
}

/** Pure resolver exposed for policy tests. */
export function resolveRequestSourceIp(input: RequestSourceInput): string {
  const remote = normalizeIp(input.remoteAddress);
  if (!remote) return 'unknown';

  const forwarded = (input.forwardedFor ?? '')
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => entry !== null);

  // Hop count: the socket peer is hop 1 and each X-Forwarded-For entry from the
  // right is the next one; the client is the first address past the last
  // trusted hop (the leftmost one when the chain is shorter). Entries a client
  // prepends stay to the left of it, so they cannot win.
  const hops = input.proxyHops ?? configuredProxyHops();
  if (hops > 0) {
    const chain = [...forwarded, remote];
    return chain[Math.max(0, chain.length - 1 - hops)]!;
  }

  const trusted = input.trustedProxies ?? configuredTrustedProxies();
  if (!trusted.has(remote)) return remote;

  // Walk right-to-left: trusted proxies are removed from the end of the
  // chain, and the first untrusted address is the actual client. This resists
  // a client prepending a forged X-Forwarded-For value when the proxy appends.
  for (let i = forwarded.length - 1; i >= 0; i--) {
    if (!trusted.has(forwarded[i])) return forwarded[i];
  }

  const realIp = normalizeIp(input.realIp);
  if (forwarded.length === 0 && realIp) return realIp;
  return forwarded[0] ?? remote;
}

/** Read the socket peer and consult forwarding headers only for trusted peers. */
export function getRequestSourceIp(c: Context): string {
  let remoteAddress: string | undefined;
  try {
    remoteAddress = getConnInfo(c).remote.address;
  } catch {
    // Synthetic test requests may not carry a Node socket. Fail closed by
    // ignoring forwarding headers rather than treating them as authoritative.
  }
  return resolveRequestSourceIp({
    remoteAddress,
    forwardedFor: c.req.header('x-forwarded-for'),
    realIp: c.req.header('x-real-ip'),
  });
}
