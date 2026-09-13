import { describe, expect, it } from 'vitest';
import { assetScopeItems, DEFAULT_ASSET_SCOPE, filterAutomationsByScope } from './asset-scopes';

describe('asset scopes', () => {
  const labels = { mine: 'Mine', shared: 'Shared', team: 'Team' };

  it('opens every role on the caller-owned scope', () => {
    expect(DEFAULT_ASSET_SCOPE).toBe('mine');
  });

  it('exposes Team only to super users', () => {
    expect(assetScopeItems(false, labels).map((item) => item.key)).toEqual(['mine', 'shared']);
    expect(assetScopeItems(true, labels).map((item) => item.key)).toEqual(['mine', 'shared', 'team']);
  });

  it('keeps owner-only Automations out of the Shared view', () => {
    const rows = [
      { id: 1, user_id: 'me' },
      { id: 2, user_id: 'other' },
    ];
    expect(filterAutomationsByScope(rows, 'me', 'mine').map((row) => row.id)).toEqual([1]);
    expect(filterAutomationsByScope(rows, 'me', 'shared')).toEqual([]);
    expect(filterAutomationsByScope(rows, 'me', 'team').map((row) => row.id)).toEqual([2]);
  });
});
