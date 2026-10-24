import { describe, expect, it } from 'vitest';
import type { Profile } from '@greenhouse/types/api';
import { legacyToPlant } from '@greenhouse/types';
import { profileAvatarProps } from '../../apps/web/src/components/chat/profile-selector.js';

function profile(id: string, extra: Partial<Profile> = {}): Profile {
  return { id, name: id, tools: [], ...extra };
}

describe('profileAvatarProps', () => {
  it('gives system profiles no stored avatar: sprouty is the sprout, others a stable pick', () => {
    expect(profileAvatarProps(profile('sprouty'))).toEqual({ avatar: null, stableId: 'sprouty' });
    const { avatar, stableId } = profileAvatarProps(profile('researcher'));
    expect(legacyToPlant(avatar, null, 'sprouty')).toBe('sprout');
    expect(legacyToPlant(avatar, null, stableId)).not.toBe('sprout');
  });

  it('passes a custom Agent its stored avatar untouched, legacy keys included', () => {
    const stored = { color: 'ocean', accessories: ['round-glasses', 'magnifier'], leafStyle: 'big' as const };
    const custom = profile('custom:1', { is_custom: true, avatar: stored });
    expect(profileAvatarProps(custom)).toEqual({ avatar: stored, stableId: 'custom:1' });
    // ocean + magnifier is the old researcher template's fingerprint → sage, as every list draws it.
    expect(legacyToPlant(stored, null, 'custom:1')).toBe('sage');
    expect(profileAvatarProps(profile('custom:2', { is_custom: true }))).toEqual({ avatar: {}, stableId: 'custom:2' });
  });
});
