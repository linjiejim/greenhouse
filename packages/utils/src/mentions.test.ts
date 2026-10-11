import { describe, expect, it } from 'vitest';
import { extractMentionIds, findMentionLinks, mentionMarkdown, mentionsToPlainText } from './mentions';

describe('extractMentionIds', () => {
  it('returns each mentioned id once, in first-occurrence order', () => {
    const body = 'Hi [@Ann](user:u-ann) and [@Bo](user:u-bo), again [@Ann](user:u-ann).';
    expect(extractMentionIds(body)).toEqual(['u-ann', 'u-bo']);
  });

  it('ignores ordinary links and empty targets', () => {
    expect(extractMentionIds('[docs](https://example.com) (user:) [@x](user: )')).toEqual([]);
  });

  it('keeps the knowledge-base behaviour: any `(user:<id>)` target counts', () => {
    expect(extractMentionIds('see (user:u-1)')).toEqual(['u-1']);
  });
});

describe('mentionMarkdown', () => {
  it('builds the link the parser reads back', () => {
    const link = mentionMarkdown('Ann Lee', 'u-ann');
    expect(link).toBe('[@Ann Lee](user:u-ann)');
    expect(extractMentionIds(link)).toEqual(['u-ann']);
  });

  it('strips characters that would break out of the label', () => {
    expect(mentionMarkdown('a](user:evil) [b', 'u-1')).toBe('[@auser:evil b](user:u-1)');
    expect(extractMentionIds(mentionMarkdown('x)(user:evil', 'u-1'))).toEqual(['u-1']);
  });

  it('falls back to the id when the name is empty after cleaning', () => {
    expect(mentionMarkdown('[]', 'u-1')).toBe('[@u-1](user:u-1)');
  });
});

describe('mentionsToPlainText / findMentionLinks', () => {
  it('turns links into @Name and leaves other Markdown alone', () => {
    expect(mentionsToPlainText('**Hey** [@Ann](user:u-ann), see [x](https://x.test)')).toBe(
      '**Hey** @Ann, see [x](https://x.test)',
    );
  });

  it('locates every well-formed link', () => {
    const body = 'a [@Ann](user:u-ann) b [@张三](user:u-z)';
    expect(findMentionLinks(body)).toEqual([
      { index: 2, text: '[@Ann](user:u-ann)', name: 'Ann', userId: 'u-ann' },
      { index: 23, text: '[@张三](user:u-z)', name: '张三', userId: 'u-z' },
    ]);
  });
});
