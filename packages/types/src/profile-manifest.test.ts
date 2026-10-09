import { describe, expect, it } from 'vitest';
import { avatarConfigSchema } from './profile-manifest';

describe('avatarConfigSchema', () => {
  it('keeps the plant, the mood and the legacy eyeStyle (they used to be stripped)', () => {
    const parsed = avatarConfigSchema.parse({ plant: 'maple', mood: 'soft', eyeStyle: 'focused', color: 'autumn' });
    expect(parsed).toEqual({ plant: 'maple', mood: 'soft', eyeStyle: 'focused', color: 'autumn' });
  });

  it('keeps the colour (tint), bounded like every other id', () => {
    expect(avatarConfigSchema.parse({ plant: 'fern', tint: 'rose' })).toEqual({ plant: 'fern', tint: 'rose' });
    expect(avatarConfigSchema.safeParse({ tint: 'x'.repeat(41) }).success).toBe(false);
  });

  it('stays permissive about ids (forks, legacy rows) but bounds their length', () => {
    expect(avatarConfigSchema.parse({ plant: 'cultivar-x' }).plant).toBe('cultivar-x');
    expect(avatarConfigSchema.safeParse({ plant: 'x'.repeat(41) }).success).toBe(false);
    expect(avatarConfigSchema.safeParse({ mood: 'x'.repeat(41) }).success).toBe(false);
  });

  it('still strips unknown keys', () => {
    expect(avatarConfigSchema.parse({ plant: 'ivy', model: 'gpt', accessories: ['crown'] })).toEqual({
      plant: 'ivy',
      accessories: ['crown'],
    });
  });
});
