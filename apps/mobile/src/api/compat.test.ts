import { describe, expect, it } from 'vitest';
import { MOBILE_API, apiMismatch, parseBootstrap } from './compat';

describe('does the station speak this app’s API', () => {
  it('matches at or above the level this app needs, asks an older server to update', () => {
    expect(apiMismatch({ product_name: 'Acme', logo: null, theme_tokens: null, mobile_api: MOBILE_API })).toBeNull();
    expect(apiMismatch({ product_name: null, logo: null, theme_tokens: null, mobile_api: MOBILE_API + 1 })).toBeNull();
    expect(apiMismatch({ product_name: null, logo: null, theme_tokens: null })).toBe('server_outdated');
    expect(apiMismatch({ product_name: null, mobile_api: MOBILE_API - 1 })).toBe('server_outdated');
  });

  it('names a Greenhouse 2 server as unsupported', () => {
    expect(apiMismatch({ api_version: 2, name: 'Greenhouse' })).toBe('unsupported');
  });

  it('gives no verdict on an answer it cannot read', () => {
    expect(apiMismatch(null)).toBeNull();
    expect(apiMismatch('<html>')).toBeNull();
    expect(apiMismatch({ hello: 'world' })).toBeNull();
  });

  it('reads the branding, dropping what is not usable', () => {
    expect(
      parseBootstrap({ product_name: 'Acme', logo: 'https://x/logo.png', theme_tokens: { primary: '#123456' }, mobile_api: 1 }),
    ).toEqual({ product_name: 'Acme', logo: null, theme_tokens: { primary: '#123456' }, mobile_api: 1 });
    expect(parseBootstrap({ product_name: '  ', logo: 'data:image/png;base64,AA', theme_tokens: null })).toEqual({
      product_name: null,
      logo: 'data:image/png;base64,AA',
      theme_tokens: null,
    });
    expect(parseBootstrap({ name: 'Acme' })).toBeNull();
    expect(parseBootstrap(null)).toBeNull();
  });
});
