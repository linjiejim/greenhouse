/**
 * What `openObject` opens and how. React-free (./object-ref.test.ts).
 *
 * Every object of the hub opens the same way: a native form sheet over whatever is on screen
 * (documents, files, folders, projects, tasks, table records, notifications, runs, agent
 * writes, automations). A sheet opened from a sheet stacks on top of it, up to MAX_SHEETS; the next one
 * replaces the top sheet instead of stacking deeper. Only a conversation is a full pushed page.
 * Links (src/lib/deep-links.ts `AppTarget`), search hits and cards all become an `ObjectRef`.
 */

import type { AppTarget, FilesShelf } from '../lib/deep-links';

export type ObjectRef =
  | { kind: 'plugin-entity'; plugin: string; page: string; entity: string; id: string }
  | { kind: 'doc'; id: string; slug?: undefined }
  /** A document a link names by slug only; its sheet looks it up first. */
  | { kind: 'doc'; slug: string; id?: undefined }
  | { kind: 'file'; id: string; name?: string }
  /** A file attached to or produced in a conversation (`/api/chat-files/<id>/content`). */
  | { kind: 'attachment'; path: string; name: string }
  | { kind: 'folder'; scope: 'kb' | 'drive'; shelf: FilesShelf; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'task'; projectId: string; id: string }
  | { kind: 'record'; baseId: string | null; tableId: string; id: string }
  | { kind: 'notification'; id: string }
  | { kind: 'run'; id: string }
  | { kind: 'write'; id: string }
  | { kind: 'automation'; id: string }
  | { kind: 'chat'; sessionId: string }
  | { kind: 'chat-preview'; sessionId: string }
  | { kind: 'steps' };

/** The sheet routes (app/sheet/*), each with its own detents in app/_layout.tsx. */
export const SHEET_ROUTES = {
  plugin: 'sheet/plugin',
  doc: 'sheet/doc',
  file: 'sheet/file',
  folder: 'sheet/folder',
  project: 'sheet/project',
  task: 'sheet/task',
  record: 'sheet/record',
  notification: 'sheet/notification',
  run: 'sheet/run',
  write: 'sheet/write',
  automation: 'sheet/automation',
  conversation: 'sheet/conversation',
  steps: 'sheet/steps',
} as const;

export type SheetKind = keyof typeof SHEET_ROUTES;

/** How deep object sheets stack before the next one replaces the top one. */
export const MAX_SHEETS = 3;

/** A route of the root stack: its name, as the navigation state has it. */
export interface StackRoute {
  name: string;
  params?: object;
}

const SHEET_NAMES = new Set<string>(Object.values(SHEET_ROUTES));

export function isObjectSheet(name: string): boolean {
  return SHEET_NAMES.has(name);
}

/** How many object sheets sit at the top of the root stack. */
export function sheetDepth(routes: readonly StackRoute[]): number {
  let depth = 0;
  for (let i = routes.length - 1; i >= 0 && isObjectSheet(routes[i]!.name); i -= 1) {
    if ((routes[i]!.params as { main?: string } | undefined)?.main === '1') break;
    depth += 1;
  }
  return depth;
}

/** Stack a new sheet, or replace the top one once MAX_SHEETS are up. */
export function sheetMove(depth: number): 'push' | 'replace' {
  return depth >= MAX_SHEETS ? 'replace' : 'push';
}

export type Opening =
  | { via: 'sheet'; pathname: `/${(typeof SHEET_ROUTES)[SheetKind]}`; params: Record<string, string> }
  | { via: 'page'; pathname: '/chat'; params: { session: string } };

