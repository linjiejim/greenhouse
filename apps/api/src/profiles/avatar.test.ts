import { describe, expect, it } from 'vitest';
import { normalizeProfileAvatar } from './avatar.js';

describe('normalizeProfileAvatar', () => {
  it('keeps the plant, the mood and the palette next to every legacy key', () => {
    const avatar = {
      plant: 'lotus',
      mood: 'soft',
      color: 'blossom',
      accessories: ['pencil'],
      leafStyle: 'double',
      eyeStyle: 'soft',
      faceStyle: 'happy',
      palette: { body: '#E57FA4', leaf: '#5DAE45' },
    };
    expect(normalizeProfileAvatar(avatar)).toEqual(avatar);
  });

  it('drops unknown keys, and judges each key alone so one bad value never costs the plant', () => {
    expect(
      normalizeProfileAvatar({
        plant: 'maple',
        model: 'gpt',
        mood: 'x'.repeat(41),
        color: 42,
        palette: { body: 'red', leaf: '#5DAE45' },
        leafStyle: 'huge',
        eyeStyle: 'laser',
        accessories: ['crown', 7, 'x'.repeat(41)],
      }),
    ).toEqual({ plant: 'maple', accessories: ['crown'] });
  });

  it('keeps unknown plant ids (forks may add species; the renderer falls back) within the length bound', () => {
    expect(normalizeProfileAvatar({ plant: 'cultivar-x' })).toEqual({ plant: 'cultivar-x' });
    expect(normalizeProfileAvatar({ plant: 'x'.repeat(41) })).toEqual({});
  });

  it('reads anything stored: non-objects become {}, a palette loses its extra keys, accessories are capped', () => {
    for (const raw of [null, undefined, 'ivy', 3, ['ivy']]) expect(normalizeProfileAvatar(raw)).toEqual({});
    expect(normalizeProfileAvatar({ palette: { body: '#000000', leaf: '#FFFFFF', rim: '#123456' } })).toEqual({
      palette: { body: '#000000', leaf: '#FFFFFF' },
    });
    const many = Array.from({ length: 12 }, (_, i) => `a${i}`);
    expect(normalizeProfileAvatar({ accessories: many }).accessories).toEqual(many.slice(0, 10));
  });
});
