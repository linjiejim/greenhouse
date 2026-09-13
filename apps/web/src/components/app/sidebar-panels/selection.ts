/**
 * Selection reducers for the chat-history multi-select mode.
 *
 * Kept as pure functions (no React) so the tricky range / prune semantics are
 * unit-testable in isolation.
 *
 * The list renders *occurrences*, not sessions: Pinned is cross-cutting, so a
 * session that is both pinned and filed into a folder is drawn twice. Ranges
 * are therefore computed over `SelectableRow.key` (unique per rendered row)
 * while the selection itself stays keyed by `id` (the session the batch acts
 * on). Ranging over bare ids instead would make a Shift-click on the folder
 * copy resolve to the pinned copy near the top of the list and silently sweep
 * in every row between them.
 *
 * `rows` is the single source of truth for "visible render order" and only ever
 * contains currently-visible (un-collapsed) rows — range selection therefore
 * never reaches into a collapsed section.
 */

export interface SelectableRow {
  /** Unique per rendered occurrence, e.g. `pinned|<id>` vs `g:3|<id>`. */
  key: string;
  /** Session id — may repeat across sections. */
  id: string;
}

/**
 * Shift-click range select: union `prev` with the session ids of the inclusive
 * span between `anchorKey` and `targetKey` in `rows`. If either end is missing
 * (anchor never set, or its row scrolled out of the visible set) only the
 * target row's own session is added.
 */
export function rangeSelect(
  rows: readonly SelectableRow[],
  anchorKey: string | null,
  targetKey: string,
  prev: ReadonlySet<string>,
): Set<string> {
  const next = new Set(prev);
  const anchorIdx = anchorKey == null ? -1 : rows.findIndex((r) => r.key === anchorKey);
  const targetIdx = rows.findIndex((r) => r.key === targetKey);
  if (targetIdx === -1) return next;
  if (anchorIdx === -1) {
    next.add(rows[targetIdx].id);
    return next;
  }
  const lo = Math.min(anchorIdx, targetIdx);
  const hi = Math.max(anchorIdx, targetIdx);
  for (let i = lo; i <= hi; i++) next.add(rows[i].id);
  return next;
}

/** Toggle a single id (plain click / Cmd-click semantics). */
export function toggleOne(prev: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Drop selected ids that no longer exist after a list refresh — keeps the
 * survivors ticked ("刷新维持勾选"). Returns the same reference when nothing
 * changed so callers can skip a needless re-render.
 */
export function pruneMissing(selected: ReadonlySet<string>, existingIds: ReadonlySet<string> | string[]): Set<string> {
  const exists = Array.isArray(existingIds) ? new Set(existingIds) : existingIds;
  let changed = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (exists.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : (selected as Set<string>);
}
