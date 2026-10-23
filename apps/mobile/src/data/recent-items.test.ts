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

const file = (id: number) => ({ id, name: `f${id}.pdf`, size: 10, updated_at: '2026-10-24T00:00:00Z', folder_id: null });

describe('recently opened files', () => {
  it('keeps the newest first, each once, capped', () => {
    let list = withOpenedFile([], file(1), 'team', 1);
    list = withOpenedFile(list, file(2), 'personal', 2);
    list = withOpenedFile(list, file(1), 'team', 3);
    expect(list.map((f) => f.id)).toEqual([1, 2]);
    for (let i = 10; i < 50; i += 1) list = withOpenedFile(list, file(i), 'team', i);
    expect(list).toHaveLength(RECENT_ITEMS_MAX);
    expect(withoutFile(list, 49).map((f) => f.id)).not.toContain(49);
  });

  it('reads back only well-formed entries', () => {
    const list = withOpenedFile([], file(1), 'team', 1);
    expect(parseRecentFiles([...list, { id: 'x' }, null])).toEqual(list);
    expect(parseRecentFiles('nope')).toEqual([]);
  });
});

describe('recently opened records', () => {
  it('lists records once and names the copies that fell off', () => {
    let list = withOpenedRecord([], 1, 1, 1);
    list = withOpenedRecord(list, 1, 2, 2);
    list = withOpenedRecord(list, 1, 1, 3);
    expect(list.map((r) => r.recordId)).toEqual([1, 2]);
    let full = list;
    for (let i = 10; i < 10 + RECENT_ITEMS_MAX; i += 1) full = withOpenedRecord(full, 2, i, i);
    expect(droppedRecords(list, full)).toEqual([recordKind(1, 1), recordKind(1, 2)]);
    expect(parseRecentRecords([...list, { tableId: 'x' }])).toEqual(list);
  });

  it('reads a saved record only for that table and record', () => {
    const saved = {
      schema: { table: { id: 1 }, fields: [] },
      record: { id: 5, table_id: 1, values: { '1': 'Acme' } },
    };
    // a copy saved before names were kept reads with none
    expect(parseSavedRecord(saved, 1, 5)).toEqual({ ...saved, users: {} });
    expect(parseSavedRecord(saved, 1, 6)).toBeNull();
    expect(parseSavedRecord(saved, 2, 5)).toBeNull();
    expect(parseSavedRecord({ schema: {} }, 1, 5)).toBeNull();
  });

  it('keeps the names of the people a saved record names, so they read offline', () => {
    const saved = {
      schema: { table: { id: 1 }, fields: [] },
      record: { id: 5, table_id: 1, values: { '2': 'usr_maya' } },
      users: { usr_maya: 'Maya' },
    };
    expect(parseSavedRecord(saved, 1, 5)?.users).toEqual({ usr_maya: 'Maya' });
    expect(parseSavedRecord({ ...saved, users: { usr_maya: 3, usr_li: 'Li' } }, 1, 5)?.users).toEqual({ usr_li: 'Li' });
    expect(parseSavedRecord({ ...saved, users: ['Maya'] }, 1, 5)?.users).toEqual({});
  });
});

describe('my tasks, saved', () => {
  it('reads back the grouped list or nothing', () => {
    const groups = [{ bucket: 'today', tasks: [{ id: 1, title: 'Brief' }] }];
    expect(parseMyTasks(groups)).toEqual(groups);
    expect(parseMyTasks([{ bucket: 'someday', tasks: [] }])).toBeNull();
    expect(parseMyTasks([{ bucket: 'today', tasks: [{ id: 'x' }] }])).toBeNull();
    expect(parseMyTasks({})).toBeNull();
  });
});
