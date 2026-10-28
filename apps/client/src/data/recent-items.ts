/**
 * What was opened recently, for offline reading of files' details, records and my tasks. React-free
 * (./recent-items.test.ts). Files keep their details in the list itself (name, size, when, where);
 * records keep a saved copy each (schema, values and the names of the people it names), listed here so the oldest copies go when
 * the list is full. My tasks keep one copy of the grouped list.
 */

import type { DriveFile, TableRecord, TableSchema } from '../shared/greenhouse-types';
import { objectId } from '../lib/object-id';
import type { DueBucket, MyTask } from './tasks';

export const RECENT_ITEMS_MAX = 20;

// ─── files ───────────────────────────────────────────────

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  updated_at: string;
  folder_id: string | null;
  shelf: 'team' | 'personal';
  openedAt: number;
}

export function withOpenedFile(
  list: readonly RecentFile[],
  file: Pick<DriveFile, 'id' | 'name' | 'size' | 'updated_at' | 'folder_id'>,
  shelf: 'team' | 'personal',
  now: number,
): RecentFile[] {
  const entry: RecentFile = {
    id: file.id,
    name: file.name,
    size: file.size,
    updated_at: file.updated_at,
    folder_id: file.folder_id ?? null,
    shelf,
    openedAt: now,
  };
  return [entry, ...list.filter((item) => item.id !== file.id)].slice(0, RECENT_ITEMS_MAX);
}

export function withoutFile(list: readonly RecentFile[], id: string): RecentFile[] {
  return list.filter((item) => item.id !== id);
}

/** The saved list; entries saved before 3.0 hold numeric ids and read as their text. */
export function parseRecentFiles(value: unknown): RecentFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item): RecentFile[] => {
      const f = item as { [K in keyof RecentFile]?: unknown } | null;
      const id = objectId(f?.id);
      if (
        !f ||
        !id ||
        typeof f.name !== 'string' ||
        typeof f.size !== 'number' ||
        typeof f.updated_at !== 'string' ||
        (f.shelf !== 'team' && f.shelf !== 'personal') ||
        typeof f.openedAt !== 'number'
      ) {
        return [];
      }
      const folderId = objectId(f.folder_id);
      return [{ id, name: f.name, size: f.size, updated_at: f.updated_at, folder_id: folderId, shelf: f.shelf, openedAt: f.openedAt }];
    })
    .slice(0, RECENT_ITEMS_MAX);
}

// ─── records ─────────────────────────────────────────────

export interface RecentRecord {
  tableId: string;
  recordId: string;
  openedAt: number;
}

export const recordKind = (tableId: string, recordId: string) => `tbl-rec-${tableId}-${recordId}`;

export function withOpenedRecord(list: readonly RecentRecord[], tableId: string, recordId: string, now: number): RecentRecord[] {
  return [
    { tableId, recordId, openedAt: now },
    ...list.filter((item) => item.tableId !== tableId || item.recordId !== recordId),
  ].slice(0, RECENT_ITEMS_MAX);
}

/** The saved copies that fell off the list (their files go). */
export function droppedRecords(before: readonly RecentRecord[], after: readonly RecentRecord[]): string[] {
  const kept = new Set(after.map((item) => recordKind(item.tableId, item.recordId)));
  return before.map((item) => recordKind(item.tableId, item.recordId)).filter((kind) => !kept.has(kind));
}

/** The saved list; entries saved before 3.0 hold numeric ids and read as their text. */
export function parseRecentRecords(value: unknown): RecentRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item): RecentRecord[] => {
      const r = item as { [K in keyof RecentRecord]?: unknown } | null;
      const tableId = objectId(r?.tableId);
      const recordId = objectId(r?.recordId);
      return tableId && recordId && typeof r?.openedAt === 'number' ? [{ tableId, recordId, openedAt: r.openedAt }] : [];
    })
    .slice(0, RECENT_ITEMS_MAX);
}

/** A record as it is shown and saved: the table's schema, the record, and the names of the people it names. */
export interface SavedRecord {
  schema: TableSchema;
  record: TableRecord;
  /** User id → name for the record's user fields (../data/table-fields.ts `recordUserNames`). */
  users: Record<string, string>;
}

/**
 * A record's saved copy, or null when it is not this record's. Copies saved before names were
 * kept (or with a damaged name list) read with no names, so their user fields show ids.
 */
export function parseSavedRecord(value: unknown, tableId: string, recordId: string): SavedRecord | null {
  const saved = value as { schema?: Partial<TableSchema>; record?: Partial<TableRecord>; users?: unknown } | null;
  if (!saved?.schema?.table || !Array.isArray(saved.schema.fields) || !saved.record) return null;
  // copies saved before 3.0 hold numeric ids
  if (objectId(saved.record.id) !== recordId || objectId(saved.record.table_id) !== tableId) return null;
  if (!saved.record.values || typeof saved.record.values !== 'object') return null;
  const users: Record<string, string> = {};
  if (saved.users && typeof saved.users === 'object' && !Array.isArray(saved.users)) {
    for (const [id, name] of Object.entries(saved.users)) if (typeof name === 'string') users[id] = name;
  }
  return { schema: saved.schema as TableSchema, record: { ...(saved.record as TableRecord), id: recordId, table_id: tableId }, users };
}

// ─── my tasks ────────────────────────────────────────────

const BUCKETS: readonly DueBucket[] = ['overdue', 'today', 'soon', 'later', 'none'];

/**
 * The saved grouped list of my tasks, or null when it is not one. Lists saved before 3.0 hold
 * numeric ids; they read as their text.
 */
export function parseMyTasks(value: unknown): { bucket: DueBucket; tasks: MyTask[] }[] | null {
  if (!Array.isArray(value)) return null;
  const groups = value.filter(
    (group): group is { bucket: DueBucket; tasks: MyTask[] } =>
      !!group &&
      BUCKETS.includes((group as { bucket: DueBucket }).bucket) &&
      Array.isArray((group as { tasks: unknown }).tasks) &&
      (group as { tasks: unknown[] }).tasks.every(
        (task) => !!task && objectId((task as { id?: unknown }).id) !== null && typeof (task as MyTask).title === 'string',
      ),
  );
  if (groups.length !== value.length) return null;
  return groups.map((group) => ({ ...group, tasks: group.tasks.map(savedTask) }));
}

/** A saved task with its ids as text (numbers in copies saved before 3.0). */
function savedTask(task: MyTask): MyTask {
  const raw = task as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw, id: objectId(raw.id) };
  for (const key of ['project_id', 'parent_id'] as const) {
    if (key in raw) out[key] = raw[key] == null ? raw[key] : objectId(raw[key]);
  }
  return out as unknown as MyTask;
}
