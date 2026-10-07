import { describe, expect, it } from 'vitest';
import { BOT_TEMPLATES, SPROUTY_BOT_TEMPLATE, botTemplate, galleryTemplate, isSproutyBot } from './bots';
import { plantAvatarConfig } from './plant-avatar';
import { PLANT_LEGACY_COLOR, TEMPLATE_PLANT } from './plant-avatar';
import { avatarConfigSchema } from './profile-manifest';

describe('Bot template avatars', () => {
  it('each template is the plant it is named after', () => {
    expect(BOT_TEMPLATES.map((t) => [t.key, t.avatar.plant])).toEqual([
      ['researcher', 'dandelion'],
      ['operator', 'opuntia'],
      ['writer', 'fern'],
      ['analyst', 'clover'],
    ]);
    for (const template of [SPROUTY_BOT_TEMPLATE, ...BOT_TEMPLATES])
      expect(template.avatar.plant).toBe(TEMPLATE_PLANT[template.key]);
  });

  it('names each template after its plant, in both languages', () => {
    expect(BOT_TEMPLATES.map((t) => [t.copy.zh.name, t.copy.en.name])).toEqual([
      ['蒲蒲', 'Dandy'],
      ['仙仙', 'Cactus'],
      ['卷卷', 'Fern'],
      ['叶叶', 'Clover'],
    ]);
  });

  it('stores each resting face as faceStyle, dual-writes the nearest legacy colour, drops accessories', () => {
    expect(Object.fromEntries(BOT_TEMPLATES.map((t) => [t.key, t.avatar.faceStyle]))).toEqual({
      // Open eyes: soft ∩ arcs read as closed (asleep) at list sizes.
      researcher: 'default',
      operator: 'default',
      writer: 'sparkle', // bright eyes
      analyst: 'default',
    });
    for (const { avatar } of [SPROUTY_BOT_TEMPLATE, ...BOT_TEMPLATES]) {
      expect(avatar.color).toBe(PLANT_LEGACY_COLOR[avatar.plant as keyof typeof PLANT_LEGACY_COLOR]);
      expect(avatar).not.toHaveProperty('accessories');
      // Moods are stored as faceStyle (like the web editors), never as a `mood` key.
      expect(avatar).not.toHaveProperty('mood');
      // What the API stores for a template copy is exactly the template avatar.
      expect(avatarConfigSchema.parse(avatar)).toEqual(avatar);
    }
  });
});

describe('Sprouty, the built-in main Bot', () => {
  it('is the sprout, called Sprouty in both languages, and never offered in the gallery', () => {
    expect(SPROUTY_BOT_TEMPLATE.key).toBe('sprouty');
    expect(SPROUTY_BOT_TEMPLATE.avatar).toEqual({ plant: 'sprout', color: 'forest', faceStyle: 'default' });
    expect([SPROUTY_BOT_TEMPLATE.copy.zh.name, SPROUTY_BOT_TEMPLATE.copy.en.name]).toEqual(['Sprouty', 'Sprouty']);
    expect([SPROUTY_BOT_TEMPLATE.copy.zh.role, SPROUTY_BOT_TEMPLATE.copy.en.role]).toEqual([
      '主助手',
      'Main assistant',
    ]);
    expect(BOT_TEMPLATES.map((t) => t.key)).not.toContain('sprouty');
    expect(galleryTemplate('sprouty')).toBeUndefined();
    expect(botTemplate('sprouty')).toBe(SPROUTY_BOT_TEMPLATE);
    expect(isSproutyBot({ template_key: 'sprouty' })).toBe(true);
    expect(isSproutyBot({ template_key: 'chief' })).toBe(false);
    expect(isSproutyBot(null)).toBe(false);
  });

  it('took over from the chief of staff: chief Bots keep their template, nobody creates new ones', () => {
    expect(botTemplate('chief')?.copy.zh.name).toBe('藤藤');
    expect(galleryTemplate('chief')).toBeUndefined();
    expect(galleryTemplate('writer')?.key).toBe('writer');
  });
});

describe('plantAvatarConfig', () => {
  it('writes the species, the nearest legacy colour and, when given, the resting face', () => {
    expect(plantAvatarConfig('maple')).toEqual({ plant: 'maple', color: 'autumn' });
    expect(plantAvatarConfig('lotus', 'drowsy')).toEqual({ plant: 'lotus', color: 'blossom', faceStyle: 'sleepy' });
  });
});
