/**
 * Global-search sources contributed by extensions.
 *
 * Core searches three domains (conversations, projects, knowledge) with a lane
 * each in `routes/search.ts`. An extension that owns records registers a lane
 * here instead of editing that route; the palette renders whatever groups come
 * back, so nothing else in core has to know the kind exists.
 *
 * A lane is read-only and must apply its own permission check — the route runs
 * every lane for the calling user and swallows failures per lane, exactly as it
 * does for the core three.
 */
import type { DatabaseProvider } from '@greenhouse/db';
import type { SearchHit } from '@greenhouse/types/search';
import type { UserRole } from '@greenhouse/types/api';

export interface SearchSourceContext {
  query: string;
  /** Rows to fetch; the route asks for one more than it shows to compute `hasMore`. */
  limit: number;
  userId: string;
  userRole: UserRole;
  db: DatabaseProvider;
}

export interface SearchSource {
  /** The entity kind this lane returns, e.g. `ext:crm:company`. Also the group key. */
  kind: string;
  search: (ctx: SearchSourceContext) => Promise<SearchHit[]>;
}

const sources: SearchSource[] = [];

export function registerSearchSources(defs: readonly SearchSource[]): void {
  for (const def of defs) {
    if (sources.some((s) => s.kind === def.kind)) throw new Error(`Search source "${def.kind}" is already registered`);
    sources.push(def);
  }
}

export function extensionSearchSources(): readonly SearchSource[] {
  return sources;
}

/** Test hook — forget sources registered by a suite. */
export function _resetExtensionSearchSources(): void {
  sources.length = 0;
}
