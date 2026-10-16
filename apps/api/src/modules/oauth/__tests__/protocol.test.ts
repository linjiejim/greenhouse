import { describe, expect, it } from 'vitest';
import { OAUTH_SCOPES } from '@greenhouse/contract';
import { createTokens } from '../../../auth/tokens.js';
import {
  PREFIX,
  bearerChallenge,
  checkRedirectUri,
  cleanName,
  endpointsFor,
  intersectScopes,
  isOurResource,
  isPkceChallenge,
  isPkceVerifier,
  isSubset,
  matchRedirectUri,
  namedScopes,
  newCredential,
  pkceChallenge,
  pkceMatches,
  requestedScopes,
  resourceMetadata,
  sameScopes,
  serverMetadata,
  withParams,
} from '../protocol.js';

describe('PKCE', () => {
  it('computes S256 as in RFC 7636 appendix B', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cX')).toBe(false);
  });

  it('accepts only well-formed verifiers and S256 challenges', () => {
    expect(isPkceVerifier('a'.repeat(43))).toBe(true);
    expect(isPkceVerifier('a'.repeat(42))).toBe(false);
    expect(isPkceVerifier('a'.repeat(129))).toBe(false);
    expect(isPkceVerifier(`${'a'.repeat(43)}+`)).toBe(false);
    expect(isPkceChallenge(pkceChallenge('x'.repeat(50)))).toBe(true);
    // A plain challenge (the verifier itself) is not a S256 digest.
    expect(isPkceChallenge('x'.repeat(50))).toBe(false);
    // A malformed verifier never matches, even against its own digest.
    expect(pkceMatches('short', pkceChallenge('short'))).toBe(false);
  });
});

describe('redirect URIs', () => {
  it('allows https, loopback http and app schemes, and nothing that can carry a fragment or a script', () => {
    expect(checkRedirectUri('https://app.example.com/callback')).toBe('https://app.example.com/callback');
    expect(checkRedirectUri('http://127.0.0.1:33418/callback')).toBe('http://127.0.0.1:33418/callback');
    expect(checkRedirectUri('http://localhost:6274/oauth/callback')).toBe('http://localhost:6274/oauth/callback');
    expect(checkRedirectUri('http://[::1]:8080/cb')).toBe('http://[::1]:8080/cb');
    expect(checkRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).not.toBeNull();
    expect(checkRedirectUri('com.example.app:/oauth2redirect')).not.toBeNull();
    for (const bad of [
      'http://app.example.com/callback',
      'https://app.example.com/callback#frag',
      'https://user:pass@app.example.com/cb',
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'not a url',
      'https://app.example.com/a b',
    ]) {
      expect(checkRedirectUri(bad), bad).toBeNull();
    }
  });

  it('matches exactly, except the port of a loopback URI', () => {
    const registered = ['https://app.example.com/cb', 'http://127.0.0.1:1234/callback'];
    expect(matchRedirectUri(registered, 'https://app.example.com/cb')).toBe(true);
    expect(matchRedirectUri(registered, 'https://app.example.com/cb/')).toBe(false);
    expect(matchRedirectUri(registered, 'https://app.example.com/cb?x=1')).toBe(false);
    expect(matchRedirectUri(registered, 'https://APP.example.com/cb')).toBe(false);
    expect(matchRedirectUri(registered, 'http://127.0.0.1:5555/callback')).toBe(true);
    expect(matchRedirectUri(registered, 'http://127.0.0.1:5555/other')).toBe(false);
    expect(matchRedirectUri(registered, 'http://localhost:1234/callback')).toBe(false);
    expect(matchRedirectUri(['https://app.example.com:443/cb'], 'https://app.example.com:8443/cb')).toBe(false);
  });

  it('adds response parameters to the query', () => {
    expect(withParams('http://127.0.0.1:9/cb?keep=1', { code: 'c', state: null, iss: 'https://g.test' })).toBe(
      'http://127.0.0.1:9/cb?keep=1&code=c&iss=https%3A%2F%2Fg.test',
    );
  });
});

