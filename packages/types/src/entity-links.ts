/**
 * In-app entity deeplinks — the single source of truth for both directions.
 *
 * Server-side tools embed these strings in their results so the model can cite a
 * record it just read; the browser parses them back out of rendered Markdown to
 * decide which links open a detail peek instead of navigating. Construction and
 * parsing therefore have to agree exactly, which is why they live in one table
 * here rather than as string templates scattered across tools and pages.
 *
 * The URLs are the app's existing hash routes — a record that already has a page
 * already has an address. Only Tables records need an invented form, because a
 * record is in-page state rather than a page of its own.
 *
 * See docs/specs/20260804-entity-references-and-peek.md.
 */

export type CoreEntityKind = 'project' | 'kb_doc' | 'tables_record';

/**
 * A record kind owned by an extension: `ext:<extension id>:<name>`, e.g.
 * `ext:crm:company`. Extensions register a route template (below) instead of
 * editing this module, so a fork's records get deeplinks and peeks without a
 * core change.
 */
export type ExtensionEntityKind = `ext:${string}`;

export type EntityKind = CoreEntityKind | ExtensionEntityKind;

export type EntityRef =
  | { kind: 'project'; id: number }
  | { kind: 'kb_doc'; id: number; slug: string }
  | { kind: 'tables_record'; baseId: number; tableId: number; id: number }
  | { kind: ExtensionEntityKind; id: string | number };

/** Every core kind, in a stable order — useful for exhaustiveness tests and UI menus. */
export const ENTITY_KINDS: readonly CoreEntityKind[] = ['project', 'kb_doc', 'tables_record'];

// ─── Extension kinds ─────────────────────────────────────

export interface ExtensionEntityKindDef {
  /** `ext:<extension id>:<name>`. */
  kind: ExtensionEntityKind;
  /**
   * Hash route with exactly one `:id` segment, e.g. `#/crm/companies/:id`.
   * One template drives both directions, so construction and parsing cannot
   * drift apart — the reason this module exists at all.
   */
  route: string;
}

const extensionKinds = new Map<string, ExtensionEntityKindDef>();

const ROUTE_SHAPE = /^#(?:\/[^/?#]+)+$/;

/** Register the record kinds of one extension. Called at boot from the extension list. */
export function registerEntityKinds(defs: readonly ExtensionEntityKindDef[]): void {
  for (const def of defs) {
    if (!def.kind.startsWith('ext:')) throw new Error(`Entity kind "${def.kind}" must start with "ext:"`);
    if (extensionKinds.has(def.kind)) throw new Error(`Entity kind "${def.kind}" is already registered`);
    if (!ROUTE_SHAPE.test(def.route) || def.route.split('/').filter((s) => s === ':id').length !== 1) {
      throw new Error(
        `Entity kind "${def.kind}" needs a hash route with exactly one ":id" segment (got "${def.route}")`,
      );
    }
    extensionKinds.set(def.kind, def);
  }
}

export function extensionEntityKinds(): readonly ExtensionEntityKindDef[] {
  return [...extensionKinds.values()];
}

/** Test hook — forget kinds registered by a suite. */
export function _resetExtensionEntityKinds(): void {
  extensionKinds.clear();
}

/**
 * Canonical in-app deeplink for a record. The only place these strings are built.
 *
 * `kb_doc` carries both id and slug (`#/knowledge/doc/<id>-<slug>`): the id is
 * authoritative and survives renames, the slug is decorative and only there so a
 * copied link reads like something.
 */
export function entityUrl(ref: EntityRef): string {
  switch (ref.kind) {
    case 'project':
      return `#/projects/${ref.id}`;
    case 'kb_doc':
      return `#/knowledge/doc/${ref.id}-${ref.slug}`;
    case 'tables_record':
      return `#/tables/${ref.baseId}/table/${ref.tableId}?record=${ref.id}`;
    default: {
      const def = extensionKinds.get(ref.kind);
      // An unregistered kind means the extension that owns it is disabled while
      // something still emits its records — fail loudly rather than mint a dead link.
      if (!def) throw new Error(`Unknown entity kind "${ref.kind}" (is its extension enabled?)`);
      return def.route.replace(':id', encodeURIComponent(String(ref.id)));
    }
  }
}

/** A positive integer segment, or null. Rejects `01`, `1.5`, `1e3`, `-1`, ``. */
function toId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Strict inverse of {@link entityUrl}: returns null for anything that is not an
 * entity deeplink.
 *
 * Strictness is the whole point — this is the renderer's only test for "is this
 * link a record reference?", and a loose match would swallow ordinary navigation
 * links (`#/projects`, `#/knowledge`) into a detail peek that can't load.
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
    const recordId = toId(new URLSearchParams(query).get('record') ?? undefined);
    if (baseId === null || tableId === null || recordId === null) return null;
    return { kind: 'tables_record', baseId, tableId, id: recordId };
  }

  // Registered extension kinds — the template matches segment for segment, so
  // `#/crm/companies` (a list page) never resolves to a record.
  for (const def of extensionKinds.values()) {
    const template = def.route.slice(2).split('/');
    if (template.length !== segments.length) continue;
    let id: string | null = null;
    let matched = true;
    for (let i = 0; i < template.length; i++) {
      if (template[i] === ':id') id = decodeURIComponent(segments[i]);
      else if (template[i] !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched && id) return { kind: def.kind, id: toId(id) ?? id };
  }

  return null;
}

/** True when `href` addresses a record we can open in a detail peek. */
export function isEntityUrl(href: string): boolean {
  return parseEntityUrl(href) !== null;
}
