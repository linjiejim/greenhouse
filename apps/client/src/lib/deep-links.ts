/**
 * Where a link or a notification goes. React-free (./deep-links.test.ts).
 *
 * Object links are the station's `#/…` addresses (`#/knowledge/doc/<id>-<slug>` or a doc's slug,
 * `#/files?…`, `#/projects/<id>`, `#/tables/<base>/table/<table>?record=`, `#/chat?session=`,
 * `#/automations`, and plugin record kinds); they appear in replies, documents, comments and
 * notifications (a notification's `payload.url`, like the monthly retro document's). Plugin
 * record links (`route`) are resolved against the station manifest when opened
 * (src/plugins/entity-links.ts); other http(s) links open in Safari as they are.
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
  /** One run (its sheet). */
  | { kind: 'run'; id: string }
  /** The Automations place. */
  | { kind: 'automations' }
  /** Any other station address (`#/…`): a plugin record kind the station manifest names, or nothing. */
  | { kind: 'route'; hash: string }
  /** A plugin page of this client (`/p/<plugin>/<page>`), as station links name them now. */
  | { kind: 'page'; href: string }
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
 * `doc/<id>-<slug>` or `doc/<id>` by id; `doc/<slug>` without an id (models write these) by slug.
 * Null for anything else.
 */
function docTarget(parts: string[]): AppTarget | null {
  const [area, first] = parts;
  if (area !== 'doc' || !first) return null;
  // ULIDs carry `_`, never `-`
  const id = objectId(first.split('-', 1)[0]);
  if (id) return { kind: 'doc', id };
  const slug = parts.length === 2 ? slugOf([first]) : null;
  return slug ? { kind: 'doc', slug } : null;
}

/** A station `#/…` address → its target, or null when it is not one. */
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
  if (segments[0] === 'files' && segments.length === 1) {
    return {
      kind: 'files',
      shelf: params.get('shelf') === 'personal' ? 'personal' : 'team',
      folderId: objectId(params.get('folder')),
      fileId: objectId(params.get('file')),
    };
  }
  if (segments[0] === 'automations' && segments.length === 1) return { kind: 'automations' };
  return { kind: 'route', hash };
}

/**
 * Any link as written in content → its target. `stationBase` is the active station's origin:
 * an absolute link to it is read as its hash route. Null for what is not a link (`javascript:`,
 * relative paths with nowhere to go).
 */
export function linkTarget(href: string, stationBase: string): AppTarget | null {
  const value = href.trim();
  if (value.startsWith('#/')) return parseHashRoute(value);
  if (PLUGIN_PAGE.test(value)) return { kind: 'page', href: value };
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
  if (station && url.origin === station.origin && PLUGIN_PAGE.test(url.pathname + url.search))
    return { kind: 'page', href: url.pathname + url.search };
  return { kind: 'external', url: url.toString() };
}

/** `/p/<plugin>/<page>` with an optional query: the only station paths read as client pages. */
const PLUGIN_PAGE = /^\/p\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\?[^#]*)?$/;

/** The absolute address of a station link (`#/…`), the key `POST /api/refs/resolve` reads. */
export function webUrl(stationBase: string, hash: string): string {
  return `${stationBase.replace(/\/+$/, '')}/${hash.startsWith('#') ? hash : `#/${hash}`}`;
}

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
 * else My Agents for an agent write, else its run. Null when it points nowhere else.
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
  if (n.run_id) return payload?.runtime_kind === 'agent_write' ? { kind: 'agent' } : { kind: 'run', id: n.run_id };
  return null;
}