describe('scopes', () => {
  it('reads a request: unknown names are ignored, none of ours means all of ours', () => {
    expect(requestedScopes('runs:read agents:read openid offline_access')).toEqual(['agents:read', 'runs:read']);
    expect(requestedScopes(undefined)).toEqual([...OAUTH_SCOPES]);
    expect(requestedScopes('openid profile')).toEqual([...OAUTH_SCOPES]);
    expect(requestedScopes('  ')).toEqual([...OAUTH_SCOPES]);
  });

  it('refuses a named scope it does not know, so a typo never narrows silently', () => {
    expect(namedScopes('conversations:read agents:read')).toEqual(['agents:read', 'conversations:read']);
    expect(namedScopes('agents:read agents:write')).toBeNull();
    expect(namedScopes('')).toBeNull();
  });

  it('compares and intersects without ever widening', () => {
    expect(isSubset(['agents:read'], ['agents:read', 'runs:read'])).toBe(true);
    expect(isSubset(['agents:ask'], ['agents:read'])).toBe(false);
    expect(sameScopes(['runs:read', 'agents:read'], ['agents:read', 'runs:read'])).toBe(true);
    expect(sameScopes(['runs:read'], ['agents:read', 'runs:read'])).toBe(false);
    expect(intersectScopes(['agents:read', 'runs:read', 'retired:scope'], ['runs:read', 'agents:read'], null)).toEqual([
      'agents:read',
      'runs:read',
    ]);
    expect(intersectScopes(['agents:read'], [])).toEqual([]);
  });
});

describe('credentials', () => {
  it('prefixes every kind and hashes with a key and a purpose', () => {
    const access = newCredential('access');
    expect(access.startsWith(PREFIX.access)).toBe(true);
    expect(access.length).toBeGreaterThan(PREFIX.access.length + 40);
    expect(newCredential('access')).not.toBe(access);

    const tokens = createTokens('a'.repeat(64));
    const other = createTokens('b'.repeat(64));
    const hashed = tokens.hashSecret(access, 'oauth_token');
    expect(hashed).toBe(tokens.hashSecret(access, 'oauth_token'));
    expect(hashed).not.toContain(access);
    expect(hashed).not.toBe(tokens.hashSecret(access, 'oauth_code'));
    expect(hashed).not.toBe(tokens.hashSecret(access, 'refresh'));
    expect(hashed).not.toBe(other.hashSecret(access, 'oauth_token'));
  });

  it('keeps client names printable and short', () => {
    expect(cleanName('Claude\u0000 Code\n', 'x')).toBe('Claude  Code');
    expect(cleanName('a'.repeat(300), 'x')).toHaveLength(120);
    expect(cleanName(42, 'MCP client')).toBe('MCP client');
  });
});

describe('metadata', () => {
  const endpoints = endpointsFor('https://green.example.com/');

  it('names one issuer and binds tokens to /api/mcp', () => {
    expect(endpoints).toEqual({
      issuer: 'https://green.example.com',
      resource: 'https://green.example.com/api/mcp',
      resourceMetadata: 'https://green.example.com/.well-known/oauth-protected-resource/api/mcp',
      consentPage: 'https://green.example.com/#/oauth/consent',
    });
    expect(isOurResource(endpoints, undefined)).toBe(true);
    expect(isOurResource(endpoints, 'https://green.example.com/api/mcp/')).toBe(true);
    expect(isOurResource(endpoints, 'https://green.example.com/api/other')).toBe(false);
    expect(isOurResource(endpoints, 'https://evil.example.com/api/mcp')).toBe(false);
    expect(isOurResource(endpoints, 'https://green.example.com/api/mcp?x=1')).toBe(false);
  });

  it('advertises only what is implemented', () => {
    const server = serverMetadata(endpoints);
    expect(server).toMatchObject({
      issuer: 'https://green.example.com',
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      scopes_supported: [...OAUTH_SCOPES],
    });
    expect(resourceMetadata(endpoints)).toMatchObject({
      resource: 'https://green.example.com/api/mcp',
      authorization_servers: ['https://green.example.com'],
    });
    expect(bearerChallenge(endpoints, 'invalid_token')).toBe(
      `Bearer resource_metadata="https://green.example.com/.well-known/oauth-protected-resource/api/mcp", scope="${OAUTH_SCOPES.join(' ')}", error="invalid_token"`,
    );
  });
});
