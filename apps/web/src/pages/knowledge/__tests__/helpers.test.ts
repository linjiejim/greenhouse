import { describe, expect, it } from 'vitest';
import type { KnowledgeItem } from '@greenhouse/contract';
import {
  canArchive,
  canMove,
  canShare,
  dropPosition,
  fileKind,
  mentionAt,
  oneFolder,
  reorderAround,
  routeOf,
  scopeOf,
  sortItems,
  staleDetails,
  withMentions,
} from '../helpers';

const item = (overrides: Partial<KnowledgeItem>): KnowledgeItem => ({
  type: 'doc',
  id: 'doc_1',
  name: 'Plan',
  space: 'personal',
  folder_id: null,
  owner_id: 'mbr_me',
  sort_order: 0,
  access: 'owner',
  shared: false,
  agent_id: null,
  is_template: false,
  content_type: null,
  size_bytes: null,
  archived_at: null,
  updated_at: '2026-10-14T08:00:00.000Z',
  ...overrides,
});

describe('where items open and who may do what', () => {
  it('opens docs on their page, folders on their own and files over their folder', () => {
    expect(routeOf(item({}))).toEqual({ page: 'doc', id: 'doc_1' });
    expect(routeOf(item({ type: 'folder', id: 'fld_1' }))).toEqual({ page: 'folder', id: 'fld_1' });
    expect(routeOf(item({ type: 'file', id: 'fil_1', folder_id: 'fld_1' }))).toEqual({
      page: 'folder',
      id: 'fld_1',
      file: 'fil_1',
    });
    expect(routeOf(item({ type: 'file', id: 'fil_1', space: 'team' }))).toEqual({
      page: 'knowledge',
      space: 'team',
      file: 'fil_1',
    });
  });

  it('puts an item under the team, my own space, or shared with me', () => {
    expect(scopeOf({ space: 'team', owner_id: null }, 'mbr_me')).toBe('team');
    expect(scopeOf({ space: 'personal', owner_id: 'mbr_me' }, 'mbr_me')).toBe('personal');
    expect(scopeOf({ space: 'personal', owner_id: 'mbr_lin' }, 'mbr_me')).toBe('shared');
  });

  it('lets only owners share personal items, never Agent folders, team items or archived ones', () => {
    expect(canShare(item({}))).toBe(true);
    expect(canShare(item({ access: 'editor' }))).toBe(false);
    expect(canShare(item({ space: 'team', owner_id: null, access: 'editor' }))).toBe(false);
    expect(canShare(item({ type: 'folder', agent_id: 'agt_1' }))).toBe(false);
    expect(canShare(item({ archived_at: '2026-10-14T08:00:00.000Z' }))).toBe(false);
  });

  it('archives: anyone who edits the team space, only the owner of a personal item', () => {
    expect(canArchive(item({ space: 'team', access: 'editor' }))).toBe(true);
    expect(canArchive(item({ access: 'editor' }))).toBe(false);
    expect(canArchive(item({ access: 'viewer', space: 'team' }))).toBe(false);
  });

  it('keeps an Agent folder in place and read-only items where they are', () => {
    expect(canMove(item({ type: 'folder', agent_id: 'agt_1' }))).toBe(false);
    expect(canMove(item({ access: 'viewer' }))).toBe(false);
    expect(canMove(item({ type: 'folder' }))).toBe(true);
  });
});

