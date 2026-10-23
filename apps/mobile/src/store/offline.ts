/**
 * Offline copies of screens (my tasks, opened records, opened files' details) for the active
 * station + member, in the documents directory (../data/disk-cache.ts; they go with sign-out and
 * station removal). Rules in ../data/offline-view.ts.
 */

import { readCache, removeCache, writeCache } from '../data/disk-cache';
import {
  droppedRecords,
  parseRecentFiles,
  parseRecentRecords,
  withOpenedFile,
  withOpenedRecord,
  withoutFile,
  type RecentFile,
} from '../data/recent-items';
import type { DriveFile } from '../shared/greenhouse-types';
import { useAuth } from './auth';
import { useStations } from './stations';

function who(): { station: string; member: string } | null {
  const station = useStations.getState().activeId;
  const member = useAuth.getState().user?.id;
  return station && member ? { station, member } : null;
}

export async function readOffline(kind: string): Promise<unknown> {
  const id = who();
  return id ? readCache(id.station, id.member, kind) : null;
}

export function writeOffline(kind: string, value: unknown): void {
  const id = who();
  if (id) writeCache(id.station, id.member, kind, value);
}

export function removeOffline(kind: string): void {
  const id = who();
  if (id) removeCache(id.station, id.member, kind);
}

// ─── recently opened files (their details) and records ───


const FILES = 'files-recent';
const RECORDS = 'tbl-recent';

export async function recentFiles(): Promise<RecentFile[]> {
  return parseRecentFiles(await readOffline(FILES));
}

/** A file was opened: its details are kept to show offline (for the identity that opened it). */
export async function rememberFile(
  file: Pick<DriveFile, 'id' | 'name' | 'size' | 'updated_at' | 'folder_id'>,
  shelf: 'team' | 'personal',
): Promise<void> {
  const id = who();
  if (!id) return;
  const before = parseRecentFiles(await readCache(id.station, id.member, FILES));
  writeCache(id.station, id.member, FILES, withOpenedFile(before, file, shelf, Date.now()));
}

/** The station says the file is gone or no longer mine: its details go too. */
export async function forgetFile(fileId: number): Promise<void> {
  const id = who();
  if (!id) return;
  const before = parseRecentFiles(await readCache(id.station, id.member, FILES));
  writeCache(id.station, id.member, FILES, withoutFile(before, fileId));
}

/** A record was read from the station: list it, and drop the copies that fell off the list. */
export async function rememberRecord(tableId: number, recordId: number): Promise<void> {
  const id = who();
  if (!id) return;
  const before = parseRecentRecords(await readCache(id.station, id.member, RECORDS));
  const after = withOpenedRecord(before, tableId, recordId, Date.now());
  writeCache(id.station, id.member, RECORDS, after);
  for (const kind of droppedRecords(before, after)) removeCache(id.station, id.member, kind);
}
