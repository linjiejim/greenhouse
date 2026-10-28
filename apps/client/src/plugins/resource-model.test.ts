import { it, expect } from 'vitest';
import { humanizeKey, resourceOf, statusWords } from './resource-model';

it('turns a collection into rows with a title, one supporting line, status, tags and a time', () => {
  const skills = {
    total: 1,
    skills: [
      {
        name: 'release-notes',
        display_name: 'Release notes',
        description: 'Draft release notes.',
        tags: ['writing', 'product', 7],
        status: 'active',
        updated_at: '2026-10-25 18:44:45.283+00',
      },
    ],
  };
  expect(resourceOf(skills, 'skills')).toEqual({
    kind: 'rows',
    rows: [
      {
        id: 'release-notes',
        title: 'Release notes',
        subtitle: 'Draft release notes.',
        status: 'active',
        tags: ['writing', 'product'],
        time: '2026-10-25 18:44:45.283+00',
      },
    ],
  });
});

it('never repeats the title as the supporting line', () => {
  const rows = resourceOf({ memories: [{ id: 'm1', content: 'Prefers tables' }] }, 'memories');
  expect(rows).toEqual({ kind: 'rows', rows: [{ id: 'm1', title: 'Prefers tables', subtitle: undefined, status: undefined, tags: [], time: undefined }] });
});

it('shows a single object as its scalar facts', () => {
  const computer = { enabled: false, minutes_this_month: 0, computer: null, period: { start: 'x' } };
  expect(resourceOf(computer)).toEqual({
    kind: 'facts',
    facts: [
      { key: 'enabled', label: 'Enabled', value: false },
      { key: 'minutes_this_month', label: 'Minutes this month', value: 0 },
      { key: 'computer', label: 'Computer', value: null },
    ],
  });
});

it('reads nothing as an empty list', () => {
  expect(resourceOf(undefined, 'docs')).toEqual({ kind: 'rows', rows: [] });
  expect(humanizeKey('pricePerMinute')).toBe('Price per minute');
});

it('says a status in the surface\'s words, keeps the usual one quiet and never shows a raw value', () => {
  const words = { active: null, archived: 'skillHub.archived' } as const;
  const say = (key: string) => `<${key}>`;
  expect(statusWords('active', words, say)).toBeUndefined();
  expect(statusWords('archived', words, say)).toBe('<skillHub.archived>');
  expect(statusWords('needs_review', words, say)).toBe('Needs review');
  expect(statusWords('active', undefined, say)).toBe('Active');
  expect(statusWords(undefined, words, say)).toBeUndefined();
});
