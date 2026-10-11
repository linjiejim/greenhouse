/**
 * Where an inbox row goes — pure (root vitest: ./model.test.ts). A row opens
 * what it is about the way its push would (the same `PushRoute` / `hrefOf` as
 * src/push/model.ts), rebuilt from validated ids, never a URL taken as given:
 *
 *  - a fact with a push envelope (`payload.push`: a Bots card / reply, a task
 *    result, a Tables notice / mention) → that envelope's target;
 *  - else a Tables `payload.href` (`#/tables/<base>/table/<table>?record=<id>`,
 *    `#/apps/<id>?record=<id>`) → the record page / the app record;
 *  - anything else → null (the row only marks itself read; web-only targets).
 */

import { hrefOf, type PushRoute } from '../push/model';

const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const PAGE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function rowId(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value) ? value : null;
}

/** The route of a stored push envelope (snake_case, apps/api/src/notifications/push/policy.ts). */
function envelopeRoute(push: Record<string, unknown>): PushRoute | null {
  if (push.open === 'bots') {
    const c = text(push.sid);
    if (!c) return null;
    return { kind: 'thread', c, request: push.k === 'needs_you' ? (text(push.rid) ?? '') : '' };
  }
  if (push.open === 'chat') {
    const id = text(push.sid);
    return id ? { kind: 'chat', id } : null;
  }
  if (push.open === 'record') {
    const baseId = rowId(push.base_id);
    const tableId = rowId(push.table_id);
    return baseId && tableId ? { kind: 'record', baseId, tableId, recordId: rowId(push.record_id) } : null;
  }
  if (push.open === 'app') {
    const appId = rowId(push.app_id);
    if (!appId) return null;
    const page = typeof push.page_id === 'string' && PAGE_ID.test(push.page_id) ? push.page_id : null;
    return { kind: 'app', appId, pageId: page, recordId: rowId(push.record_id), tableId: rowId(push.table_id) };
  }
  return null;
}

function queryParam(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    if (key === name) return value ?? null;
  }
  return null;
}

/** The route of a Tables `href` (`#/tables/…`, `#/apps/…`), or null. */
export function hrefRoute(href: string): PushRoute | null {
  if (!href.startsWith('#/')) return null;
  const [path = '', query = ''] = href.slice(2).split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'tables' && parts[2] === 'table' && parts.length === 4) {
    const baseId = rowId(parts[1]);
    const tableId = rowId(parts[3]);
    if (!baseId || !tableId) return null;
    return { kind: 'record', baseId, tableId, recordId: rowId(queryParam(query, 'record')) };
  }
  if (parts[0] === 'apps' && parts.length >= 2) {
    const appId = rowId(parts[1]);
    if (!appId) return null;
    const page = parts[2] && PAGE_ID.test(parts[2]) && parts[2] !== 'edit' ? parts[2] : null;
    return { kind: 'app', appId, pageId: page, recordId: rowId(queryParam(query, 'record')), tableId: null };
  }
  return null;
}

/** Where a tap on this notification goes (a router href), or null. */
export function inboxHref(notification: { payload: unknown }): string | null {
  const payload =
    notification.payload && typeof notification.payload === 'object' && !Array.isArray(notification.payload)
      ? (notification.payload as Record<string, unknown>)
      : {};
  const push = payload.push && typeof payload.push === 'object' ? (payload.push as Record<string, unknown>) : null;
  const route =
    (push ? envelopeRoute(push) : null) ?? (typeof payload.href === 'string' ? hrefRoute(payload.href) : null);
  return route ? hrefOf(route) : null;
}
