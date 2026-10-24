import { describe, expect, it } from 'vitest';
import type { DriveFolder, KbDoc } from '../shared/greenhouse-types';
import { levelOf, pathTo } from './kb-tree';

const folder = (id: string, name: string, parent: string | null, sort = 0): DriveFolder => ({
  id,
  name,
  parent_id: parent,
  visibility: 'team',
  sort_order: sort,
  created_at: '',
  updated_at: '',
});
const doc = (id: string, title: string, folderId: string | null, status: KbDoc['status'] = 'published'): KbDoc => ({
  id,
  slug: `d${id}`,
  title,
  content_markdown: '',
  summary: '',
  tags: '[]',
  folder_id: folderId,
  visibility: 'team',
  status,
  owner_user_id: null,
  updated_by: null,
  created_at: '',
  updated_at: '',
});

const folders = [folder('1', 'Ops', null), folder('2', 'Design', null, 1), folder('fld_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', 'Runbooks', '1')];
const docs = [doc('10', 'Zeta', null), doc('11', 'Alpha', null), doc('doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', 'On call', '1'), doc('13', 'Old', null, 'archived'), doc('14', 'Lost', '99')];

describe('a shelf level', () => {
  it('lists manual order first, then names; documents by title; archived out; orphans at the top', () => {
    const top = levelOf(folders, docs, null);
    expect(top.folders.map((f) => f.name)).toEqual(['Design', 'Ops']);
    expect(top.docs.map((d) => d.title)).toEqual(['Alpha', 'Lost', 'Zeta']);
    const ops = levelOf(folders, docs, '1');
    expect(ops.folders.map((f) => f.name)).toEqual(['Runbooks']);
    expect(ops.docs.map((d) => d.title)).toEqual(['On call']);
  });

  it('builds the path down to a folder', () => {
    expect(pathTo(folders, 'fld_01JB2Y8Z9QW3E4R5T6Y7V8H9P0').map((f) => f.name)).toEqual(['Ops', 'Runbooks']);
    expect(pathTo(folders, null)).toEqual([]);
    expect(pathTo(folders, '404')).toEqual([]);
  });
});
