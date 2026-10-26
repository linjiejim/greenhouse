import type { ActivityCursor, DatabaseProvider } from '@greenhouse/db';
import type { ActivityItem } from '@greenhouse/types/activity';
import type { UserRole } from '@greenhouse/types/api';
import type { PlatformRuntime } from '../platform/runtime.js';
/** Rows one source reads per query, and how many queries it may spend on one page. */
const SCAN_BATCH = 100;
const SCAN_ROUNDS = 5;

export interface RecentViewer {
  id: string;
  role: UserRole;
}

export type RecentChangeDraft = Omit<ActivityItem, 'actor'> & { actorId: string };

/** A place in the feed order: `at` (fixed-width UTC ISO) then the item id, both newest first. */
type Cursor = ActivityCursor;

/** What one page of a source reads: rows after `cursor` inside [since, now). */
export interface RecentChangeWindow {
  since: string;
  cursor: Cursor | null;
}

/**
 * A source's contribution to one page: its visible items in feed order,
 * complete down to `frontier` (the last row it read) unless `exhausted`.
 */
export interface RecentChangeLane {
  items: RecentChangeDraft[];
  exhausted: boolean;
  frontier: Cursor | null;
}

export function recentChangeDraft(
  base: Omit<RecentChangeDraft, 'agent' | 'action_title' | 'status' | 'run' | 'detail'> & Partial<RecentChangeDraft>,
): RecentChangeDraft {
  return { agent: null, action_title: null, status: null, run: null, detail: null, ...base };
}

/**
 * Read one source in feed order from `window.cursor`, letting `admit` drop the
 * rows the viewer may not see, until `need` items are found, the source runs
 * out, or the scan budget is spent.
 */
export async function scanRecentChanges<Row extends { at: string; key: string }>(
  window: RecentChangeWindow,
  need: number,
  read: (cursor: Cursor | null, limit: number) => Promise<Row[]>,
  admit: (rows: Row[]) => Promise<RecentChangeDraft[]>,
): Promise<RecentChangeLane> {
  const items: RecentChangeDraft[] = [];
  let cursor = window.cursor;
  for (let round = 0; round < SCAN_ROUNDS; round++) {
    const rows = await read(cursor, SCAN_BATCH);
    items.push(...(await admit(rows)));
    if (rows.length < SCAN_BATCH) return { items, exhausted: true, frontier: null };
    const last = rows[rows.length - 1];
    cursor = { at: last.at, key: last.key };
    if (items.length >= need) break;
  }
  return { items, exhausted: false, frontier: cursor };
}

export interface RecentChangeSource {
  id: string;
  load: (
    db: DatabaseProvider,
    runtime: PlatformRuntime,
    viewer: RecentViewer,
    window: RecentChangeWindow,
    need: number,
  ) => Promise<RecentChangeLane>;
}
