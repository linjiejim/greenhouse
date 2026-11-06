/**
 * Where a link or a notification goes. React-free (./deep-links.test.ts).
 *
 * Object links are the station's `#/…` addresses (`#/knowledge/doc/<id>-<slug>` or a doc's slug,
 * `#/files?…`, `#/projects/<id>`, `#/tables/<base>/table/<table>?record=`, `#/chat?session=`,
 * `#/automations?id=`, and plugin record kinds); they appear in replies, documents, comments and
 * notifications (a notification's `payload.url`, like the monthly retro document's). Plugin
 * record links (`route`) are resolved against the station manifest when opened
 * (src/plugins/entity-links.ts); other http(s) links open in Safari as they are.
 *
 * The browser client's own addresses name the same objects (`/knowledge?doc=`,
 * `/drive?view=tables&base=&table=&record=`, `/sheet/task?project=&id=`, `/chat?session=`): copied
 * from the address bar or written by a model, relative or absolute on the station, they open here
 * too (`parseAppPath`), as do `/#/…` and `greenhouse://` app links. A station address this client
 * has no screen for opens the browser client in Safari.
 */

import { objectId, type ObjectId } from './object-id';

export type FilesShelf = 'team' | 'personal';

export type AppTarget =
  | { kind: 'doc'; id: ObjectId; slug?: undefined }
  /** A document named by its slug (no id in the link); the station finds it (`/api/knowledge/docs/<slug>`). */
  | { kind: 'doc'; slug: string; id?: undefined }
  | { kind: 'files'; shelf: FilesShelf; folderId: ObjectId | null; fileId: ObjectId | null }
  /** The knowledge place. */
  | { kind: 'knowledge' }
  /** A knowledge folder (its sheet). */
  | { kind: 'kb-folder'; shelf: FilesShelf; id: ObjectId }
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
  /** The Automations place (`id` null), or one automation (`#/automations?id=`, its sheet). */
  | { kind: 'automations'; id: ObjectId | null }
  /** Any other station address (`#/…`): a plugin record kind the station manifest names, or nothing. */
  | { kind: 'route'; hash: string }
  /** A page of this client: a plugin page (`/p/<plugin>/<page>`) or Settings, notifications, search, admin. */
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
    if (segments.length === 1) return { kind: 'knowledge' };
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
  if (segments[0] === 'automations' && segments.length <= 2) {
    // the web place's own address (`?id=`), or the id as a path segment, as models write it
    const id = segments.length === 2 ? objectId(segments[1]) : objectId(params.get('id'));
    if (segments.length === 1 || id) return { kind: 'automations', id };
  }
  return { kind: 'route', hash };
}

/** An id-shaped query parameter, or null. */
function idParam(params: URLSearchParams, key: string): ObjectId | null {
  return objectId(params.get(key));
}

function shelfOf(value: string | null): FilesShelf {
  return value === 'personal' ? 'personal' : 'team';
}

/** A conversation id as links carry it, or null. */
function sessionParam(params: URLSearchParams): string | null {
  const session = params.get('session');
  return session && /^[A-Za-z0-9_-]{1,128}$/.test(session) ? session : null;
}

/** The object sheets of this client (`/sheet/<kind>?…`, app/sheet/*) → their target. */
function sheetTarget(kind: string, params: URLSearchParams): AppTarget | null {
  switch (kind) {
    case 'doc': {
      const id = idParam(params, 'id');
      if (id) return { kind: 'doc', id };
      const slug = params.get('slug');
      return slug ? { kind: 'doc', slug } : null;
    }
    case 'file': {
      const fileId = idParam(params, 'id');
      return fileId ? { kind: 'files', shelf: shelfOf(params.get('shelf')), folderId: null, fileId } : null;
    }
    case 'folder': {
      const folderId = idParam(params, 'id');
      if (!folderId) return null;
      const shelf = shelfOf(params.get('shelf'));
      return params.get('scope') === 'kb' ? { kind: 'kb-folder', shelf, id: folderId } : { kind: 'files', shelf, folderId, fileId: null };
    }
    case 'project': {
      const id = idParam(params, 'id');
      return id ? { kind: 'project', id, taskId: null } : null;
    }
    case 'task': {
      const id = idParam(params, 'project');
      const taskId = idParam(params, 'id');
      return id && taskId ? { kind: 'project', id, taskId } : null;
    }
    case 'record': {
      const tableId = idParam(params, 'table');
      const recordId = idParam(params, 'id');
      return tableId && recordId ? { kind: 'tables', baseId: idParam(params, 'base'), tableId, recordId } : null;
    }
    case 'run': {
      const id = params.get('id');
      return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? { kind: 'run', id } : null;
    }
    case 'automation': {
      const id = idParam(params, 'id');
      return id ? { kind: 'automations', id } : null;
    }
    case 'conversation': {
      const sessionId = sessionParam(params);
      return sessionId ? { kind: 'chat', sessionId } : null;
    }
    default:
      return null;
  }
}

