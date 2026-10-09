import { describe, expect, it } from 'vitest';
import { matchesProfile, profileQuery, profileRefs } from './profile-refs';

describe('profileRefs / matchesProfile', () => {
  it('a Bot is its id and any pinned version of it — never a longer id', () => {
    const refs = profileRefs({ id: 'bot_ab', main: false });
    expect(matchesProfile('bot:bot_ab', refs)).toBe(true);
    expect(matchesProfile('bot:bot_ab@3', refs)).toBe(true);
    expect(matchesProfile('bot:bot_abc', refs)).toBe(false);
    expect(matchesProfile('sprouty', refs)).toBe(false);
  });

  it('the main Bot is sprouty, the retired ids folded into it, and its own bot id', () => {
    const refs = profileRefs({ id: 'bot_main', main: true });
    for (const id of ['sprouty', 'team', 'default', 'sprouty-quick', 'bot:bot_main', 'bot:bot_main@2']) {
      expect(matchesProfile(id, refs)).toBe(true);
    }
    expect(matchesProfile('bot:bot_other', refs)).toBe(false);
  });

  it('asks the server for the main Bot by its preset id', () => {
    expect(profileQuery({ id: 'bot_main', main: true })).toBe('sprouty');
    expect(profileQuery({ id: 'bot_ab', main: false })).toBe('bot:bot_ab');
  });
});
