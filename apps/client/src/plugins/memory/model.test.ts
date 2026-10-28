import { expect, it } from 'vitest';
import { archiveStatus, draftOf, draftProblem, memorySections, patchBody, type Memory } from './model';

const memory = (over: Partial<Memory>): Memory => ({
  id: 'mem_1',
  category: 'preference',
  title: 'Prefers tables',
  content: 'Show numbers in tables, not prose.',
  status: 'active',
  pinned: false,
  source: 'agent',
  superseded_by: null,
  last_used_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...over,
});

it('groups memories in use, resting and archived; pinned first, then most recently used', () => {
  const sections = memorySections([
    memory({ id: 'old', last_used_at: '2026-10-02T00:00:00.000Z' }),
    memory({ id: 'new', last_used_at: '2026-10-20T00:00:00.000Z' }),
    memory({ id: 'pin', pinned: true }),
    memory({ id: 'rest', status: 'dormant' }),
    memory({ id: 'gone', status: 'superseded' }),
    memory({ id: 'kept', status: 'archived' }),
  ]);
  expect(sections.map((s) => [s.group, s.items.map((m) => m.id)])).toEqual([
    ['inUse', ['pin', 'new', 'old']],
    ['resting', ['rest']],
    ['archived', ['gone', 'kept']],
  ]);
  expect(memorySections([memory({})]).map((s) => s.group)).toEqual(['inUse']);
});

it('patches only what changed, trimmed', () => {
  const m = memory({});
  expect(patchBody(m, draftOf(m))).toEqual({});
  expect(patchBody(m, { ...draftOf(m), title: ' Prefers short tables ', pinned: true })).toEqual({
    title: 'Prefers short tables',
    pinned: true,
  });
  expect(patchBody(m, { ...draftOf(m), category: 'behavior' })).toEqual({ category: 'behavior' });
});

it('refuses empty and over-long text before the station does', () => {
  const d = draftOf(memory({}));
  expect(draftProblem(d)).toBeNull();
  expect(draftProblem({ ...d, title: ' ' })).toBe('title');
  expect(draftProblem({ ...d, title: 'x'.repeat(81) })).toBe('titleLong');
  expect(draftProblem({ ...d, content: '' })).toBe('content');
  expect(draftProblem({ ...d, content: 'x'.repeat(2001) })).toBe('contentLong');
});

it('archives a memory in use and restores any other', () => {
  expect(archiveStatus(memory({}))).toBe('archived');
  expect(archiveStatus(memory({ status: 'dormant' }))).toBe('active');
  expect(archiveStatus(memory({ status: 'superseded' }))).toBe('active');
});
