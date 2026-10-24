import { describe, expect, it } from 'vitest';
import { fileExtension, fileKindOf, looksLikeFileName, middleEllipsis, parseObjectUrl } from './object-refs';

describe('parseObjectUrl — web hash routes', () => {
  it.each([
    ['#/knowledge/doc/12-q3-plan', { type: 'doc', id: '12' }],
    ['#/knowledge/doc/12', { type: 'doc', id: '12' }],
    ['/#/knowledge/doc/12-x', { type: 'doc', id: '12' }],
    ['#/knowledge/folder/5', { type: 'folder', id: '5' }],
    ['#/files?file=7', { type: 'file', id: '7' }],
    ['#/files?shelf=personal&folder=3&file=7', { type: 'file', id: '7' }],
    ['#/files?folder=3', { type: 'folder', id: '3' }],
    ['#/projects/4', { type: 'project', id: '4' }],
    ['#/projects/4?task=19', { type: 'task', id: '19', projectId: '4' }],
    ['#/tables/1/table/2?record=3', { type: 'record', id: '3', baseId: '1', tableId: '2' }],
    ['#/chat?session=0b6c-uuid_1', { type: 'conversation', id: '0b6c-uuid_1' }],
    // 3.0 ids: a prefixed ULID for new rows, the decimal string for carried 1.x rows.
    ['#/knowledge/doc/doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0-plan', { type: 'doc', id: 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' }],
    [
      '#/projects/prj_01JB2Y8Z9QW3E4R5T6Y7V8H9P0?task=tsk_01JB2Y8Z9QW3E4R5T6Y7V8H9P1',
      { type: 'task', id: 'tsk_01JB2Y8Z9QW3E4R5T6Y7V8H9P1', projectId: 'prj_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' },
    ],
    ['#/files?file=fil_01JB2Y8Z9QW3E4R5T6Y7V8H9P2', { type: 'file', id: 'fil_01JB2Y8Z9QW3E4R5T6Y7V8H9P2' }],
    // The scope routes the address bar shows on a doc name it by slug.
    ['#/knowledge/internal/general/api-style-guide', { type: 'doc', slug: 'api-style-guide' }],
    ['#/knowledge/internal/general/api-style-guide/edit', { type: 'doc', slug: 'api-style-guide' }],
    ['#/knowledge/internal/general/brand%2Fvoice', { type: 'doc', slug: 'brand/voice' }],
    ['#/knowledge/internal/general/%E6%8C%87%E5%8D%97', { type: 'doc', slug: '指南' }],
    ['#/knowledge/personal/my-notes', { type: 'doc', slug: 'my-notes' }],
    ['#/knowledge/shared/their-notes', { type: 'doc', slug: 'their-notes' }],
    ['#/knowledge/folder/5/legacy-slug', { type: 'doc', slug: 'legacy-slug' }],
  ])('%s', (url, expected) => {
    expect(parseObjectUrl(url)).toEqual(expected);
  });

  it.each([
    '#/projects',
    '#/files',
    '#/files?shelf=personal',
    '#/knowledge',
    '#/knowledge/doc/',
    '#/knowledge/doc/abc-slug',
    '#/knowledge/internal',
    '#/knowledge/internal/general',
    '#/knowledge/personal',
    '#/knowledge/shared',
    '#/knowledge/new/personal',
    '#/knowledge/folder/abc/slug',
    '#/projects/01',
    '#/projects/1.5',
    '#/projects/prj_short',
    '#/projects/PRJ_01JB2Y8Z9QW3E4R5T6Y7V8H9P0',
    '#/tables/1/table/2',
    '#/chat',
    '#/chat?session=../../etc',
    '#/settings',
    'projects/4',
    '',
    'mailto:a@b.c',
  ])('rejects %s', (url) => {
    expect(parseObjectUrl(url)).toBeNull();
  });
});

describe('parseObjectUrl — absolute URLs', () => {
  const origins = ['https://green.example.com'];

  it('accepts the named origin only', () => {
    expect(parseObjectUrl('https://green.example.com/#/projects/4', { origins })).toEqual({ type: 'project', id: '4' });
    expect(parseObjectUrl('https://green.example.com#/projects/4', { origins })).toEqual({ type: 'project', id: '4' });
    expect(
      parseObjectUrl('https://green.example.com/#/knowledge/internal/general/api-style-guide', { origins }),
    ).toEqual({
      type: 'doc',
      slug: 'api-style-guide',
    });
    expect(parseObjectUrl('https://other.example.com/#/projects/4', { origins })).toBeNull();
    expect(parseObjectUrl('https://green.example.com/#/projects/4')).toBeNull();
  });

  it('ignores paths other than the app root', () => {
    expect(parseObjectUrl('https://green.example.com/docs/#/projects/4', { origins })).toBeNull();
  });
});

describe('parseObjectUrl — app deep links', () => {
  it.each([
    ['greenhouse://knowledge/doc?id=12&station=s1', { type: 'doc', id: '12' }],
    ['greenhouse:///knowledge/doc?id=12', { type: 'doc', id: '12' }],
    ['greenhouse://knowledge?folder=8', { type: 'folder', id: '8' }],
    ['greenhouse://files?file=7', { type: 'file', id: '7' }],
    ['greenhouse://file-preview?id=7&name=a.pdf', { type: 'file', id: '7' }],
    ['greenhouse://projects/detail?id=4', { type: 'project', id: '4' }],
    ['greenhouse://projects/task?project=4&task=19', { type: 'task', id: '19', projectId: '4' }],
    ['greenhouse://tables/record?table=2&id=3', { type: 'record', id: '3', tableId: '2', baseId: null }],
    ['greenhouse://chat?session=abc', { type: 'conversation', id: 'abc' }],
  ])('%s', (url, expected) => {
    expect(parseObjectUrl(url)).toEqual(expected);
  });

  it('rejects unknown routes and missing ids', () => {
    expect(parseObjectUrl('greenhouse://auth/feishu?code=1')).toBeNull();
    expect(parseObjectUrl('greenhouse://projects/task?task=19')).toBeNull();
    expect(parseObjectUrl('greenhouse://knowledge')).toBeNull();
  });
});

describe('file helpers', () => {
  it('reads extensions and kinds', () => {
    expect(fileExtension('Report.Final.PDF')).toBe('pdf');
    expect(fileExtension('.env')).toBe('');
    expect(fileExtension('noext')).toBe('');
    expect(fileKindOf('a.xlsx')).toBe('sheet');
    expect(fileKindOf('deck.pptx')).toBe('slides');
    expect(fileKindOf('photo', 'image/png')).toBe('image');
    expect(fileKindOf('blob', 'application/octet-stream')).toBe('other');
    expect(looksLikeFileName('export.csv')).toBe(true);
    expect(looksLikeFileName('example.com')).toBe(false);
  });

  it('cuts the middle and keeps the extension', () => {
    expect(middleEllipsis('short.pdf', 20, { keepExtension: true })).toBe('short.pdf');
    const cut = middleEllipsis('quarterly-operations-review-final-version.pdf', 24, { keepExtension: true });
    expect(Array.from(cut)).toHaveLength(24);
    expect(cut).toMatch(/^quarterly.*….*\.pdf$/);
    expect(middleEllipsis('一二三四五六七八九十甲乙丙丁', 9)).toBe('一二三四…甲乙丙丁');
  });
});
