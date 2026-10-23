import { describe, expect, it } from 'vitest';
import type { Profile } from '@greenhouse/types/api';
import { automationProfileChoices, pinnedProfileVersion, unpinnedProfileId } from './automation-profiles';

const profile = (over: Partial<Profile>) => ({ id: 'sprouty', name: 'Sprouty', tools: [], ...over }) as Profile;

describe('automationProfileChoices', () => {
  it('offers system profiles, my run profiles and team-shared ones — not a teammate’s private one', () => {
    const choices = automationProfileChoices(
      [
        profile({ id: 'sprouty' }),
        profile({ id: 'custom:1', is_custom: true, user_id: 'me' }),
        profile({ id: 'custom:2', is_custom: true, user_id: 'bob', is_shared: true }),
        profile({ id: 'custom:3', is_custom: true, user_id: 'bob', is_shared: false }),
      ],
      'me',
    );
    expect(choices.system.map((p) => p.id)).toEqual(['sprouty']);
    expect(choices.runProfiles.map((p) => p.id)).toEqual(['custom:1', 'custom:2']);
  });

  it('reads and strips the version a stored run profile is pinned to', () => {
    expect(unpinnedProfileId('custom:5@3')).toBe('custom:5');
    expect(unpinnedProfileId('sprouty')).toBe('sprouty');
    expect(pinnedProfileVersion('custom:5@3')).toBe(3);
    expect(pinnedProfileVersion('custom:5')).toBeNull();
  });
});