/** Client routes that are pages of their own here (Settings, notifications, search, admin). */
const CLIENT_PAGE = /^\/(?:me(?:\/[a-z-]+)?|notifications|search|admin(?:\/[A-Za-z0-9_-]+){0,3})$/;

/**
 * A path of this client, as the browser client's address bar has it (`/drive?view=tables&base=…`,
 * `/sheet/record?…`, `/p/<plugin>/<page>`) → its target. Null for paths this client has no screen
 * for (`/activate`, `/api/…`).
 */
export function parseAppPath(path: string): AppTarget | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const [pathname = '', query = ''] = path.split('#', 1)[0]!.split('?', 2) as [string, string?];
  const route = pathname.replace(/\/+$/, '') || '/';
  // `..` or `.` segments, or anything that is not a plain path, name nothing
  if (!/^\/[A-Za-z0-9_\-/]*$/.test(route) || route.split('/').some((part) => part === '.' || part === '..')) return null;
  const params = new URLSearchParams(query);
  const segments = route.split('/').filter(Boolean);
  if (segments[0] === 'p') return PLUGIN_PAGE.test(path) ? { kind: 'page', href: path } : null;
  if (segments[0] === 'sheet' && segments.length === 2) return sheetTarget(segments[1]!, params);
  switch (route) {
    case '/':
    case '/chat': {
      // a composer address (`?draft=`, `?agent=`, with or without a session) is the chat page's own, kept whole
      if (route === '/chat' && [...params.keys()].some((key) => key !== 'session')) return { kind: 'page', href: `${route}?${query}` };
      return { kind: 'chat', sessionId: sessionParam(params) };
    }
    case '/knowledge': {
      const id = idParam(params, 'doc');
      return id ? { kind: 'doc', id } : { kind: 'knowledge' };
    }
    case '/drive':
      if (params.get('view') === 'tables') {
        const baseId = idParam(params, 'base');
        const tableId = baseId ? idParam(params, 'table') : null;
        return { kind: 'tables', baseId, tableId, recordId: tableId ? idParam(params, 'record') : null };
      }
      return { kind: 'files', shelf: shelfOf(params.get('shelf')), folderId: idParam(params, 'folder'), fileId: idParam(params, 'file') };
    case '/drive/base': {
      const baseId = idParam(params, 'id');
      return baseId ? { kind: 'tables', baseId, tableId: idParam(params, 'table'), recordId: null } : null;
    }
    case '/drive/table': {
      const tableId = idParam(params, 'id');
      return tableId ? { kind: 'tables', baseId: idParam(params, 'base'), tableId, recordId: null } : null;
    }
    case '/projects': {
      const id = idParam(params, 'project');
      return { kind: 'project', id, taskId: id ? idParam(params, 'task') : null };
    }
    case '/automations':
      // another view of the place (`?view=agents&id=` is a custom agent) stays that address
      if (params.has('view')) return { kind: 'page', href: `${route}?${query}` };
      return { kind: 'automations', id: idParam(params, 'id') };
    case '/me/agents':
      return { kind: 'agent' };
    default:
      // filters and selections ride in the query (`/admin/users?role=`), so it stays
      return CLIENT_PAGE.test(route) ? { kind: 'page', href: query ? `${route}?${query}` : route } : null;
  }
}

