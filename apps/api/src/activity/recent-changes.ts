import { cabinetDriveScope } from '../drive/access.js';
import {
  scanRecentChanges,
  recentChangeDraft,
  type RecentViewer,
  type RecentChangeDraft,
  type RecentChangeWindow,
  type RecentChangeLane,
} from './recent-source.js';
import { fromExtensions } from '../plugin-host/index.js';
/**
 * Home "recent changes" (团队动态) — what changed across the team lately,
 * limited to what the viewer may read.
 *
 * Built from each domain's own change record, every query bounded by a time
 * window (RECENT_DAYS) and a LIMIT:
 *   knowledge  knowledge_base_versions (one row per saved edit), each document
 *              confirmed with resolveKbAccess for the viewer;
 *   plugins    registered recentChanges sources, each applying its own access rules;
 *   files      new files on the team shelf and the viewer's own shelf.
 * A change made through a member's agent is matched to the recorded
 * agent_write run (same member, same module, inside the run's time span) and
 * says "via <client>".
 *
 * Paging: every item has a place in one order, (at, id) newest first, and the
 * opaque cursor `next_before` names the last place a page covered; the next
 * page holds only items strictly after it, inside the same window. Each source
 * pages its own rows on that order in SQL (aggregates and the one-row-per-edit
 * rule are applied before paging) and keeps reading past rows the viewer may
 * not see until it has enough or runs out, so a short page never hides older
 * items. A plain ISO timestamp is still accepted as `before` (older clients).
 */
import type { ActivityCursor, DatabaseProvider } from '@greenhouse/db';
import type { ActivityItem } from '@greenhouse/types/activity';
import { filesPageHref, shelfOfVisibility } from '@greenhouse/types/files';
import type { PlatformRuntime } from '../plugin-host/runtime.js';
import { moduleOfTool } from './activity-log.js';
type Cursor = ActivityCursor;
export const RECENT_DAYS = 14;
export const RECENT_MAX_ITEMS = 50;
/**
 * A change counts as an agent's when it lands inside the run's span: the write
 * happens after the run is created and before it settles, both stamped by the
 * same API clock. No slack — a person's own edit a moment after their agent
 * finished must stay theirs.
 */
