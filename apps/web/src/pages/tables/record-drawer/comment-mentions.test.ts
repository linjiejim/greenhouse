import { describe, expect, it } from 'vitest';
import { extractMentionIds } from '@greenhouse/utils/mentions';
import { commentToDraft, draftToComment, mentionCandidates } from './comment-mentions';

const ann = { id: 'u-ann', name: 'Ann' };
const annLee = { id: 'u-ann-lee', name: 'Ann Lee' };
const zhang = { id: 'u-z', name: '张三' };

describe('draftToComment', () => {
  it('links the tokens of picked people and nothing else', () => {
    expect(draftToComment('@Ann please check, cc @Bob', [ann])).toBe('[@Ann](user:u-ann) please check, cc @Bob');
  });

  it('prefers the longest picked name and respects token boundaries', () => {
    const out = draftToComment('@Ann Lee and @Ann, not @Annette or mail@Ann', [ann, annLee]);
    expect(out).toBe('[@Ann Lee](user:u-ann-lee) and [@Ann](user:u-ann), not @Annette or mail@Ann');
    expect(extractMentionIds(out)).toEqual(['u-ann-lee', 'u-ann']);
  });

  it('handles CJK names and punctuation', () => {
    expect(draftToComment('（@张三）看一下，@张三。', [zhang])).toBe(
      '（[@张三](user:u-z)）看一下，[@张三](user:u-z)。',
    );
  });

  it('leaves text without picks untouched', () => {
    expect(draftToComment('**bold** @someone', [])).toBe('**bold** @someone');
  });
});

describe('commentToDraft', () => {
  it('turns stored links back into tokens and remembers who they are', () => {
    const stored = 'hi [@Ann Lee](user:u-ann-lee) and [@Ann](user:u-ann), again [@Ann](user:u-ann)';
    const draft = commentToDraft(stored);
    expect(draft.text).toBe('hi @Ann Lee and @Ann, again @Ann');
    expect(draft.picked).toEqual([annLee, ann]);
    // Round trip: editing and saving without changes stores the same Markdown.
    expect(draftToComment(draft.text, draft.picked)).toBe(stored);
  });
});

describe('mentionCandidates', () => {
  const users = [
    { id: '1', nickname: 'Bob', email: 'bob@x.test' },
    { id: '2', nickname: 'Annette', email: 'annette@x.test' },
    { id: '3', nickname: 'Joanna', email: 'jo@x.test' },
    { id: '4', nickname: 'Zed', email: 'ann.z@x.test' },
  ];

  it('ranks prefix, then substring, then e-mail matches', () => {
    expect(mentionCandidates(users, 'ann').map((user) => user.id)).toEqual(['2', '3', '4']);
  });

  it('offers everyone (capped) for an empty query', () => {
    expect(mentionCandidates(users, '', 2).map((user) => user.id)).toEqual(['1', '2']);
  });
});
