import { describe, expect, it } from 'vitest';
import { parseMentions } from './mentions';

const members = [
  { id: 'bot_ivy', name: 'Ivy' },
  { id: 'bot_sage', name: 'Sage' },
  { id: 'bot_fern', name: '小文' },
  { id: 'bot_sage2', name: 'Sage Two' },
];

describe('parseMentions', () => {
  it('finds @Name tokens in order without duplicates', () => {
    expect(parseMentions('@Sage find it, then @Ivy plan it. @Sage again', members)).toEqual(['bot_sage', 'bot_ivy']);
  });

  it('treats a leading name with a comma or colon as an address', () => {
    expect(parseMentions('Ivy, plan my week', members)).toEqual(['bot_ivy']);
    expect(parseMentions('小文：润色一下这段', members)).toEqual(['bot_fern']);
    expect(parseMentions('  sage: compare prices', members)).toEqual(['bot_sage']);
  });

  it('does not treat a name used in a sentence as an address', () => {
    expect(parseMentions('Ivy league schools', members)).toEqual([]);
    expect(parseMentions('Tell Sage, please', members)).toEqual([]);
  });

  it('prefers the longest matching name', () => {
    expect(parseMentions('@Sage Two what do you think', members)).toEqual(['bot_sage2']);
    expect(parseMentions('Sage Two: go', members)).toEqual(['bot_sage2']);
  });

  it('ignores e-mail addresses and partial names', () => {
    expect(parseMentions('mail me at jim@Sage.com', members)).toEqual([]);
    expect(parseMentions('@Sagebrush is a plant', members)).toEqual([]);
  });

  it('accepts CJK punctuation after a mention', () => {
    expect(parseMentions('请 @小文，帮我改一下', members)).toEqual(['bot_fern']);
  });

  it('orders a leading address before later mentions', () => {
    expect(parseMentions('Ivy, ask @Sage to help', members)).toEqual(['bot_ivy', 'bot_sage']);
  });
});
