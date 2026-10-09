import { describe, expect, it } from 'vitest';
import { PLANT_IDS, PLANT_MOODS, TEMPLATE_PLANT, type PlantId } from '@greenhouse/types';
import { legacyToMood, legacyToPlant } from '@greenhouse/types';
import { MOOD_FACE_STYLE, withMood, withPlant } from '@greenhouse/types';
import { botPlant, freshPlant, profilePlant } from './plant-avatar';

describe('withPlant', () => {
  it('writes the species and its nearest legacy colour, keeping every other key', () => {
    const stored = {
      color: 'forest',
      accessories: ['clipboard'],
      eyeStyle: 'soft',
      palette: { body: '#000000', leaf: '#111111' },
    };
    expect(withPlant(stored, 'echeveria')).toEqual({ ...stored, plant: 'echeveria', color: 'ocean' });
    expect(withPlant({}, 'maple')).toEqual({ plant: 'maple', color: 'autumn' });
  });

  it('round-trips through the resolver for every species', () => {
    for (const plant of PLANT_IDS)
      expect(legacyToPlant(withPlant({ color: 'midnight' }, plant), null, 'x')).toBe(plant);
  });
});

describe('withMood', () => {
  it('stores the mood as the legacy faceStyle and drops a mood key that would override it', () => {
    expect(withMood({ plant: 'ivy', mood: 'drowsy', faceStyle: 'sleepy' }, 'bright')).toEqual({
      plant: 'ivy',
      faceStyle: 'sparkle',
    });
  });

  it('round-trips through legacyToMood for every mood, even over a stale eyeStyle', () => {
    for (const mood of PLANT_MOODS) {
      expect(MOOD_FACE_STYLE[mood]).toBeTruthy();
      expect(legacyToMood(withMood({ eyeStyle: 'focused', mood: 'drowsy' }, mood))).toBe(mood);
    }
  });
});

describe('freshPlant', () => {
  it('picks the first species no sibling wears, leaving the template plants for last', () => {
    const templates: PlantId[] = Object.values(TEMPLATE_PLANT);
    expect(freshPlant([])).toBe('sage');
    expect(freshPlant(templates)).toBe('sage');
    expect(freshPlant(['sage', 'basil'])).toBe('monstera');
    const nonTemplate = PLANT_IDS.filter((plant) => plant !== 'sprout' && !templates.includes(plant));
    expect(nonTemplate).toEqual(['sage', 'basil', 'monstera', 'ginkgo', 'echeveria', 'lotus', 'eucalyptus']);
    expect(freshPlant(nonTemplate)).toBe('ivy');
    expect(freshPlant([...nonTemplate, 'ivy'])).toBe('fern');
    expect(freshPlant(['sage', 'basil', 'monstera', 'ginkgo'])).toBe('echeveria'); // maple is 枫枫's
    expect(freshPlant(['sprout'])).not.toBe('sprout');
  });

  it('hands out every free species, then the template plants in catalogue order', () => {
    const picks: PlantId[] = [];
    for (let i = 0; i < PLANT_IDS.length - 1; i += 1) picks.push(freshPlant(picks));
    expect(picks).toEqual([
      'sage',
      'basil',
      'monstera',
      'ginkgo',
      'echeveria',
      'lotus',
      'eucalyptus',
      'ivy',
      'fern',
      'clover',
      'maple',
      'opuntia',
      'lavender',
      'sunflower',
      'dandelion',
    ]);
  });

  it('cycles once every species is taken, never onto the sprout', () => {
    const all = PLANT_IDS.filter((plant) => plant !== 'sprout');
    expect(all).toContain(freshPlant(all));
    expect(freshPlant([...PLANT_IDS])).not.toBe('sprout');
  });
});

describe('profilePlant / botPlant', () => {
  it('renders the built-in Sprouty (and no profile at all) as the sprout', () => {
    expect(profilePlant({ id: 'sprouty' })).toBe('sprout');
    expect(profilePlant(undefined)).toBe('sprout');
    expect(profilePlant({ id: '' })).toBe('sprout');
  });

  it('keys legacy custom Agents by their custom:<id>, and never lands on sprout implicitly', () => {
    const avatar = { color: 'forest', leafStyle: 'normal' };
    expect(profilePlant({ id: 'custom:5', avatar })).toBe(legacyToPlant(avatar, null, 'custom:5'));
    expect(profilePlant({ id: 'custom:5', avatar: { color: 'ocean' } })).toBe('echeveria');
    for (let i = 0; i < 50; i += 1) expect(profilePlant({ id: `custom:${i}`, avatar: {} })).not.toBe('sprout');
  });

  it('resolves a Bot by stored plant, then its template, then its id', () => {
    expect(botPlant({ id: 'bot_1', avatar: { plant: 'lotus' }, template_key: 'chief' })).toBe('lotus');
    expect(botPlant({ id: 'bot_1', avatar: { color: 'ocean' }, template_key: 'chief' })).toBe('ivy');
    expect(botPlant({ id: 'bot_1', avatar: {}, template_key: null })).toBe(legacyToPlant({}, null, 'bot_1'));
  });
});
