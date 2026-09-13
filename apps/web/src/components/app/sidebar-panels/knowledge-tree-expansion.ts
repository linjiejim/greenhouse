/**
 * Persisted expansion state for the knowledge sidebar tree.
 *
 * The stored set is the **expanded** folder ids, so the natural empty state — a
 * browser that has never touched the tree — reads as "everything collapsed",
 * which is the default the sidebar wants. It used to store the *collapsed* ids,
 * where empty meant "everything expanded"; browsers still carrying that key are
 * migrated once, in place, as soon as the folder list is known (the new set is
 * "every folder id minus the collapsed ones", so the old preference survives).
 *
 * Each scope tab persists independently and migrates independently.
 *
 * Every storage access swallows its errors: a private-mode or quota-full browser
 * must lose the preference, not the sidebar.
 */

/** Tree scopes map 1:1 onto the kb drive folder visibility. */
export type TreeScope = 'team' | 'private';

/** Current semantics: ids of the folders the user has expanded. */
export function expandedKey(scope: TreeScope): string {
  return `kb-tree-expanded-${scope}`;
}

/** Pre-flip semantics: ids of the folders the user had collapsed (read-only). */
export function legacyCollapsedKey(scope: TreeScope): string {
  return `kb-tree-collapsed-${scope}`;
}

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parseIds(raw: string | null): Set<number> {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : []);
  } catch {
    return new Set();
  }
}

/**
 * Read the expanded set for a scope.
 *
 * - new key present → parse it (anything unparseable degrades to "all collapsed")
 * - only the legacy key present → `null`, i.e. *migration pending*: the caller
 *   has to supply the folder ids before the set can be computed
 * - neither present → empty set (all collapsed — the default for a new browser)
 */
export function loadExpanded(scope: TreeScope): Set<number> | null {
  const raw = readItem(expandedKey(scope));
  if (raw !== null) return parseIds(raw);
  if (readItem(legacyCollapsedKey(scope)) !== null) return null;
  return new Set();
}

export function saveExpanded(scope: TreeScope, ids: Set<number>): void {
  try {
    localStorage.setItem(expandedKey(scope), JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

/** Legacy → current: every known folder id except the ones stored as collapsed. */
export function migrateLegacyExpanded(scope: TreeScope, folderIds: number[]): Set<number> {
  const collapsed = parseIds(readItem(legacyCollapsedKey(scope)));
  return new Set(folderIds.filter((id) => !collapsed.has(id)));
}

/** Drop the legacy key once its scope has been migrated (migration runs once). */
export function dropLegacyKey(scope: TreeScope): void {
  try {
    localStorage.removeItem(legacyCollapsedKey(scope));
  } catch {
    /* ignore */
  }
}
