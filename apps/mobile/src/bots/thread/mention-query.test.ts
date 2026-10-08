/**
 * The mention picker's pure pieces (./mention-query.ts): which `@` token the caret sits
 * in, who matches it, and what a pick writes (and where the caret lands).
 */

import { describe, expect, it } from 'vitest';
import { parseMentions } from '../vendor/mentions';
import { applyMention, mentionCandidates, mentionQuery, type MentionMember } from './mention-query';

const SAGE: MentionMember = { id: 'b_sage', name: 'Sage', role: 'Researcher' };
const FERN: MentionMember = { id: 'b_fern', name: 'Fern', role: 'Writer' };
const JUAN: MentionMember = { id: 'b_juan', name: '卷卷', role: '写手' };
const MEMBERS = [SAGE, FERN, JUAN];

describe('mentionQuery', () => {
  it('reads the token before the caret: at the start, after a space or an opener', () => {
    expect(mentionQuery('@', 1)).toEqual({ query: '', start: 0 });
    expect(mentionQuery('@Sa', 3)).toEqual({ query: 'Sa', start: 0 });
    expect(mentionQuery('hi @fe', 6)).toEqual({ query: 'fe', start: 3 });
    expect(mentionQuery('（@卷', 3)).toEqual({ query: '卷', start: 1 });
    expect(mentionQuery('“@S', 3)).toEqual({ query: 'S', start: 1 });
  });

  it('CJK right after the @, and a token in the middle of the text (caret, not the end)', () => {
    expect(mentionQuery('请 @卷卷', 5)).toEqual({ query: '卷卷', start: 2 });
    expect(mentionQuery('@Sa and more', 3)).toEqual({ query: 'Sa', start: 0 });
  });

  it('no token: an e-mail, a finished mention, too long, or no @ at all', () => {
    expect(mentionQuery('mail a@b', 8)).toBeNull();
    expect(mentionQuery('@Sage ', 6)).toBeNull();
    expect(mentionQuery(`@${'x'.repeat(25)}`, 26)).toBeNull();
    expect(mentionQuery('hello', 5)).toBeNull();
    expect(mentionQuery('', 0)).toBeNull();
  });

  it('a caret past the end reads the whole text', () => {
    expect(mentionQuery('@Fe', 99)).toEqual({ query: 'Fe', start: 0 });
  });
});

describe('mentionCandidates', () => {
  it('everyone for a bare @, in the order given', () => {
    expect(mentionCandidates(MEMBERS, '')).toEqual(MEMBERS);
  });

  it('name or role, case-insensitive, CJK included', () => {
    expect(mentionCandidates(MEMBERS, 'sa')).toEqual([SAGE]);
    expect(mentionCandidates(MEMBERS, 'WRI')).toEqual([FERN]);
    expect(mentionCandidates(MEMBERS, '卷')).toEqual([JUAN]);
    expect(mentionCandidates(MEMBERS, '写')).toEqual([JUAN]);
  });

  it('no match → nobody (the strip stays hidden and Send stays Send)', () => {
    expect(mentionCandidates(MEMBERS, 'zz')).toEqual([]);
  });
});

describe('applyMention', () => {
  it('replaces the token with "@Name " and puts the caret after it', () => {
    expect(applyMention('@Sa', 0, 3, 'Sage')).toEqual({ text: '@Sage ', caret: 6 });
    expect(applyMention('hi @fe', 3, 6, 'Fern')).toEqual({ text: 'hi @Fern ', caret: 9 });
  });

  it('mid-text: keeps what follows, without doubling a space', () => {
    expect(applyMention('@Sa please look', 0, 3, 'Sage')).toEqual({ text: '@Sage please look', caret: 6 });
    expect(applyMention('ask @卷 to', 4, 6, '卷卷')).toEqual({ text: 'ask @卷卷 to', caret: 8 });
  });

  it('what a pick writes parses back to the member', () => {
    const { text } = applyMention('@', 0, 1, '卷卷');
    expect(parseMentions(`${text}写一句诗`, MEMBERS)).toEqual(['b_juan']);
  });
});
