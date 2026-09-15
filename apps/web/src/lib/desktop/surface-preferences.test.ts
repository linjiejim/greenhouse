import { describe, expect, it } from 'vitest';
import {
  parseDesktopSurfacePreferences,
  resolveDirectSurfaceProfile,
  resolveSurfaceProfiles,
} from './surface-preferences';

describe('desktop surface preferences', () => {
  it('fails closed for malformed storage and removes duplicate or invalid ids', () => {
    expect(parseDesktopSurfacePreferences('{')).toEqual({
      version: 1,
      selectionProfileIds: [],
      quickProfileIds: [],
    });
    expect(
      parseDesktopSurfacePreferences(
        JSON.stringify({ selectionProfileIds: ['team', 'team', 2, ''], quickProfileIds: ['custom'] }),
      ),
    ).toEqual({ version: 1, selectionProfileIds: ['team'], quickProfileIds: ['custom'] });
  });

  it('uses configured order, then preferred, team and first profile as fallbacks', () => {
    const profiles = [
      { id: 'team', name: 'Team' },
      { id: 'writer', name: 'Writer' },
    ];
    expect(resolveSurfaceProfiles(profiles, ['missing', 'writer'], 'team').map((item) => item.id)).toEqual(['writer']);
    expect(resolveSurfaceProfiles(profiles, [], 'writer').map((item) => item.id)).toEqual(['writer']);
    expect(resolveSurfaceProfiles(profiles, [], 'missing').map((item) => item.id)).toEqual(['team']);
    expect(resolveSurfaceProfiles([{ id: 'only', name: 'Only' }], [], null).map((item) => item.id)).toEqual(['only']);
  });

  it('skips the Profile picker only when exactly one Profile is available', () => {
    const only = { id: 'team', name: 'Team' };
    expect(resolveDirectSurfaceProfile([only])).toBe(only);
    expect(resolveDirectSurfaceProfile([])).toBeUndefined();
    expect(resolveDirectSurfaceProfile([only, { id: 'writer', name: 'Writer' }])).toBeUndefined();
  });
});
