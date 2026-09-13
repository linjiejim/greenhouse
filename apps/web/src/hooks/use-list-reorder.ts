/**
 * Drag-to-reorder for a flat list — the shared implementation for every simple
 * "drag a row up or down" in the app (pinned modules, session tags, session
 * groups). Built on `useDragGesture`, so it works from any element (including
 * `<button>`, which HTML5 DnD refuses) and on touch via long-press.
 *
 * Semantics are deliberately the simplest thing that reads correctly in both a
 * column and a grid: **the dragged item takes the position of whatever item is
 * under the pointer**. No insertion lines, no before/after bands — those need an
 * axis, and the pinned modules are a wrapping grid where "above/below" is not a
 * meaningful question. The list re-renders in the previewed order while the
 * drag is in flight, which is its own feedback.
 *
 * The tree (`use-tree-drag.ts`) keeps its own richer model: it has to express
 * "into this folder" as well as "next to it", which a flat list never does.
 */

import { useCallback, useRef, useState } from 'react';
import { useDragGesture } from './use-drag-gesture';

const ITEM_ATTR = 'data-reorder-id';

/** `ids` with `id` moved to `index`, accounting for its own removal. */
export function moveTo<Id>(ids: Id[], id: Id, index: number): Id[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, id);
  return next;
}

export function isSameOrder<Id>(a: Id[], b: Id[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export interface ListReorder<Id> {
  /** Render this order: the live preview while dragging, the real one otherwise. */
  order: Id[];
  draggingId: Id | null;
  /** Spread onto each row: drag source and drop target in one. */
  itemProps: (id: Id) => Record<string, unknown>;
  /** Read-and-clear: true if a drag just finished, so the row's click can be swallowed. */
  didDrag: () => boolean;
}

/**
 * @param ids     current order (ids only — the caller owns the objects)
 * @param onCommit called on drop with the new order, only when it actually changed
 */
export function useListReorder<Id extends string | number>(ids: Id[], onCommit: (next: Id[]) => void): ListReorder<Id> {
  const [preview, setPreview] = useState<Id[] | null>(null);
  const previewRef = useRef<Id[] | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const setPreviewOrder = useCallback((next: Id[] | null) => {
    previewRef.current = next;
    setPreview(next);
  }, []);

  const parse = useCallback((el: Element | null): Id | null => {
    const row = el?.closest(`[${ITEM_ATTR}]`);
    const raw = row?.getAttribute(ITEM_ATTR);
    if (raw == null) return null;
    // ids come back from the DOM as strings; match them against the real ones
    // rather than guessing the type back.
    return (idsRef.current.find((id) => String(id) === raw) ?? null) as Id | null;
  }, []);

  const gesture = useDragGesture<Id>({
    onMove: (id, x, y) => {
      const over = parse(document.elementFromPoint(x, y));
      if (over == null || over === id) return;
      const current = previewRef.current ?? idsRef.current;
      const index = current.indexOf(over);
      if (index < 0) return;
      setPreviewOrder(moveTo(current, id, index));
    },
    onDrop: () => {
      const next = previewRef.current;
      if (next && !isSameOrder(idsRef.current, next)) onCommit(next);
    },
    onEnd: () => setPreviewOrder(null),
  });

  const itemProps = useCallback(
    (id: Id) => ({
      [ITEM_ATTR]: String(id),
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => gesture.start(e, id),
    }),
    [gesture],
  );

  return {
    // Preview is dropped on pointerup; the caller's own state arrives with the
    // committed order, so there is no frame where both are stale.
    order: preview ?? ids,
    draggingId: gesture.dragging,
    itemProps,
    didDrag: gesture.didDrag,
  };
}
