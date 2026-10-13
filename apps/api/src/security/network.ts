/** Blocks member-supplied endpoints that point into the server's own network. */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (isIP(lower) === 4) return ipv4Private(lower);
  if (isIP(lower) !== 6) return true;
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Private(mapped[1]!);
  // The same IPv4-mapped address as a URL writes it: [::ffff:10.0.0.1] becomes [::ffff:a00:1].
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return ipv4Private(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(lower);
}

/** For endpoints a member types in: https only, and every resolved address public. */
export async function assertPublicEndpoint(raw: string): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('Use an https:// address.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('This address is not reachable from the server.');
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error('This address points into a private network.');
  }
}
