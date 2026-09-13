/**
 * Localized profile copy — YAML display strings may be a plain string or a
 * `{ zh, en }` map. The flat field must always stay the source-locale value so
 * existing consumers (logs, admin views, external API) are unaffected.
 */

import { describe, expect, it } from 'vitest';
import { loadProfile, validateProfile } from './profile.js';

const base = {
  id: 'fixture',
  model: { id: 'flash' },
  tools: [],
  system_prompt: 'you are a fixture',
};

describe('profile display copy', () => {
  it('keeps plain strings flat with no locale map', () => {
    const p = validateProfile({ ...base, name: 'Fixture', description: 'plain' }, 'fixture');

    expect(p.name).toBe('Fixture');
    expect(p.description).toBe('plain');
    expect(p.name_i18n).toBeUndefined();
    expect(p.description_i18n).toBeUndefined();
  });

  it('flattens a locale map to the source locale and keeps the map', () => {
    const p = validateProfile(
      {
        ...base,
        name: { zh: '助手', en: 'Assistant' },
        description: { zh: '中文描述', en: 'English description' },
      },
      'fixture',
    );

    expect(p.name).toBe('助手');
    expect(p.description).toBe('中文描述');
    expect(p.name_i18n).toEqual({ zh: '助手', en: 'Assistant' });
    expect(p.description_i18n).toEqual({ zh: '中文描述', en: 'English description' });
  });

  it('falls back to any declared locale when the source locale is absent', () => {
    const p = validateProfile({ ...base, name: { en: 'English only' } }, 'fixture');

    expect(p.name).toBe('English only');
    expect(p.name_i18n).toEqual({ en: 'English only' });
  });

  it('localizes model choice labels', () => {
    const p = validateProfile({ ...base, name: { zh: '助手', en: 'Assistant' }, model: { id: 'flash' } }, 'fixture');

    expect(p).toMatchObject({ name: '助手', name_i18n: { zh: '助手', en: 'Assistant' } });
  });

  // Fail closed: a typo like `cn:` would otherwise silently ship untranslated copy.
  it('rejects unsupported locale keys', () => {
    expect(() => validateProfile({ ...base, name: { cn: '助手' } }, 'fixture')).toThrow(/unsupported locale "cn"/);
  });

  it('rejects empty and non-string locale values', () => {
    expect(() => validateProfile({ ...base, name: { zh: '  ' } }, 'fixture')).toThrow(/non-empty string/);
    expect(() => validateProfile({ ...base, name: { zh: 42 } }, 'fixture')).toThrow(/non-empty string/);
  });

  it('rejects a list where a string or locale map is expected', () => {
    expect(() => validateProfile({ ...base, name: ['a'] }, 'fixture')).toThrow(/string or a locale map/);
  });

  it('still requires a name', () => {
    expect(() => validateProfile({ ...base }, 'fixture')).toThrow(/missing required field: name/);
  });
});

describe('shipped profiles', () => {
  it('sprouty declares English copy for every user-facing string', () => {
    const p = loadProfile('sprouty');

    expect(p.description_i18n?.en).toBeTruthy();
  });

  it('eval-judge declares English copy for every user-facing string', () => {
    const p = loadProfile('eval-judge');

    expect(p.name_i18n?.en).toBeTruthy();
    expect(p.description_i18n?.en).toBeTruthy();
  });
});