describe('order, drops and reorders', () => {
  const items = [
    item({ id: 'b', name: 'b 10', updated_at: '2026-10-14T08:00:00.000Z' }),
    item({ type: 'folder', id: 'f', name: 'z', updated_at: '2026-10-01T08:00:00.000Z' }),
    item({ id: 'a', name: 'b 9', updated_at: '2026-10-15T08:00:00.000Z' }),
  ];

  it('sorts by hand (as given), by name with folders first, or by the latest change', () => {
    expect(sortItems(items, 'manual').map((entry) => entry.id)).toEqual(['b', 'f', 'a']);
    expect(sortItems(items, 'name').map((entry) => entry.id)).toEqual(['f', 'a', 'b']);
    expect(sortItems(items, 'updated').map((entry) => entry.id)).toEqual(['a', 'b', 'f']);
  });

  it('uses the API’s natural pinyin order in either interface language', () => {
    const rows = ['Doc 10', '中', '张', 'Doc 2', '阿'].map((name, index) => item({ id: String(index), name }));
    expect(sortItems(rows, 'name').map((entry) => entry.name)).toEqual(['阿', '张', '中', 'Doc 2', 'Doc 10']);
  });

  it('puts in order only rows of one folder (分享给我 mixes owners)', () => {
    expect(oneFolder(items)).toBe(true);
    expect(oneFolder([])).toBe(true);
    expect(oneFolder([item({ owner_id: 'mbr_lin' }), item({ owner_id: 'mbr_mei' })])).toBe(false);
    expect(oneFolder([item({ folder_id: 'fld_1' }), item({})])).toBe(false);
  });

  it('drops into the middle of a folder and beside anything else', () => {
    expect(dropPosition(5, 32, true)).toBe('before');
    expect(dropPosition(16, 32, true)).toBe('into');
    expect(dropPosition(30, 32, true)).toBe('after');
    expect(dropPosition(10, 32, false)).toBe('before');
    expect(dropPosition(20, 32, false)).toBe('after');
  });

  it('sends the whole folder in its new order', () => {
    const siblings = [
      { type: 'folder' as const, id: 'f' },
      { type: 'doc' as const, id: 'a' },
      { type: 'file' as const, id: 'x' },
    ];
    expect(reorderAround(siblings, siblings[2]!, siblings[0]!, 'before')).toEqual([
      { type: 'file', id: 'x' },
      { type: 'folder', id: 'f' },
      { type: 'doc', id: 'a' },
    ]);
    expect(reorderAround(siblings, siblings[0]!, siblings[1]!, 'after')).toEqual([
      { type: 'doc', id: 'a' },
      { type: 'folder', id: 'f' },
      { type: 'file', id: 'x' },
    ]);
    // Coming from another folder: it joins this one.
    expect(reorderAround(siblings, { type: 'doc', id: 'new' }, siblings[1]!, 'after').map((entry) => entry.id)).toEqual(
      ['f', 'a', 'new', 'x'],
    );
  });
});

describe('comments', () => {
  it('writes the members picked from the @ list as mention links, longest names first', () => {
    const mei = { id: 'mbr_mei', name: 'Mei' };
    const meiling = { id: 'mbr_ml', name: 'Mei Ling' };
    expect(withMentions('@Mei please look', [mei])).toBe('[@Mei](member:mbr_mei) please look');
    expect(withMentions('cc @Mei Ling and @Mei.', [mei, meiling])).toBe(
      'cc [@Mei Ling](member:mbr_ml) and [@Mei](member:mbr_mei).',
    );
    expect(withMentions('mail@Mei.com stays', [mei])).toBe('mail@Mei.com stays');
    expect(withMentions('你好@Mei', [mei])).toBe('你好[@Mei](member:mbr_mei)');
    expect(withMentions('@[ops] team', [{ id: 'mbr_o', name: '[ops]' }])).toBe('[@\\[ops\\]](member:mbr_o) team');
  });

  it('finds the @word being typed', () => {
    expect(mentionAt('hi @me', 6)).toEqual({ start: 3, query: 'me' });
    expect(mentionAt('hi @me there', 12)).toBeNull();
    expect(mentionAt('mail@x', 6)).toBeNull();
  });
});

describe('files and refused saves', () => {
  it('names the kind of a file', () => {
    expect(fileKind('image/png')).toBe('image');
    expect(fileKind('application/pdf')).toBe('pdf');
    expect(fileKind('text/markdown')).toBe('text');
    expect(fileKind('application/json')).toBe('text');
    expect(fileKind('application/zip')).toBe('other');
    expect(fileKind(null)).toBe('other');
  });

  it('reads who saved the newer version from a 409', () => {
    expect(staleDetails({ version: 4, updated_by: 'mbr_mei', updated_at: '2026-10-14T08:00:00.000Z' })).toEqual({
      version: 4,
      updatedBy: 'mbr_mei',
      updatedAt: '2026-10-14T08:00:00.000Z',
    });
    expect(
      staleDetails({ version: 4, updated_by: null, updated_at: '2026-10-14T08:00:00.000Z' })?.updatedBy,
    ).toBeNull();
    expect(staleDetails(undefined)).toBeNull();
  });
});
