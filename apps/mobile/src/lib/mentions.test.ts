/**
 * The mention pieces every composer shares (./mentions.ts): which `@` token the caret
 * sits in, who matches it, what a pick writes (and where the caret lands), and how a
 * comment's picked people become `[@Name](user:<id>)` links and read back.
 */

import { describe, expect, it } from 'vitest';
import { parseMentions } from '../bots/vendor/mentions';
import { extractMentionIds } from '../shared/mentions';
import {
  applyMention,
  encodeMentions,
  mentionCandidates,
  mentionQuery,
  mentionsForDisplay,
  personToken,
  type MentionMember,
} from './mentions';

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
    expect(applyMention('@Sa', 0, 3, personToken('Sage'))).toEqual({ text: '@Sage ', caret: 6 });
    expect(applyMention('hi @fe', 3, 6, personToken('Fern'))).toEqual({ text: 'hi @Fern ', caret: 9 });
  });

  it('mid-text: keeps what follows, without doubling a space', () => {
    expect(applyMention('@Sa please look', 0, 3, personToken('Sage'))).toEqual({ text: '@Sage please look', caret: 6 });
    expect(applyMention('ask @卷 to', 4, 6, personToken('卷卷'))).toEqual({ text: 'ask @卷卷 to', caret: 8 });
  });

  it('what a pick writes parses back to the member', () => {
    const { text } = applyMention('@', 0, 1, personToken('卷卷'));
    expect(parseMentions(`${text}写一句诗`, MEMBERS)).toEqual(['b_juan']);
  });
});

describe('comment mentions', () => {
  const ADA: MentionMember = { id: 'u_ada', name: 'Ada' };
  const ADA_LEE: MentionMember = { id: 'u_lee', name: 'Ada Lee' };
  const LIN: MentionMember = { id: 'u_lin', name: '林小' };

  it('turns picked people still in the text into links, longest name first', () => {
    const sent = encodeMentions('@Ada Lee and @Ada, see @林小。 mail a@b.c', [ADA, ADA_LEE, LIN]);
    expect(sent).toBe('[@Ada Lee](user:u_lee) and [@Ada](user:u_ada), see [@林小](user:u_lin)。 mail a@b.c');
    expect(extractMentionIds(sent)).toEqual(['u_lee', 'u_ada', 'u_lin']);
  });

  it('leaves a typed @ alone when nobody was picked for it', () => {
    expect(encodeMentions('@Adam hi', [ADA])).toBe('@Adam hi');
    expect(encodeMentions('no mentions', [])).toBe('no mentions');
  });

  it('reads stored links back as bold names', () => {
    expect(mentionsForDisplay('hi [@Ada](user:u_ada)!')).toBe('hi **@Ada**!');
  });
});
