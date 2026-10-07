/**
 * In-app entity deeplinks — VENDORED parse subset of the canonical
 * `packages/types/src/entity-links.ts` (workspace isolation: the mobile app
 * can't import @greenhouse/types). Keep `parseEntityUrl` in lockstep with the
 * canonical one for the core kinds; extension kinds (`ext:*`) are registered at
 * web boot only and are therefore never resolved here.
 *
 * Server tools embed these hash routes in their results so the model can cite
 * a record (`#/knowledge/doc/<id>-<slug>`, `#/projects/<id>`, …). The chat
 * markdown renderer asks `entityRoute()` whether a link is a record it can
 * preview natively — the mobile equivalent of the web's detail peek is a
 * bottom-sheet route (`/peek/doc/<slug>?id=<id>`, `/peek/project/<id>`).
 */

import type { Href } from 'expo-router';

export type EntityRef =
  | { kind: 'project'; id: number }
  | { kind: 'kb_doc'; id: number; slug: string }
  | { kind: 'tables_record'; baseId: number; tableId: number; id: number };

/** A positive integer segment, or null. Rejects `01`, `1.5`, `1e3`, `-1`, ``. */
function toId(raw: string | undefined | null): number | null {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** `?a=1&b=2` → value of `name` (no URLSearchParams dependency on Hermes quirks). */
function queryParam(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    const [k, v] = pair.split('=');
    if (decodeURIComponent(k ?? '') === name) return decodeURIComponent(v ?? '');
  }
  return null;
}

/**
 * Strict inverse of the canonical `entityUrl`: returns null for anything that
 * is not an entity deeplink (so `#/projects` or `#/knowledge` list pages never
 * turn into a peek that can't load).
 */
export function parseEntityUrl(href: string): EntityRef | null {
  const trimmed = href.trim();
  if (!trimmed.startsWith('#/')) return null;

  const [path, ...rest] = trimmed.slice(2).split('?');
  const query = rest.join('?');
  const segments = path.split('/').filter((s) => s !== '');

  // #/projects/<id>
  if (segments[0] === 'projects' && segments.length === 2) {
    const id = toId(segments[1]);
    return id === null ? null : { kind: 'project', id };
  }

  // #/knowledge/doc/<id>-<slug> — the slug may itself contain dashes.
  if (segments[0] === 'knowledge' && segments[1] === 'doc' && segments.length === 3) {
    const dash = segments[2].indexOf('-');
    if (dash <= 0) return null;
    const id = toId(segments[2].slice(0, dash));
    const slug = segments[2].slice(dash + 1);
    return id === null || slug === '' ? null : { kind: 'kb_doc', id, slug };
  }

  // #/tables/<baseId>/table/<tableId>?record=<id>
  if (segments[0] === 'tables' && segments[2] === 'table' && segments.length === 4) {
    const baseId = toId(segments[1]);
    const tableId = toId(segments[3]);
    const recordId = toId(queryParam(query, 'record'));
    if (baseId === null || tableId === null || recordId === null) return null;
    return { kind: 'tables_record', baseId, tableId, id: recordId };
  }

  return null;
}

/**
 * The native preview route for a record, or null when the mobile app has no
 * surface for that kind (Tables records, extension records — web only).
 */
export function entityRoute(ref: EntityRef): Href | null {
  switch (ref.kind) {
    case 'kb_doc':
      // Pass the id too — it's authoritative (a doc's slug can be renamed).
      return { pathname: '/peek/doc/[slug]', params: { slug: ref.slug, id: String(ref.id) } };
    case 'project':
      return { pathname: '/peek/project/[id]', params: { id: String(ref.id) } };
    default:
      return null;
  }
}
