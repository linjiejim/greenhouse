/**
 * The web app's hash routes (PRD §6.4) as places in this app. React-free (./app-links.test.ts).
 *
 * Replies link to records with these routes (`#/c/<id>`, `#/runs/<id>`, `#/agents/<id>`,
 * `#/knowledge/<id>` …) and pushes carry them as `url` (`/c/<id>`, without the hash). Only the
 * routes this app has a screen for open here; the rest open in the web app. Ids are rebuilt from
 * what matched, never taken as given.
 */

export type AppRoute =
  | { kind: 'main' }
  | { kind: 'new-chat' }
  | { kind: 'conversation'; id: string }
  | { kind: 'agents' }
  | { kind: 'agent'; id: string }
  | { kind: 'runs' }
  | { kind: 'run'; id: string }
  | { kind: 'notifications' }
  | { kind: 'settings' }
  /** A route of the web app this app has no screen for yet (knowledge, tables, apps, skills). */
  | { kind: 'web'; path: string };

/** An id: starts with a letter or digit, so `.` and `..` never pass as one. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** `#/c/x`, `/c/x` or `c/x` → its route; null when it is not one of the app's routes. */
export function parseAppPath(href: string): AppRoute | null {
  const raw = href.trim();
  const path = raw.startsWith('#/') ? raw.slice(1) : raw.startsWith('/') ? raw : null;
  if (path === null) return null;
  const [pathname] = path.split('?');
  const segments = pathname!
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const [head, id, extra] = segments;
  if (!head) return { kind: 'main' };
  if (head === 'api') return null;
  if (extra !== undefined && head !== 'knowledge' && head !== 'tables' && head !== 'apps') return null;
  switch (head) {
    case 'c':
      if (!id || id === 'main') return { kind: 'main' };
      if (id === 'new') return { kind: 'new-chat' };
      return ID.test(id) ? { kind: 'conversation', id } : null;
    case 'agents':
      if (!id) return { kind: 'agents' };
      return ID.test(id) ? { kind: 'agent', id } : null;
    case 'runs':
      if (!id) return { kind: 'runs' };
      return ID.test(id) ? { kind: 'run', id } : null;
    case 'notifications':
      return id ? null : { kind: 'notifications' };
    case 'settings':
      return { kind: 'settings' };
    case 'knowledge':
    case 'tables':
    case 'apps':
    case 'forms':
    case 'skills':
    case 'admin':
      return { kind: 'web', path: pathname! };
    default:
      return null;
  }
}

/** A signed file of this station (`/api/files/<id>/content?…`), by its path. */
export function isFilePath(href: string): boolean {
  return /^\/api\/files\/[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\/content(\?|$)/.test(href.trim());
}
