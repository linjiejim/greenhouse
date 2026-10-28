import { describe, expect, it } from 'vitest';
import { CLIENT_API_LEVEL } from '../shared/plugins';
import { apiMismatch, parseBootstrap } from './bootstrap';

describe('is the station new enough for this app', () => {
  it('matches at or above the 4.0 level, asks an older station to update', () => {
    expect(CLIENT_API_LEVEL).toBe(4);
    expect(apiMismatch({ product_name: 'Acme', logo: null, theme_tokens: null, mobile_api: 4 })).toBeNull();
    expect(apiMismatch({ product_name: null, logo: null, theme_tokens: null, mobile_api: 5 })).toBeNull();
    expect(apiMismatch({ product_name: null, logo: null, theme_tokens: null })).toBe('server_outdated');
    // a 3.x station
    expect(apiMismatch({ product_name: 'Acme', mobile_api: 3 })).toBe('server_outdated');
  });

  it('gives no verdict on an answer it cannot read', () => {
    expect(apiMismatch(null)).toBeNull();
    expect(apiMismatch('<html>')).toBeNull();
    expect(apiMismatch({ hello: 'world' })).toBeNull();
  });

  it('reads the branding, dropping what is not usable', () => {
    expect(
      parseBootstrap({ product_name: 'Acme', logo: 'https://x/logo.png', theme_tokens: { primary: '#123456' }, mobile_api: 4 }),
    ).toEqual({ product_name: 'Acme', logo: null, theme_tokens: { primary: '#123456' }, mobile_api: 4 });
    expect(parseBootstrap({ product_name: '  ', logo: 'data:image/png;base64,AA', theme_tokens: null })).toEqual({
      product_name: null,
      logo: 'data:image/png;base64,AA',
      theme_tokens: null,
    });
    expect(parseBootstrap({ name: 'Acme' })).toBeNull();
    expect(parseBootstrap(null)).toBeNull();
  });
});
