import { describe, expect, it } from 'vitest';
import { BOT_TEMPLATES } from './bots';
import { plantAvatarConfig } from './plant-avatar';
import { PLANT_LEGACY_COLOR, TEMPLATE_PLANT } from './plant-avatar';
import { avatarConfigSchema } from './profile-manifest';

describe('Bot template avatars', () => {
  it('each template is the plant it is named after', () => {
    expect(BOT_TEMPLATES.map((t) => [t.key, t.avatar.plant])).toEqual([
      ['chief', 'ivy'],
      ['researcher', 'sage'],
      ['operator', 'basil'],
      ['writer', 'fern'],
      ['analyst', 'clover'],
    ]);
    for (const template of BOT_TEMPLATES) expect(template.avatar.plant).toBe(TEMPLATE_PLANT[template.key]);
  });

  it('stores each resting face as faceStyle, dual-writes the nearest legacy colour, drops accessories', () => {
    expect(Object.fromEntries(BOT_TEMPLATES.map((t) => [t.key, t.avatar.faceStyle]))).toEqual({
      // Open eyes: soft ∩ arcs read as closed (asleep) at list sizes, and the chief is every member's first Bot.
      chief: 'default',
      researcher: 'default',
      operator: 'default',
      writer: 'sparkle', // bright eyes
      analyst: 'default',
    });
    for (const { avatar } of BOT_TEMPLATES) {
      expect(avatar.color).toBe(PLANT_LEGACY_COLOR[avatar.plant as keyof typeof PLANT_LEGACY_COLOR]);
      expect(avatar).not.toHaveProperty('accessories');
      // Moods are stored as faceStyle (like the web editors), never as a `mood` key.
      expect(avatar).not.toHaveProperty('mood');
      // What the API stores for a template copy is exactly the template avatar.
      expect(avatarConfigSchema.parse(avatar)).toEqual(avatar);
    }
  });
});

describe('plantAvatarConfig', () => {
  it('writes the species, the nearest legacy colour and, when given, the resting face', () => {
    expect(plantAvatarConfig('maple')).toEqual({ plant: 'maple', color: 'autumn' });
    expect(plantAvatarConfig('lotus', 'drowsy')).toEqual({ plant: 'lotus', color: 'blossom', faceStyle: 'sleepy' });
  });
});
