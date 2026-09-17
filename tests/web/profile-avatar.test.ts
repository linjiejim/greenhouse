import { describe, expect, it } from 'vitest';
import type { Profile } from '@greenhouse/types/api';
import { profileToSprouty } from '../../apps/web/src/components/chat/profile-avatar.js';

function profile(id: string, extra: Partial<Profile> = {}): Profile {
  return { id, name: id, tools: [], ...extra };
}

describe('profileToSprouty', () => {
  it('keeps the team system avatar and treats removed presets as ordinary legacy ids', () => {
    expect(profileToSprouty(profile('team'))).toEqual({ variant: 'team' });
    expect(profileToSprouty(profile('researcher'))).toEqual({ variant: 'default' });
  });

  it('preserves generic custom avatar appearance fields', () => {
    const custom = profile('custom:1', {
      is_custom: true,
      avatar: {
        color: 'ocean',
        accessories: ['round-glasses', 'magnifier'],
        leafStyle: 'big',
        eyeStyle: 'soft',
      },
    });

    expect(profileToSprouty(custom)).toEqual({
      variant: 'custom',
      color: 'ocean',
      accessories: ['round-glasses', 'magnifier'],
      leafStyle: 'big',
      eyeStyle: 'soft',
    });
  });
});
