import { describe, expect, it } from 'vitest';
import { API_VERSION } from '../shared/contract';
import { apiMismatch, parseBootstrap } from './compat';

describe('does the station speak this app’s API (PRD §8.5)', () => {
  it('matches, asks for a newer app, or names a v1 server', () => {
    expect(apiMismatch({ api_version: API_VERSION, name: 'Greenhouse' })).toBeNull();
    expect(apiMismatch({ api_version: API_VERSION + 1, name: 'Greenhouse' })).toBe('app_outdated');
    expect(apiMismatch({ api_version: API_VERSION - 1, name: 'Greenhouse' })).toBe('server_outdated');
    expect(apiMismatch({ product_name: 'Greenhouse', logo: null })).toBe('server_outdated');
  });

  it('gives no verdict on an answer it cannot read', () => {
    expect(apiMismatch(null)).toBeNull();
    expect(apiMismatch('<html>')).toBeNull();
    expect(apiMismatch({ hello: 'world' })).toBeNull();
  });

  it('reads the bootstrap with defaults for what an older v2 left out', () => {
    expect(parseBootstrap({ api_version: API_VERSION, name: 'Acme' })).toEqual({
      api_version: API_VERSION,
      name: 'Acme',
      primary_color: null,
      logo_url: null,
      login_methods: ['password'],
      setup_pending: false,
    });
    expect(parseBootstrap({ name: 'Acme' })).toBeNull();
    expect(parseBootstrap(null)).toBeNull();
  });
});
