import { describe, it, expect } from 'vitest';
import { nextSlug, slugify } from './doc-slug';

describe('slugify', () => {
  it('lowercases and dashes ASCII titles', () => {
    expect(slugify('  Getting Started: Day 1  ')).toBe('getting-started-day-1');
  });

  it('keeps CJK', () => {
    expect(slugify('快速上手')).toBe('快速上手');
  });

  it('never produces leading/trailing dashes', () => {
    expect(slugify('!!! hello !!!')).toBe('hello');
  });
});

describe('nextSlug', () => {
  const draft = (title: string, slug: string) => ({ title, slug });

  it('follows the title on a new doc, keystroke by keystroke', () => {
    // The regression: the slug used to freeze at 'h' after the first character.
    let state = draft('', '');
    for (const title of ['H', 'He', 'Hel', 'Hello']) {
      state = { title, slug: nextSlug(state, title) };
    }
    expect(state.slug).toBe('hello');
  });

  it('stops following once the slug is hand-edited', () => {
    expect(nextSlug(draft('Hello', 'custom-slug'), 'Hello world')).toBe('custom-slug');
  });

  it('never rewrites a saved doc’s slug — that would repoint every link to it', () => {
    expect(nextSlug({ id: 7, title: 'Hello', slug: 'hello' }, 'Hello world')).toBe('hello');
  });
});
