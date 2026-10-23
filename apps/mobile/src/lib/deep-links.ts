/**
 * Where a link or a notification goes on the phone. React-free (./deep-links.test.ts).
 *
 * The web app's hash routes are the addresses (`#/knowledge/doc/<id>-<slug>`, `#/files?…`,
 * `#/projects/<id>`, `#/tables/<base>/table/<table>?record=`, `#/chat?session=`,
 * `#/activity/<kind>/<run>`); the same links appear in documents, comments and notifications
 * (a notification's `payload.url`, like the monthly retro document's). A route the phone has a screen for opens natively; any other route of the
 * same station opens in the in-app Safari view at that station's web app; other http(s) links
 * open in Safari as they are.
 */

export type FilesShelf = 'team' | 'personal';

export type AppTarget =
  | { kind: 'doc'; id: number }
  | { kind: 'files'; shelf: FilesShelf; folderId: number | null; fileId: number | null }
  /** The project list (`id` null) or one project; a task when `taskId` is set. */
  | { kind: 'project'; id: number | null; taskId: number | null }
  /** Tables: the bases, a base, a table, or one record of it. */
  | { kind: 'tables'; baseId: number | null; tableId: number | null; recordId: number | null }
  /** The assistant: my conversations, or one. */
  | { kind: 'chat'; sessionId: string | null }
  /** My Agents: the writes of the agents I connected, this month's spend, my gateway keys. */
  | { kind: 'agent' }
  /** A page of this station's web app (no screen here yet): `hash` starts with `#/`. */
  | { kind: 'web'; hash: string }
  | { kind: 'external'; url: string };

function positiveInt(raw: string | null | undefined): number | null {
  if (!raw || !/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** A `#/…` route of the web app → the phone's target for it, or null when it is not a route. */
export function parseHashRoute(hash: string): AppTarget | null {
  if (!hash.startsWith('#/')) return null;
  const [path, query = ''] = hash.slice(2).split('?', 2) as [string, string?];
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'knowledge' && segments[1] === 'doc') {
    const id = positiveInt(/^([0-9]+)/.exec(segments[2] ?? '')?.[1]);
    if (id) return { kind: 'doc', id };
  }
  const params = new URLSearchParams(query);
  if (segments[0] === 'projects' && segments.length <= 2) {
    const id = segments.length === 2 ? positiveInt(segments[1]) : null;
    if (segments.length === 1 || id) return { kind: 'project', id, taskId: id ? positiveInt(params.get('task')) : null };
  }
  if (segments[0] === 'tables') {
    if (segments.length === 1) return { kind: 'tables', baseId: null, tableId: null, recordId: null };
    const baseId = positiveInt(segments[1]);
    if (baseId && segments.length === 2) return { kind: 'tables', baseId, tableId: null, recordId: null };
    const tableId = segments[2] === 'table' && segments.length === 4 ? positiveInt(segments[3]) : null;
    if (baseId && tableId) return { kind: 'tables', baseId, tableId, recordId: positiveInt(params.get('record')) };
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
      folderId: positiveInt(params.get('folder')),
      fileId: positiveInt(params.get('file')),
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
