/**
 * Object references in text — which Greenhouse object a link points at.
 *
 * A reply, a document or a notification may carry links to things inside the
 * workspace: a web address (`#/knowledge/doc/12-plan`, `https://<station>/#/files?file=7`)
 * or an app deep link (`greenhouse://projects/task?project=3&task=9`). Clients show such a
 * link as an object chip (type icon + title) instead of a raw URL, and fetch the titles in
 * one batch from `POST /api/refs/resolve`. Web, mobile and the server parse with this one
 * function, so "is this an object link, and which one" has a single answer.
 *
 * Strict on purpose: list pages (`#/projects`, `#/files` without a file or folder) and
 * addresses on another origin are not objects. Absolute URLs count only when their origin is
 * one the caller names (`origins`), because a `#/projects/3` on someone else's instance is a
 * different project 3.
 *
 * The record kinds and their peeks stay in ./entity-links.ts; this module only answers the
 * question for chips and title resolution.
 */

export const OBJECT_REF_TYPES = ['doc', 'file', 'folder', 'task', 'project', 'record', 'conversation'] as const;
export type ObjectRefType = (typeof OBJECT_REF_TYPES)[number];

export type ObjectRef =
  | { type: 'doc'; id: string; slug?: undefined }
  /** A doc named by its slug (`doc_id`), as the scope routes the address bar shows do. */
  | { type: 'doc'; slug: string; id?: undefined }
  | { type: 'file'; id: string }
  | { type: 'folder'; id: string }
  | { type: 'task'; id: string; projectId: string }
  | { type: 'project'; id: string }
  | { type: 'record'; id: string; baseId: string | null; tableId: string }
  | { type: 'conversation'; id: string };

/** The app's URL scheme (apps/client/app.json `scheme`). */
export const APP_LINK_SCHEME = 'greenhouse';

/** Most URLs one `POST /api/refs/resolve` accepts. */
export const MAX_RESOLVE_URLS = 50;

export interface ResolveRefsRequest {
  urls: string[];
}

/** One resolved link. `title` is null when the caller may not read the object (or it is gone). */
export interface ResolvedObjectRef {
  url: string;
  type: ObjectRefType;
  /**
   * The object's id. A doc linked by slug gets its id only when the caller may read it;
   * otherwise (forbidden or gone, indistinguishably) this is the slug from the link.
   */
  id: string;
  title: string | null;
  meta?: { size?: number; contentType?: string | null };
}

export interface ResolveRefsResponse {
  /** One item per URL that names an object; URLs that do not are left out. */
  items: ResolvedObjectRef[];
}

export interface ParseObjectUrlOptions {
  /** Origins (`https://green.example.com`) whose absolute URLs count as this workspace. */
  origins?: readonly string[];
}

/**
 * A row id, or null. Ids are text since 3.0: a prefixed ULID for new rows
 * (`doc_01J…`) or the decimal string of a carried 1.x row (`12`). Rejects `01`,
 * `1.5`, `1e3`, `-1`, `` and anything else.
 */
function rowId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^[1-9][0-9]{0,15}$/.test(raw)) return raw;
  return /^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$/.test(raw) ? raw : null;
}

/** Conversation ids are opaque strings (uuid today). */
function conversationId(raw: string | null | undefined): string | null {
  return raw && /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : null;
}

function splitQuery(rest: string): { segments: string[]; params: URLSearchParams } {
  const q = rest.indexOf('?');
  const path = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? '' : rest.slice(q + 1);
  let segments: string[];
  try {
    segments = path
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s));
  } catch {
    segments = [];
  }
  return { segments, params: new URLSearchParams(query) };
}

/** A doc named by its slug alone (`#/knowledge/doc/runbook`), or null for an unusable slug. */
function slugRef(slug: string): ObjectRef | null {
  // eslint-disable-next-line no-control-regex
  return slug && slug.length <= 512 && !/[\u0000-\u001f]/.test(slug) ? { type: 'doc', slug } : null;
}

/** The web app's hash routes, given what follows `#/`. */
function parseHashRoute(route: string): ObjectRef | null {
  const { segments, params } = splitQuery(route);
  const [head, a, b, c] = segments;

  if (head === 'knowledge') {
    // #/knowledge/doc/<id>-<slug> (or a bare id): the canonical, rename-proof link.
    // A segment that does not start with an id is a slug alone (`#/knowledge/doc/runbook`),
    // which models sometimes write.
    if (a === 'doc' && segments.length === 3) {
      const dash = b!.indexOf('-');
      const id = rowId(dash === -1 ? b : b!.slice(0, dash));
      return id === null ? slugRef(b!) : { type: 'doc', id };
    }
    return null;
  }

  // #/files?file=<id> · #/files?folder=<id> — a file wins over its folder.
  if (head === 'files' && segments.length === 1) {
    const file = rowId(params.get('file'));
    if (file !== null) return { type: 'file', id: file };
    const folder = rowId(params.get('folder'));
    return folder === null ? null : { type: 'folder', id: folder };
  }

  // #/projects/<id> · #/projects/<id>?task=<taskId>
  if (head === 'projects' && segments.length === 2) {
    const id = rowId(a);
    if (id === null) return null;
    const task = rowId(params.get('task'));
    return task === null ? { type: 'project', id } : { type: 'task', id: task, projectId: id };
  }

  // #/tables/<baseId>/table/<tableId>?record=<id>
  if (head === 'tables' && b === 'table' && segments.length === 4) {
    const baseId = rowId(a);
    const tableId = rowId(c);
    const record = rowId(params.get('record'));
    if (baseId === null || tableId === null || record === null) return null;
    return { type: 'record', id: record, baseId, tableId };
  }

  // #/chat?session=<id>
  if (head === 'chat' && segments.length === 1) {
    const id = conversationId(params.get('session'));
    return id === null ? null : { type: 'conversation', id };
  }

  return null;
}

