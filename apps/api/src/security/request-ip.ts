/** Resolve the client IP without trusting headers an attacker can set. */

import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

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

export interface ProxyTrust {
  /** Proxies with fixed addresses, besides loopback. */
  trustedProxies: string[];
  /** Number of proxies in front of the API when their addresses rotate (0 = use the list). */
  proxyHops: number;
}

export interface RequestSource {
  remoteAddress?: string;
  forwardedFor?: string;
  realIp?: string;
}

/** Pure resolver: forwarding headers count only when the socket peer is a trusted proxy. */
export function resolveRequestSourceIp(input: RequestSource, trust: ProxyTrust): string {
  const remote = normalizeIp(input.remoteAddress);
  if (!remote) return 'unknown';
  const forwarded = (input.forwardedFor ?? '')
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => entry !== null);

  if (trust.proxyHops > 0) {
    const chain = [...forwarded, remote];
    return chain[Math.max(0, chain.length - 1 - trust.proxyHops)]!;
  }

  const trusted = new Set(['127.0.0.1', '::1', ...trust.trustedProxies.map(normalizeIp).filter(Boolean)]);
  if (!trusted.has(remote)) return remote;
  for (let index = forwarded.length - 1; index >= 0; index--) {
    if (!trusted.has(forwarded[index]!)) return forwarded[index]!;
  }
  const realIp = normalizeIp(input.realIp);
  if (forwarded.length === 0 && realIp) return realIp;
  return forwarded[0] ?? remote;
}

export function requestSourceIp(c: Context, trust: ProxyTrust): string {
  let remoteAddress: string | undefined;
  try {
    remoteAddress = getConnInfo(c).remote.address;
  } catch {
    // In-process test requests have no socket: ignore forwarding headers.
  }
  return resolveRequestSourceIp(
    { remoteAddress, forwardedFor: c.req.header('x-forwarded-for'), realIp: c.req.header('x-real-ip') },
    trust,
  );
}