/** The route an object opens on, with its params (always strings). */
export function openingOf(ref: ObjectRef): Opening {
  switch (ref.kind) {
    case 'plugin-entity':
      return {
        via: 'sheet',
        pathname: '/sheet/plugin',
        params: { plugin: ref.plugin, page: ref.page, entity: ref.entity, id: ref.id },
      };
    case 'chat-preview':
      return { via: 'sheet', pathname: '/sheet/conversation', params: { session: ref.sessionId } };
    case 'steps':
      return { via: 'sheet', pathname: '/sheet/steps', params: {} };
    case 'chat':
      return { via: 'page', pathname: '/chat', params: { session: ref.sessionId } };
    case 'doc':
      return {
        via: 'sheet',
        pathname: '/sheet/doc',
        params: ref.slug !== undefined ? { slug: ref.slug } : { id: String(ref.id) },
      };
    case 'project':
      return { via: 'sheet', pathname: `/${SHEET_ROUTES[ref.kind]}`, params: { id: String(ref.id) } };
    case 'file':
      return {
        via: 'sheet',
        pathname: '/sheet/file',
        params: { id: String(ref.id), ...(ref.name ? { name: ref.name } : {}) },
      };
    case 'attachment':
      return { via: 'sheet', pathname: '/sheet/file', params: { path: ref.path, name: ref.name } };
    case 'folder':
      return {
        via: 'sheet',
        pathname: '/sheet/folder',
        params: { id: String(ref.id), scope: ref.scope, shelf: ref.shelf },
      };
    case 'task':
      return { via: 'sheet', pathname: '/sheet/task', params: { project: String(ref.projectId), id: String(ref.id) } };
    case 'record':
      return {
        via: 'sheet',
        pathname: '/sheet/record',
        params: { ...(ref.baseId ? { base: String(ref.baseId) } : {}), table: String(ref.tableId), id: String(ref.id) },
      };
    case 'notification':
    case 'run':
    case 'write':
    case 'automation':
      return { via: 'sheet', pathname: `/${SHEET_ROUTES[ref.kind]}`, params: { id: ref.id } };
  }
}

/** Where a link leads that is not one object: a tab, a place in a tab, or a web page. */
export type Place =
  | { kind: 'tab'; href: '/' | '/knowledge' | '/drive' | '/projects' | '/automations' }
  | { kind: 'drive'; shelf: FilesShelf; folderId: string | null }
  | { kind: 'tables'; baseId: string | null; tableId: string | null }
  | { kind: 'agents' }
  | { kind: 'web'; hash: string }
  /** A plugin page of this client (`/p/<plugin>/<page>`). */
  | { kind: 'page'; href: string }
  | { kind: 'external'; url: string };

/** A link's target as one object to open, or a place to go. */
export function refOfTarget(target: AppTarget): { ref: ObjectRef } | { place: Place } {
  switch (target.kind) {
    case 'doc':
      return { ref: target.slug !== undefined ? { kind: 'doc', slug: target.slug } : { kind: 'doc', id: target.id } };
    case 'files':
      if (target.fileId) return { ref: { kind: 'file', id: target.fileId } };
      return { place: { kind: 'drive', shelf: target.shelf, folderId: target.folderId } };
    case 'project':
      if (target.id && target.taskId) return { ref: { kind: 'task', projectId: target.id, id: target.taskId } };
      if (target.id) return { ref: { kind: 'project', id: target.id } };
      return { place: { kind: 'tab', href: '/projects' } };
    case 'tables':
      if (target.tableId && target.recordId) {
        return { ref: { kind: 'record', baseId: target.baseId, tableId: target.tableId, id: target.recordId } };
      }
      return { place: { kind: 'tables', baseId: target.baseId, tableId: target.tableId } };
    case 'chat':
      return target.sessionId
        ? { ref: { kind: 'chat', sessionId: target.sessionId } }
        : { place: { kind: 'tab', href: '/' } };
    case 'agent':
      return { place: { kind: 'agents' } };
    case 'web': {
      // a run in the Activity log opens as its sheet (src/lib/deep-links.ts notificationTarget)
      const run = /^#\/activity\/(?:[a-z_]+\/)?([^/?#]+)$/.exec(target.hash);
      if (run) return { ref: { kind: 'run', id: decodeURIComponent(run[1]!) } };
      // the web's automations page is a place on the phone too
      if (/^#\/automations(?:\?|$)/.test(target.hash)) return { place: { kind: 'tab', href: '/automations' } };
      return { place: { kind: 'web', hash: target.hash } };
    }
    case 'page':
      return { place: { kind: 'page', href: target.href } };
    case 'external':
      return { place: { kind: 'external', url: target.url } };
  }
}