const AGENT_MATCH_SLACK_MS = 0;
const EMPTY_LANE: RecentChangeLane = { items: [], exhausted: true, frontier: null };
/** Feed order: newer first; same instant → greater id first (byte-wise, like `COLLATE "C"`). */
function compare(a: Cursor, b: Cursor): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? 1 : -1;
}
const placeOf = (item: RecentChangeDraft): Cursor => ({ at: item.at, key: item.id });
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** Microsecond ISO that names a real calendar instant (2026-13-26 matches the shape but not this). */
function isRealInstant(value: string): boolean {
  if (!ISO_MICROS.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}
export function encodeRecentCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.key]), 'utf8').toString('base64url');
}
/** The cursor `next_before` encodes, a plain ISO timestamp (strictly older than it), or null when unreadable. */
export function decodeRecentCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      isRealInstant(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      parsed[1].length <= 200 &&
      !parsed[1].includes('\u0000')
    ) {
      return { at: parsed[0], key: parsed[1] };
    }
  } catch {
    // Not one of ours; try a plain timestamp below.
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Key '' sorts before every id, so only strictly older instants remain.
  return { at: isRealInstant(value) ? value : new Date(ms).toISOString().replace('Z', '000Z'), key: '' };
}
async function fileChanges(db: DatabaseProvider, viewer: RecentViewer, window: RecentChangeWindow, need: number) {
  return scanRecentChanges(
    window,
    need,
    (cursor, limit) =>
      db.activity.recentKbFiles({ scope: cabinetDriveScope(), userId: viewer.id, since: window.since, cursor, limit }),
    async (rows) =>
      rows.map((row) => {
        const shelf = shelfOfVisibility(row.visibility);
        return recentChangeDraft({
          id: row.key,
          source: 'person',
          at: row.at,
          actorId: row.uploaded_by,
          module: 'files',
          verb: 'create',
          entity: 'file',
          action: 'uploadFile',
          target: {
            id: String(row.id),
            label: row.name,
            url: filesPageHref({ shelf, folderId: row.folder_id, fileId: row.id }),
          },
        });
      }),
  );
}
/** Say which agent made a change, when a recorded agent write of that member covers it. */
async function attachAgents(db: DatabaseProvider, items: RecentChangeDraft[]): Promise<void> {
  if (items.length === 0) return;
  const times = items.map((item) => Date.parse(item.at));
  const writes = await db.activity.agentWritesOf({
    ownerIds: [...new Set(items.map((item) => item.actorId))],
    from: new Date(Math.min(...times) - 10 * 60000).toISOString(),
    to: new Date(Math.max(...times) + 1).toISOString(),
    limit: 200,
  });
  for (const item of items) {
    const at = Date.parse(item.at);
    const write = writes.find(
      (candidate) =>
        candidate.owner_user_id === item.actorId &&
        candidate.tool_id !== null &&
        moduleOfTool(candidate.tool_id) === item.module &&
        Date.parse(candidate.from) - AGENT_MATCH_SLACK_MS <= at &&
        at <= Date.parse(candidate.to) + AGENT_MATCH_SLACK_MS,
    );
    if (write) {
      item.source = 'agent';
      item.agent = { client_id: null, client_name: write.client_name ?? 'Agent' };
    }
  }
}
export interface RecentChangesPage {
  items: ActivityItem[];
  /** Opaque cursor for the next page (`before`); null when nothing older is left in the window. */
  next_before: string | null;
}
export async function listRecentChanges(
  db: DatabaseProvider,
  viewer: RecentViewer,
  opts: {
    limit?: number;
    now?: number;
    before?: string | null;
  },
  deps: {
    runtime: PlatformRuntime;
  },
): Promise<RecentChangesPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20) || 20, 1), RECENT_MAX_ITEMS);
  const since = new Date((opts.now ?? Date.now()) - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // An unreadable cursor reads as "from the top" rather than an error page.
  const window: RecentChangeWindow = { since, cursor: decodeRecentCursor(opts.before) };
  if (window.cursor && Date.parse(window.cursor.at) <= Date.parse(since)) return { items: [], next_before: null };
  // One more than a page tells whether anything is left after it.
  const need = limit + 1;
  // Each lane fails on its own: one closed door is not an outage of the feed.
  const lanes = await Promise.all([
    ...fromExtensions('recentChanges').map((source) =>
      source.load(db, deps.runtime, viewer, window, need).catch(() => EMPTY_LANE),
    ),
    fileChanges(db, viewer, window, need).catch(() => EMPTY_LANE),
  ]);
  // A lane that stopped early is complete only down to its frontier; past the
  // newest such frontier another lane's items could still be missing.
  const boundary = lanes
    .filter((lane) => !lane.exhausted && lane.frontier)
    .map((lane) => lane.frontier!)
    .sort(compare)[0];
  const merged = lanes
    .flatMap((lane) => lane.items)
    .sort((a, b) => compare(placeOf(a), placeOf(b)))
    .filter((item) => !boundary || compare(placeOf(item), boundary) <= 0);
  const items = merged.slice(0, limit);
  const next = merged.length > limit ? placeOf(items[items.length - 1]) : (boundary ?? null);
  await attachAgents(db, items).catch(() => undefined);
  const ids = [...new Set(items.map((item) => item.actorId))];
  const users = await Promise.all(ids.map((id) => db.users.getById(id).catch(() => undefined)));
  const names = new Map(ids.map((id, index) => [id, users[index]?.nickname ?? null]));
  return {
    items: items.map(({ actorId, ...item }) => ({ ...item, actor: { id: actorId, name: names.get(actorId) ?? null } })),
    next_before: next ? encodeRecentCursor(next) : null,
  };
}
