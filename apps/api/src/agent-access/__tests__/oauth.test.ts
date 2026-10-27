import { describe, expect, it } from 'vitest';

import {
  normalizeGrantedScopes,
  normalizeOAuthScopes,
  OAUTH_RESOURCE_SCOPES,
  parseStoredOAuthScopes,
  resourceGroupsFromScopes,
} from '../oauth.js';

describe('parseStoredOAuthScopes', () => {
  it('accepts canonical persisted scope sets', () => {
    expect(parseStoredOAuthScopes(['mcp:read'])).toEqual(['mcp:read']);
    expect(parseStoredOAuthScopes(['mcp:read', 'mcp:write'])).toEqual(['mcp:read', 'mcp:write']);
  });

  it.each<unknown>(['not-json', [], ['mcp:write'], ['unknown']])(
    'rejects malformed or authority-expanding persisted scopes: %s',
    (stored) => {
      expect(() => parseStoredOAuthScopes(stored)).toThrow('Stored OAuth scopes are invalid');
    },
  );

  it('drops the groups of extensions that are not active, and keeps the rest of the grant', () => {
    // A 1.6 grant carried into 3.0 names groups of extensions that were not ported.
    const stored = ['mcp:read', 'mcp:write', 'mcp:files', 'mcp:letpot-admin', 'mcp:letpot-content'];
    expect(parseStoredOAuthScopes(stored)).toEqual(['mcp:read', 'mcp:write', 'mcp:files']);
  });

  it('rejects a grant left with nothing once inactive extension groups are dropped', () => {
    expect(() => parseStoredOAuthScopes(['mcp:letpot-admin'])).toThrow('Stored OAuth scopes are invalid');
  });

  it('returns exactly the stored resource groups', () => {
    const stored = ['mcp:read', 'mcp:files', 'mcp:chat'];
    expect(parseStoredOAuthScopes(stored)).toEqual(['mcp:read', 'mcp:files', 'mcp:chat']);
  });

  /**
   * The highest-risk regression in this module. Storage says what was granted;
   * expanding a group-less row into every group here would silently promote
   * every stored grant to the full surface. Rows predating resource scopes were
   * backfilled by migration 0063 exactly so this branch never needs to exist.
   */
  it('never expands a stored scope set that names no resource group', () => {
    const parsed = parseStoredOAuthScopes(['mcp:read', 'mcp:write']);
    expect(resourceGroupsFromScopes(parsed)).toEqual([]);
    for (const scope of OAUTH_RESOURCE_SCOPES) expect(parsed).not.toContain(scope);
  });
});

describe('normalizeOAuthScopes', () => {
  it('expands a request that names no resource group to all of them', () => {
    // Clients echo `scopes_supported` or send nothing; "said nothing about
    // resources" has to mean "asking for all", or every existing client breaks.
    const scopes = normalizeOAuthScopes('mcp:read mcp:write');
    for (const scope of OAUTH_RESOURCE_SCOPES) expect(scopes).toContain(scope);
    expect(normalizeOAuthScopes(undefined)).toContain('mcp:files');
  });

  it('leaves an explicit resource selection alone', () => {
    const scopes = normalizeOAuthScopes('mcp:read mcp:files');
    expect(resourceGroupsFromScopes(scopes)).toEqual(['files']);
    expect(scopes).not.toContain('mcp:chat');
  });

  it('implies mcp:read for a write request', () => {
    expect(normalizeOAuthScopes('mcp:write mcp:files')).toEqual(['mcp:read', 'mcp:write', 'mcp:files']);
  });

  it('rejects unknown scopes', () => {
    expect(() => normalizeOAuthScopes('mcp:read mcp:nope')).toThrow('Unsupported scope: mcp:nope');
  });
});

describe('normalizeGrantedScopes', () => {
  /**
   * Caught during browser acceptance: the approve endpoint originally ran the
   * user's ticked selection through normalizeOAuthScopes, so unticking EVERY
   * capability expanded back into all of them — the exact inversion of what the
   * user asked for. A human's explicit selection is never expanded.
   */
  it('never expands a selection that names no resource group', () => {
    const granted = normalizeGrantedScopes(['mcp:read', 'mcp:write']);
    expect(resourceGroupsFromScopes(granted)).toEqual([]);
    for (const scope of OAUTH_RESOURCE_SCOPES) expect(granted).not.toContain(scope);
  });

  it('keeps exactly what was ticked, and still implies read for write', () => {
    expect(normalizeGrantedScopes(['mcp:write', 'mcp:files'])).toEqual(['mcp:read', 'mcp:write', 'mcp:files']);
  });

  it('rejects unknown scopes', () => {
    expect(() => normalizeGrantedScopes(['mcp:read', 'bogus'])).toThrow('Unsupported scope: bogus');
  });
});
