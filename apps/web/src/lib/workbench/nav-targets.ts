/**
 * Navigation card targets → in-app hrefs and icons.
 *
 * The single place a {@link NavTarget} becomes a URL. Cards store a typed
 * reference, never a raw hash: knowledge alone has doc / folder / wiki /
 * internal / personal route shapes, so a stored string would rot the next time
 * a route moves — and an opaque string can't be permission-checked at all.
 *
 * Entity hrefs come from `@greenhouse/types/entity-links`, the same table the
 * Markdown renderer and the search palette use, so a pinned record and a linked
 * record resolve identically.
 */

import { entityUrl, type EntityKind } from '@greenhouse/types/entity-links';
import type { NavTarget } from '@greenhouse/types/workbench';
import { BookOpen, FolderKanban, LayoutGrid, Table2, type LucideIcon } from '../icons';
import type { PlatformApplication } from '../../platform/catalog';
import { platformApplicationHref, platformApplicationIcon } from '../../platform/catalog';

const ENTITY_ICONS: Record<EntityKind, LucideIcon> = {
  project: FolderKanban,
  kb_doc: BookOpen,
  tables_record: Table2,
};

export interface ResolvedNavTarget {
  /** Null when the target has no reachable page (e.g. an Agent/MCP-only app). */
  href: string | null;
  icon: LucideIcon;
}

export function resolveNavTarget(target: NavTarget, applications: readonly PlatformApplication[]): ResolvedNavTarget {
  if (target.type === 'app') {
    const application = applications.find((candidate) => candidate.id === target.appId);
    // An app missing from the catalog is one this user may no longer open; the
    // card greys out rather than linking into a route that will fail closed.
    if (!application) return { href: null, icon: LayoutGrid };
    return { href: platformApplicationHref(application), icon: platformApplicationIcon(application) };
  }
  return { href: entityUrl(target.ref), icon: ENTITY_ICONS[target.ref.kind] };
}
