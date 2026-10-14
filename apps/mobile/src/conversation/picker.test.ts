import { describe, expect, it } from 'vitest';
import { applyMention, dropSlash, dropToken, matching, mentionQuery, namedMentions, slashQuery } from './picker';

describe('the @ token', () => {
  it('opens after the start, a space or an opening bracket, and closes at a space', () => {
    expect(mentionQuery('@', 1)).toEqual({ query: '', start: 0 });
    expect(mentionQuery('ask @sa', 7)).toEqual({ query: 'sa', start: 4 });
    expect(mentionQuery('问（@小', 4)).toEqual({ query: '小', start: 2 });
    expect(mentionQuery('mail me@example', 15)).toBeNull();
    expect(mentionQuery('@sage now', 9)).toBeNull();
    // the caret decides, not the end of the text
    expect(mentionQuery('@sa and more', 3)).toEqual({ query: 'sa', start: 0 });
  });

  it('becomes "@Name " when picked, and counts only while the name is still in the text', () => {
    expect(applyMention('hi @sa there', 3, 6, 'Sage')).toEqual({ text: 'hi @Sage there', caret: 9 });
    expect(dropToken('hi @sa there', 3, 6)).toBe('hi there');
    const picked = [
      { handle: 'agent:1', name: 'Sage' },
      { handle: 'ana', name: 'Ana' },
      { handle: 'agent:1', name: 'Sage' },
    ];
    expect(namedMentions('@Sage and @Sage, thanks', picked)).toEqual(['agent:1']);
    expect(namedMentions('nobody', picked)).toEqual([]);
  });
});

describe('the / token', () => {
  it('only at the very start of the message', () => {
    expect(slashQuery('/', 1)).toBe('');
    expect(slashQuery('/week', 5)).toBe('week');
    expect(slashQuery('say /week', 9)).toBeNull();
    expect(slashQuery('/week report', 12)).toBeNull();
    expect(dropSlash('/weekly sales by region')).toBe('sales by region');
    expect(dropSlash('/weekly')).toBe('');
  });
});

describe('matching', () => {
  it('finds by name or hint, case-insensitive, in the order given, at most eight', () => {
    const list = [
      { name: 'Sage', hint: 'research' },
      { name: 'Basil', hint: 'Sales' },
      { name: 'Ivy' },
    ];
    expect(matching(list, 'sa').map((item) => item.name)).toEqual(['Sage', 'Basil']);
    expect(matching(list, '').map((item) => item.name)).toEqual(['Sage', 'Basil', 'Ivy']);
    expect(matching(Array.from({ length: 12 }, (_, i) => ({ name: `A${i}` })), 'a')).toHaveLength(8);
  });
});
