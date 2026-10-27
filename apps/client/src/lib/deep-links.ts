/**
 * Where a link or a notification goes on the phone. React-free (./deep-links.test.ts).
 *
 * The web app's hash routes are the addresses (`#/knowledge/doc/<id>-<slug>` or a doc's slug, `#/files?…`,
 * `#/projects/<id>`, `#/tables/<base>/table/<table>?record=`, `#/chat?session=`,
 * `#/activity/<kind>/<run>`); the same links appear in documents, comments and notifications
 * (a notification's `payload.url`, like the monthly retro document's). A route the phone has a screen for opens natively; any other route of the
 * same station opens in the in-app Safari view at that station's web app; other http(s) links
 * open in Safari as they are.
 */

import { objectId, type ObjectId } from './object-id';

export type FilesShelf = 'team' | 'personal';

export type AppTarget =
  | { kind: 'doc'; id: ObjectId; slug?: undefined }
  /** A document named by its slug (no id in the link); the station finds it (`/api/knowledge/docs/<slug>`). */
  | { kind: 'doc'; slug: string; id?: undefined }
  | { kind: 'files'; shelf: FilesShelf; folderId: ObjectId | null; fileId: ObjectId | null }
  /** The project list (`id` null) or one project; a task when `taskId` is set. */
  | { kind: 'project'; id: ObjectId | null; taskId: ObjectId | null }
  /** Tables: the bases, a base, a table, or one record of it. */
  | { kind: 'tables'; baseId: ObjectId | null; tableId: ObjectId | null; recordId: ObjectId | null }
  /** The assistant: my conversations, or one. */
  | { kind: 'chat'; sessionId: string | null }
  /** My Agents: the writes of the agents I connected, this month's spend, my gateway keys. */
  | { kind: 'agent' }
  /** A page of this station's web app (no screen here yet): `hash` starts with `#/`. */
  | { kind: 'web'; hash: string }
  | { kind: 'external'; url: string };

/** A slug from route segments (a slug may hold `/`; a trailing `edit` is the web's editor), or null. */
function slugOf(parts: string[]): string | null {
  const kept = parts.length > 1 && parts[parts.length - 1] === 'edit' ? parts.slice(0, -1) : parts;
  let slug: string;
  try {
    slug = kept.map((part) => decodeURIComponent(part)).join('/');
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  return slug && slug.length <= 512 && !/[\u0000-\u001f]/.test(slug) ? slug : null;
}

/**
 * A document link after `#/knowledge/` (the rule of packages/types/src/object-refs.ts):
 * `doc/<id>-<slug>` or `doc/<id>` by id; `doc/<slug>` without an id (models write these) and the
 * address-bar routes `internal/<space>/<slug>`, `personal/<slug>`, `shared/<slug>`,
 * `folder/<id>/<slug>` by slug. Null for lists and folders.
 */
function docTarget(parts: string[]): AppTarget | null {
  const [area, first] = parts;
  if (area === 'doc' && first) {
    // ULIDs carry `_`, never `-`
    const id = objectId(first.split('-', 1)[0]);
    if (id) return { kind: 'doc', id };
    const slug = parts.length === 2 ? slugOf([first]) : null;
    return slug ? { kind: 'doc', slug } : null;
  }
  let rest: string[] = [];
  if (area === 'internal' && parts.length >= 3) rest = parts.slice(2);
  else if ((area === 'personal' || area === 'shared') && parts.length >= 2) rest = parts.slice(1);
  else if (area === 'folder' && parts.length >= 3 && objectId(first)) rest = parts.slice(2);
  const slug = rest.length ? slugOf(rest) : null;
  return slug ? { kind: 'doc', slug } : null;
}

/** A `#/…` route of the web app → the phone's target for it, or null when it is not a route. */
export function parseHashRoute(hash: string): AppTarget | null {
  if (!hash.startsWith('#/')) return null;
  const [path, query = ''] = hash.slice(2).split('?', 2) as [string, string?];
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'knowledge') {
    const doc = docTarget(segments.slice(1));
    if (doc) return doc;
  }
  const params = new URLSearchParams(query);
  if (segments[0] === 'projects' && segments.length <= 2) {
    const id = segments.length === 2 ? objectId(segments[1]) : null;
    if (segments.length === 1 || id) return { kind: 'project', id, taskId: id ? objectId(params.get('task')) : null };
  }
  if (segments[0] === 'tables') {
    if (segments.length === 1) return { kind: 'tables', baseId: null, tableId: null, recordId: null };
    const baseId = objectId(segments[1]);
    if (baseId && segments.length === 2) return { kind: 'tables', baseId, tableId: null, recordId: null };
    const tableId = segments[2] === 'table' && segments.length === 4 ? objectId(segments[3]) : null;
    if (baseId && tableId) return { kind: 'tables', baseId, tableId, recordId: objectId(params.get('record')) };
  }
  if (segments[0] === 'chat' && segments.length === 1) {
    const session = params.get('session');
    return { kind: 'chat', sessionId: session && /^[A-Za-z0-9_-]{1,128}$/.test(session) ? session : null };
  }
  if (segments.join('/') === 'settings/agent-connections/activity') return { kind: 'agent' };
  if (segments[0] === 'files' && segments.length === 1) {
    return {
      kind: 'files',
      shelf: params.get('shelf') === 'personal' ? 'personal' : 'team',
      folderId: objectId(params.get('folder')),
      fileId: objectId(params.get('file')),
    };
  }
  return { kind: 'web', hash };
}

