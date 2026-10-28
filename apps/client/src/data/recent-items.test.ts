import { describe, expect, it } from 'vitest';
import {
  droppedRecords,
  parseMyTasks,
  parseRecentFiles,
  parseRecentRecords,
  parseSavedRecord,
  RECENT_ITEMS_MAX,
  recordKind,
  withOpenedFile,
  withOpenedRecord,
  withoutFile,
} from './recent-items';

const file = (n: number) => ({ id: String(n), name: `f${n}.pdf`, size: 10, updated_at: '2026-10-24T00:00:00Z', folder_id: null });

describe('recently opened files', () => {
  it('keeps the newest first, each once, capped', () => {
    let list = withOpenedFile([], file(1), 'team', 1);
    list = withOpenedFile(list, file(2), 'personal', 2);
    list = withOpenedFile(list, file(1), 'team', 3);
    expect(list.map((f) => f.id)).toEqual(['1', '2']);
    for (let i = 10; i < 50; i += 1) list = withOpenedFile(list, file(i), 'team', i);
    expect(list).toHaveLength(RECENT_ITEMS_MAX);
    expect(withoutFile(list, '49').map((f) => f.id)).not.toContain('49');
  });

  it('reads back only well-formed entries', () => {
    const list = withOpenedFile([], file(1), 'team', 1);
    expect(parseRecentFiles([...list, { id: 'x' }, null])).toEqual(list);
    expect(parseRecentFiles('nope')).toEqual([]);
  });

  it('reads lists saved before 3.0, whose ids were numbers, as text ids', () => {
    const old = [{ id: 1, name: 'f1.pdf', size: 10, updated_at: 'x', folder_id: 4, shelf: 'team', openedAt: 1 }];
    expect(parseRecentFiles(old)).toEqual([{ ...old[0], id: '1', folder_id: '4' }]);
    const fresh = withOpenedFile([], { ...file(1), id: 'fil_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' }, 'team', 1);
    expect(parseRecentFiles(JSON.parse(JSON.stringify(fresh)))).toEqual(fresh);
  });
});

describe('recently opened records', () => {
  it('lists records once and names the copies that fell off', () => {
    let list = withOpenedRecord([], '1', '1', 1);
    list = withOpenedRecord(list, '1', '2', 2);
    list = withOpenedRecord(list, '1', '1', 3);
    expect(list.map((r) => r.recordId)).toEqual(['1', '2']);
    let full = list;
    for (let i = 10; i < 10 + RECENT_ITEMS_MAX; i += 1) full = withOpenedRecord(full, '2', String(i), i);
    expect(droppedRecords(list, full)).toEqual([recordKind('1', '1'), recordKind('1', '2')]);
    expect(parseRecentRecords([...list, { tableId: 'x' }])).toEqual(list);
    // a list saved before 3.0 held numbers; its copies keep the same file names
    expect(parseRecentRecords([{ tableId: 1, recordId: 2, openedAt: 3 }])).toEqual([{ tableId: '1', recordId: '2', openedAt: 3 }]);
    expect(recordKind('1', '2')).toBe('tbl-rec-1-2');
  });

  it('reads a saved record only for that table and record', () => {
    const saved = {
      schema: { table: { id: 'tbl_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' }, fields: [] },
      record: { id: 'rec_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', table_id: 'tbl_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', values: { fld_01JB2Y8Z9QW3E4R5T6Y7V8H9P0: 'Acme' } },
    };
    const [table, rec] = ['tbl_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', 'rec_01JB2Y8Z9QW3E4R5T6Y7V8H9P0'];
    // a copy saved before names were kept reads with none
    expect(parseSavedRecord(saved, table, rec)).toEqual({ ...saved, users: {} });
    expect(parseSavedRecord(saved, table, '6')).toBeNull();
    expect(parseSavedRecord(saved, '2', rec)).toBeNull();
    expect(parseSavedRecord({ schema: {} }, table, rec)).toBeNull();
    // a copy saved before 3.0 held numeric ids
    const old = { schema: { table: { id: 1 }, fields: [] }, record: { id: 5, table_id: 1, values: { '1': 'Acme' } } };
    expect(parseSavedRecord(old, '1', '5')?.record).toMatchObject({ id: '5', table_id: '1' });
    expect(parseSavedRecord(old, '1', '6')).toBeNull();
  });

  it('keeps the names of the people a saved record names, so they read offline', () => {
    const saved = {
      schema: { table: { id: '1' }, fields: [] },
      record: { id: '5', table_id: '1', values: { '2': 'usr_maya' } },
      users: { usr_maya: 'Maya' },
    };
    expect(parseSavedRecord(saved, '1', '5')?.users).toEqual({ usr_maya: 'Maya' });
    expect(parseSavedRecord({ ...saved, users: { usr_maya: 3, usr_li: 'Li' } }, '1', '5')?.users).toEqual({ usr_li: 'Li' });
    expect(parseSavedRecord({ ...saved, users: ['Maya'] }, '1', '5')?.users).toEqual({});
  });
});

describe('my tasks, saved', () => {
  it('reads back the grouped list or nothing', () => {
    const groups = [{ bucket: 'today', tasks: [{ id: 'tsk_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', project_id: '3', title: 'Brief' }] }];
    expect(parseMyTasks(groups)).toEqual(groups);
    // a list saved before 3.0 held numeric ids
    expect(parseMyTasks([{ bucket: 'today', tasks: [{ id: 1, project_id: 3, parent_id: null, title: 'Brief' }] }])).toEqual([
      { bucket: 'today', tasks: [{ id: '1', project_id: '3', parent_id: null, title: 'Brief' }] },
    ]);
    expect(parseMyTasks([{ bucket: 'someday', tasks: [] }])).toBeNull();
    expect(parseMyTasks([{ bucket: 'today', tasks: [{ id: 'x' }] }])).toBeNull();
    expect(parseMyTasks({})).toBeNull();
  });
});
