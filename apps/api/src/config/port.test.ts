import { afterEach, expect, it, vi } from 'vitest';
import { resolveApiPort } from './port.js';
import { getOAuthIssuerUrl } from '../agent-access/oauth.js';

afterEach(() => vi.unstubAllEnvs());
it.each([
  [{}, 3000],
  [{ PORT: '8080' }, 8080],
  [{ API_PORT: '3200', PORT: '8080' }, 3200],
])('resolves the API listener port from %j', (env, expected) => {
  expect(resolveApiPort(env)).toBe(expected);
});
it('uses the same port precedence for the OAuth localhost fallback', () => {
  vi.stubEnv('API_BASE_URL', undefined);
  vi.stubEnv('API_PORT', undefined);
  vi.stubEnv('PORT', '8080');
  expect(getOAuthIssuerUrl()).toBe('http://localhost:8080');
  vi.stubEnv('API_PORT', '3200');
  expect(getOAuthIssuerUrl()).toBe('http://localhost:3200');
  vi.stubEnv('API_BASE_URL', 'https://api.example');
  expect(getOAuthIssuerUrl()).toBe('https://api.example');
});