/**
 * Any link as written in content → its target. `stationBase` is the active station's origin:
 * an absolute link to it is read as its hash route. Null for what is not a link (`javascript:`,
 * relative paths with nowhere to go).
 */
export function linkTarget(href: string, stationBase: string): AppTarget | null {
  const value = href.trim();
  if (value.startsWith('#/')) return parseHashRoute(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  let station: URL | null;
  try {
    station = new URL(stationBase);
  } catch {
    station = null;
  }
  if (station && url.origin === station.origin && url.hash.startsWith('#/')) return parseHashRoute(url.hash);
  return { kind: 'external', url: url.toString() };
}

/** The web address of a station page (`#/…`), for the in-app Safari view. */
export function webUrl(stationBase: string, hash: string): string {
  return `${stationBase.replace(/\/+$/, '')}/${hash.startsWith('#') ? hash : `#/${hash}`}`;
}

const RUN_KINDS = new Set(['mission', 'workflow', 'automation', 'subagent', 'eval', 'agent_write']);

/** The fields of a notification that say where it points. */
export interface NotificationLink {
  run_id: string | null;
  payload: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Where opening a notification leads, beyond its own page: a link the payload names
 * (`href` / `url`, a hash route or a same-station link), else the scheduled task's conversation,
 * else My Agents for an agent write, else its run in the Activity log (web). Null when it points
 * nowhere else.
 */
export function notificationTarget(n: NotificationLink, stationBase: string): AppTarget | null {
  const payload = record(n.payload);
  for (const key of ['href', 'url'] as const) {
    const value = payload?.[key];
    if (typeof value === 'string') {
      const target = linkTarget(value, stationBase);
      if (target && target.kind !== 'external') return target;
    }
  }
  if (typeof payload?.session_id === 'string' && payload.session_id) {
    return parseHashRoute(`#/chat?session=${encodeURIComponent(payload.session_id)}`);
  }
  if (n.run_id) {
    if (payload?.runtime_kind === 'agent_write') return { kind: 'agent' };
    const kind = typeof payload?.runtime_kind === 'string' && RUN_KINDS.has(payload.runtime_kind) ? payload.runtime_kind : null;
    const run = encodeURIComponent(n.run_id);
    return { kind: 'web', hash: kind ? `#/activity/${kind}/${run}` : `#/activity/${run}` };
  }
  return null;
}