/**
 * A `greenhouse://` app link (widgets, notifications, the server's object links:
 * packages/types/src/object-refs.ts `parseAppLink`) → its target, or null.
 */
export function appLinkTarget(href: string): AppTarget | null {
  const match = /^greenhouse:\/\/\/?([^?#]*)(\?[^#]*)?/i.exec(href.trim());
  if (!match) return null;
  const route = `/${match[1]!.replace(/\/+$/, '')}`;
  const params = new URLSearchParams(match[2] ?? '');
  switch (route) {
    case '/knowledge/doc':
      return sheetTarget('doc', params);
    case '/projects/detail':
      return sheetTarget('project', params);
    case '/projects/task': {
      const id = idParam(params, 'project');
      const taskId = idParam(params, 'task');
      return id && taskId ? { kind: 'project', id, taskId } : null;
    }
    case '/tables/record': {
      const tableId = idParam(params, 'table');
      const recordId = idParam(params, 'record') ?? idParam(params, 'id');
      return tableId && recordId ? { kind: 'tables', baseId: idParam(params, 'base'), tableId, recordId } : null;
    }
    case '/files': {
      const fileId = idParam(params, 'file');
      const folderId = fileId ? null : idParam(params, 'folder');
      return fileId || folderId ? { kind: 'files', shelf: 'team', folderId, fileId } : null;
    }
    case '/file-preview':
      return sheetTarget('file', params);
    case '/knowledge':
      return { kind: 'knowledge' };
    default:
      return parseAppPath(`${route}${match[2] ?? ''}`);
  }
}

/**
 * Any link as written in content → its target. `stationBase` is the active station's origin:
 * an absolute link to it is read as its hash route or client path. Null for what is not a link
 * (`javascript:`, relative paths with nowhere to go).
 */
export function linkTarget(href: string, stationBase: string): AppTarget | null {
  const value = href.trim();
  if (value.startsWith('#/')) return parseHashRoute(value);
  if (value.startsWith('/#/')) return parseHashRoute(value.slice(1));
  if (/^greenhouse:/i.test(value)) return appLinkTarget(value);
  let station: URL | null;
  try {
    station = new URL(stationBase);
  } catch {
    station = null;
  }
  if (value.startsWith('/') && !value.startsWith('//')) {
    const target = parseAppPath(value);
    if (target || !station || /(^|\/)\.\.?(\/|$|\?)/.test(value.split('?', 1)[0]!)) return target;
    // a station address this client has no screen for: the browser client
    return { kind: 'external', url: new URL(value, station).toString() };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (station && url.origin === station.origin) {
    if (url.hash.startsWith('#/')) return parseHashRoute(url.hash);
    const target = parseAppPath(url.pathname + url.search);
    if (target) return target;
  }
  return { kind: 'external', url: url.toString() };
}

/** `/p/<plugin>/<page>` with an optional query: the station paths read as plugin pages. */
const PLUGIN_PAGE = /^\/p\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\?[^#]*)?$/;

/**
 * The station's `#/…` address of a target (`POST /api/refs/resolve` reads these), or null for
 * places, pages and other sites.
 */
export function targetHash(target: AppTarget): string | null {
  switch (target.kind) {
    case 'doc':
      return target.id !== undefined ? `#/knowledge/doc/${target.id}` : `#/knowledge/doc/${encodeURIComponent(target.slug)}`;
    case 'files':
      if (target.fileId) return `#/files?file=${target.fileId}`;
      return target.folderId ? `#/files?shelf=${target.shelf}&folder=${target.folderId}` : null;
    case 'project':
      if (!target.id) return null;
      return target.taskId ? `#/projects/${target.id}?task=${target.taskId}` : `#/projects/${target.id}`;
    case 'tables':
      if (!target.baseId) return null;
      if (!target.tableId) return `#/tables/${target.baseId}`;
      return `#/tables/${target.baseId}/table/${target.tableId}${target.recordId ? `?record=${target.recordId}` : ''}`;
    case 'chat':
      return target.sessionId ? `#/chat?session=${target.sessionId}` : null;
    case 'route':
      return target.hash;
    default:
      return null;
  }
}

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
