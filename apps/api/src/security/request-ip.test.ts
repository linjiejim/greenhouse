import { describe, expect, it } from 'vitest';

import { resolveRequestSourceIp } from './request-ip.js';

describe('request source IP resolution', () => {
  const trusted = new Set(['127.0.0.1', '10.0.0.10']);

  it('ignores forwarding headers from an untrusted socket peer', () => {
    expect(
      resolveRequestSourceIp({
        remoteAddress: '203.0.113.20',
        forwardedFor: '1.2.3.4',
        trustedProxies: trusted,
      }),
    ).toBe('203.0.113.20');
  });

  it('uses the client supplied by a trusted reverse proxy', () => {
    expect(
      resolveRequestSourceIp({
        remoteAddress: '10.0.0.10',
        forwardedFor: '198.51.100.42',
        trustedProxies: trusted,
      }),
    ).toBe('198.51.100.42');
  });

  it('walks a proxy chain from the trusted right edge', () => {
    expect(
      resolveRequestSourceIp({
        remoteAddress: '10.0.0.10',
        forwardedFor: '1.2.3.4, 198.51.100.42, 127.0.0.1',
        trustedProxies: trusted,
      }),
    ).toBe('198.51.100.42');
  });

  it('returns unknown without socket provenance instead of trusting a header', () => {
    expect(
      resolveRequestSourceIp({
        forwardedFor: '1.2.3.4',
        trustedProxies: trusted,
      }),
    ).toBe('unknown');
  });
});
