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
    expect(parseStoredOAuthScopes(JSON.stringify(['mcp:read']))).toEqual(['mcp:read']);
    expect(parseStoredOAuthScopes(JSON.stringify(['mcp:read', 'mcp:write']))).toEqual(['mcp:read', 'mcp:write']);
  });

  it.each(['not-json', '[]', JSON.stringify(['mcp:write']), JSON.stringify(['unknown'])])(
    'rejects malformed or authority-expanding persisted scopes: %s',
    (stored) => {
      expect(() => parseStoredOAuthScopes(stored)).toThrow('Stored OAuth scopes are invalid');
    },
  );

  it('returns exactly the stored resource groups', () => {
    const stored = JSON.stringify(['mcp:read', 'mcp:knowledge', 'mcp:tables']);
    expect(parseStoredOAuthScopes(stored)).toEqual(['mcp:read', 'mcp:knowledge', 'mcp:tables']);
  });

  /**
   * The highest-risk regression in this module. Storage says what was granted;
   * expanding a group-less row into every group here would silently promote
   * every stored grant to the full surface. Rows predating resource scopes were
   * backfilled by migration 0063 exactly so this branch never needs to exist.
   */
  it('never expands a stored scope set that names no resource group', () => {
    const parsed = parseStoredOAuthScopes(JSON.stringify(['mcp:read', 'mcp:write']));
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
    expect(normalizeOAuthScopes(undefined)).toContain('mcp:knowledge');
  });

  it('leaves an explicit resource selection alone', () => {
    const scopes = normalizeOAuthScopes('mcp:read mcp:knowledge');
    expect(resourceGroupsFromScopes(scopes)).toEqual(['knowledge']);
    expect(scopes).not.toContain('mcp:tables');
  });

  it('implies mcp:read for a write request', () => {
    expect(normalizeOAuthScopes('mcp:write mcp:tables')).toEqual(['mcp:read', 'mcp:write', 'mcp:tables']);
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
    expect(normalizeGrantedScopes(['mcp:write', 'mcp:tables'])).toEqual(['mcp:read', 'mcp:write', 'mcp:tables']);
  });

  it('rejects unknown scopes', () => {
    expect(() => normalizeGrantedScopes(['mcp:read', 'bogus'])).toThrow('Unsupported scope: bogus');
  });
});