/** App deep links: `greenhouse://<route>?<params>` (expo-router paths of apps/client/app). */
function parseAppLink(rest: string): ObjectRef | null {
  const { segments, params } = splitQuery(rest);
  const route = segments.join('/');
  switch (route) {
    case 'knowledge/doc': {
      const id = rowId(params.get('id'));
      return id === null ? null : { type: 'doc', id };
    }
    case 'knowledge': {
      const id = rowId(params.get('folder'));
      return id === null ? null : { type: 'folder', id };
    }
    case 'files': {
      const file = rowId(params.get('file'));
      if (file !== null) return { type: 'file', id: file };
      const folder = rowId(params.get('folder'));
      return folder === null ? null : { type: 'folder', id: folder };
    }
    case 'file-preview': {
      const id = rowId(params.get('id'));
      return id === null ? null : { type: 'file', id };
    }
    case 'projects/detail': {
      const id = rowId(params.get('id'));
      return id === null ? null : { type: 'project', id };
    }
    case 'projects/task': {
      const id = rowId(params.get('task'));
      const projectId = rowId(params.get('project'));
      return id === null || projectId === null ? null : { type: 'task', id, projectId };
    }
    case 'tables/record': {
      const id = rowId(params.get('record') ?? params.get('id'));
      const tableId = rowId(params.get('table'));
      if (id === null || tableId === null) return null;
      return { type: 'record', id, tableId, baseId: rowId(params.get('base')) };
    }
    case 'chat': {
      const id = conversationId(params.get('session'));
      return id === null ? null : { type: 'conversation', id };
    }
    default:
      return null;
  }
}

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

/**
 * Which object a URL names, or null. Accepts `#/…`, `/#/…`, absolute URLs on one of
 * `options.origins`, and `greenhouse://` app links.
 */
export function parseObjectUrl(raw: string, options: ParseObjectUrlOptions = {}): ObjectRef | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url || url.length > 2048) return null;

  if (url.startsWith('#/')) return parseHashRoute(url.slice(2));
  if (url.startsWith('/#/')) return parseHashRoute(url.slice(3));

  const scheme = `${APP_LINK_SCHEME}://`;
  if (url.toLowerCase().startsWith(scheme)) return parseAppLink(url.slice(scheme.length).replace(/^\/+/, ''));

  if (/^https?:\/\//i.test(url) && options.origins?.length) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const allowed = options.origins.map(normalizeOrigin).filter((o): o is string => o !== null);
    if (!allowed.includes(parsed.origin)) return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
    return parsed.hash.startsWith('#/') ? parseHashRoute(parsed.hash.slice(2)) : null;
  }
  return null;
}

/** The id as the resolve endpoint returns it. */
export function objectRefId(ref: ObjectRef): string {
  return ref.type === 'doc' && ref.slug !== undefined ? ref.slug : String(ref.id);
}

// ─── Files: kind and display name ────────────────────────

export const FILE_KINDS = [
  'pdf',
  'doc',
  'sheet',
  'slides',
  'image',
  'video',
  'audio',
  'archive',
  'code',
  'text',
  'other',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const EXTENSION_KIND: Readonly<Record<string, FileKind>> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  rtf: 'doc',
  pages: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  xlsm: 'sheet',
  ods: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  numbers: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  odp: 'slides',
  key: 'slides',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  heic: 'image',
  bmp: 'image',
  avif: 'image',
  svg: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  flac: 'audio',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  py: 'code',
  json: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  sh: 'code',
  sql: 'code',
  yaml: 'code',
  yml: 'code',
  xml: 'code',
  go: 'code',
  java: 'code',
  rs: 'code',
  txt: 'text',
  md: 'text',
  log: 'text',
};

/** The extension of a file name, lower-case, without the dot ('' when there is none). */
export function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
}

/** A file's kind, from its name; the content type decides when the name has no known extension. */
export function fileKindOf(name: string, contentType?: string | null): FileKind {
  const byExt = EXTENSION_KIND[fileExtension(name)];
  if (byExt) return byExt;
  const type = (contentType ?? '').toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/')) return 'text';
  if (type.includes('spreadsheet') || type.includes('excel')) return 'sheet';
  if (type.includes('presentation') || type.includes('powerpoint')) return 'slides';
  if (type.includes('wordprocessing') || type.includes('msword')) return 'doc';
  if (type.includes('zip') || type.includes('compressed')) return 'archive';
  return 'other';
}

/** Whether a link's name or path looks like a file someone would download. */
export function looksLikeFileName(name: string): boolean {
  return EXTENSION_KIND[fileExtension(name)] !== undefined;
}

/**
 * Shorten text to `max` characters by cutting the middle: `quarterly-rep…final.pdf`.
 * `keepExtension` keeps a file's extension whole after the cut.
 */
export function middleEllipsis(text: string, max: number, options: { keepExtension?: boolean } = {}): string {
  const chars = Array.from(text);
  if (chars.length <= max || max < 5) return text;
  const ext = options.keepExtension ? fileExtension(text) : '';
  const tailMin = ext ? Math.min(ext.length + 1 + 4, max - 4) : 0;
  const budget = max - 1;
  const tail = Math.max(tailMin, Math.floor(budget / 2));
  const head = budget - tail;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}
