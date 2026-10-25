/**
 * How a link in a reply or a document shows: never a raw address. React-free
 * (./link-chip.test.ts).
 *
 *  - a Greenhouse object (a station link or app route to a document, file, folder, project,
 *    task, table record, conversation) → an object chip: its type icon and title (the title the
 *    station resolves for this member, src/store/refs.ts; the link's own words until then; only
 *    the type when the member may not see it);
 *  - a file the station serves (`/api/chat-files/…/content`, `/api/drive/files/…/content`) → a
 *    file chip: type icon, name (middle-truncated, the extension kept) and size;
 *  - any other web address → a site chip: the domain, then the link's words when they say more
 *    than the address;
 *  - mail and phone links stay plain text links.
 */

import { linkTarget, webUrl, type AppTarget } from './deep-links';
import { isObjectId } from './object-id';

export type ObjectType = 'doc' | 'file' | 'folder' | 'project' | 'task' | 'record' | 'table' | 'chat' | 'page';

export type LinkChip =
  | { kind: 'object'; type: ObjectType; target: AppTarget; label: string | null; resolveUrl: string }
  | { kind: 'file'; path: string; id: string; label: string | null; resolveUrl: string }
  | { kind: 'site'; url: string; domain: string; label: string | null }
  | { kind: 'plain'; href: string };

/** The words of a link, unless they are just its address (`[https://x](https://x)`, a bare URL). */
export function meaningfulLabel(label: string | undefined, href: string): string | null {
  const text = (label ?? '').trim();
  if (!text) return null;
  const strip = (value: string) => value.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  if (strip(text) === strip(href)) return null;
  if (/^https?:\/\//i.test(text)) return null;
  return text;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

function objectType(target: AppTarget): ObjectType {
  switch (target.kind) {
    case 'doc':
      return 'doc';
    case 'files':
      return target.fileId ? 'file' : 'folder';
    case 'project':
      return target.taskId ? 'task' : 'project';
    case 'tables':
      return target.recordId ? 'record' : 'table';
    case 'chat':
      return 'chat';
    default:
      return 'page';
  }
}

const FILE_PATH = /^\/api\/(chat-files|drive\/files)\/([A-Za-z0-9_-]+)\/content$/;

export function classifyLink(href: string, label: string | undefined, stationBase: string): LinkChip {
  const value = href.trim();
  if (/^(mailto|tel):/i.test(value)) return { kind: 'plain', href: value };
  const words = meaningfulLabel(label, value);

  // a file of this station (relative, or absolute on the station's origin)
  let path = value;
  try {
    const url = new URL(value, stationBase);
    const station = new URL(stationBase);
    if (url.origin === station.origin) path = url.pathname;
  } catch {
    /* not a URL: tried as a path below */
  }
  const file = FILE_PATH.exec(path);
  if (file) return { kind: 'file', path, id: file[2]!, label: words, resolveUrl: `${stationBase.replace(/\/+$/, '')}${path}` };

  const target = linkTarget(value, stationBase);
  if (!target) return { kind: 'plain', href: value };
  if (target.kind === 'external') return { kind: 'site', url: target.url, domain: domainOf(target.url), label: words };
  if (target.kind === 'agent') return { kind: 'object', type: 'page', target, label: words, resolveUrl: '' };
  const hash = value.startsWith('#/') ? value : (() => {
    try {
      return new URL(value).hash;
    } catch {
      return value;
    }
  })();
  const type = objectType(target);
  return { kind: 'object', type, target, label: words, resolveUrl: type === 'page' ? '' : webUrl(stationBase, hash) };
}

/**
 * Where tapping an object chip goes. A document linked by slug opens by the id the station
 * resolved for it (`POST /api/refs/resolve` answers the real id only when the member may read
 * it); until then, or when it is hidden, the sheet looks the slug up itself.
 */
export function chipTarget(target: AppTarget, resolved: { id: string } | undefined): AppTarget {
  if (target.kind === 'doc' && target.slug !== undefined && resolved && isObjectId(resolved.id)) {
    return { kind: 'doc', id: resolved.id };
  }
  return target;
}
