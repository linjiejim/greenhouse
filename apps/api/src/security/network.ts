/** Safe downloader for public HTTPS image resources used by Agent tools. */

import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
// `fetch` MUST come from the same undici as `Agent`. Node's global fetch embeds its
// own pinned undici (see process.versions.undici) and validates dispatchers against
// that build's handler interface, so a dispatcher from this package is rejected with
// `UND_ERR_INVALID_ARG: invalid onRequestStart method`, surfacing as the opaque
// `TypeError: fetch failed`. Importing both from one module makes the pair
// version-proof instead of coupling us to whatever undici Node ships.
import { Agent, fetch as undiciFetch } from 'undici';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

import { validateMagicBytes } from './security.js';

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const nonPublicAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 96],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv6');
}

function unbracket(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

/** True only for globally routable IPv4/IPv6 addresses. */
export function isPublicNetworkAddress(input: string): boolean {
  const address = unbracket(input);
  const family = isIP(address);
  if (family === 4) return !nonPublicAddresses.check(address, 'ipv4');
  if (family === 6) {
    // Do not allow IPv4-mapped literals to bypass the IPv4 policy. DNS lookup
    // normally returns native family-4 records, so rejecting mapped literals
    // does not exclude normal public IPv4 hosts.
    if (address.toLowerCase().startsWith('::ffff:')) return false;
    return !nonPublicAddresses.check(address, 'ipv6');
  }
  return false;
}

/** Parse and reject URL forms that must never be fetched by an Agent tool. */
export function assertSafePublicImageUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Remote image URL is invalid');
  }

  if (url.protocol !== 'https:') throw new Error('Remote images must use HTTPS');
  if (url.username || url.password) throw new Error('Remote image URL must not contain credentials');
  if (url.port && url.port !== '443') throw new Error('Remote image URL must use the standard HTTPS port');

  const hostname = unbracket(url.hostname).toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Remote image host is not public');
  }
  if (isIP(hostname) !== 0 && !isPublicNetworkAddress(hostname)) {
    throw new Error('Remote image host is not public');
  }
  return url;
}

const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(
    hostname,
    {
      family: options.family,
      hints: options.hints,
      all: true,
      verbatim: true,
    },
    (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      if (addresses.length === 0 || addresses.some((entry) => !isPublicNetworkAddress(entry.address))) {
        const blocked = Object.assign(new Error('Remote image host resolved to a non-public address'), {
          code: 'ENOTFOUND',
        });
        callback(blocked, '', 0);
        return;
      }

      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    },
  );
};

// The custom lookup is used by the actual socket connector, closing the DNS
// rebinding gap between a preflight lookup and fetch. It also applies to every
// redirect connection.
const publicImageAgent = new Agent({
  connect: { lookup: publicOnlyLookup },
  maxResponseSize: DEFAULT_MAX_IMAGE_BYTES,
});

function detectImageType(buffer: Buffer): string | null {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    if (validateMagicBytes(buffer, type)) return type;
  }
  return null;
}

export interface PublicImage {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
}

/**
 * Download a bounded image from the public internet.
 *
 * Every redirect is revalidated, DNS resolution is constrained at connection
 * time, and the body must have supported image magic bytes.
 */
export async function fetchPublicImage(
  input: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<PublicImage> {
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let current = assertSafePublicImageUrl(input);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await undiciFetch(current.toString(), {
      dispatcher: publicImageAgent,
      redirect: 'manual',
      signal,
      headers: {
        accept: 'image/jpeg,image/png,image/webp,image/gif',
        // Undici's maxResponseSize applies before content decoding. Requiring an
        // identity response prevents a small gzip/br body expanding in memory
        // before our decoded-size check can run.
        'accept-encoding': 'identity',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`Remote image redirect ${response.status} has no Location header`);
      if (redirectCount === MAX_REDIRECTS) throw new Error('Remote image exceeded redirect limit');
      current = assertSafePublicImageUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Failed to download image: HTTP ${response.status} ${response.statusText}`);
    }

    const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') {
      await response.body?.cancel();
      throw new Error('Compressed remote image responses are not allowed');
    }

    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Remote image exceeds ${maxBytes} bytes`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`Remote image exceeds ${maxBytes} bytes`);
    const contentType = detectImageType(buffer);
    if (!contentType) throw new Error('Remote resource is not a supported image');
    return { buffer, contentType, finalUrl: current.toString() };
  }

  throw new Error('Remote image redirect handling failed');
}
