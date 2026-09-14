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

export interface RequestSourceInput {
  remoteAddress?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxies?: ReadonlySet<string>;
}

/** Pure resolver exposed for policy tests. */
export function resolveRequestSourceIp(input: RequestSourceInput): string {
  const remote = normalizeIp(input.remoteAddress);
  if (!remote) return 'unknown';

  const trusted = input.trustedProxies ?? configuredTrustedProxies();
  if (!trusted.has(remote)) return remote;

  const forwarded = (input.forwardedFor ?? '')
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => entry !== null);

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
