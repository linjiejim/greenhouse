import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLANT_LEGACY_COLOR, isPlantId } from '@greenhouse/types';
import { SPROUTY_FACE_STYLE_IDS, avatarConfigSchema } from '@greenhouse/types/profile-manifest';
import { DATA_DIR } from '../../paths.js';
import { readJsonl } from './seed.js';

describe('example dataset', () => {
  it('seeds Bots with a plant avatar written the way the editors write it', () => {
    const rows = readJsonl(resolve(DATA_DIR, 'examples', 'bots.json'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const avatar = row.avatar as Record<string, unknown>;
      // Nothing the schema would strip, a known species, its nearest legacy colour, the mood as faceStyle.
      expect(avatarConfigSchema.parse(avatar)).toEqual(avatar);
      expect(isPlantId(avatar.plant), String(row.name)).toBe(true);
      expect(avatar.color).toBe(PLANT_LEGACY_COLOR[avatar.plant as keyof typeof PLANT_LEGACY_COLOR]);
      if (avatar.faceStyle !== undefined) expect(SPROUTY_FACE_STYLE_IDS).toContain(avatar.faceStyle);
      expect(avatar).not.toHaveProperty('mood');
    }
  });
});
