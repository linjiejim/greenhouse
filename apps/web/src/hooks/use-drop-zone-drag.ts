/**
 * Drag an item onto a drop zone — a kanban lane, a calendar day. Built on the
 * one drag sensor (`useDragGesture`), so it starts from any element and on
 * touch by long press, and tests drive it with synthetic PointerEvents.
 *
 * The third semantic layer next to `useListReorder` and the knowledge tree's
 * `useTreeDrag`, because the meaning differs from both: the item does not take
 * a position among siblings (reorder) and there is no "beside vs. into" (tree)
 * — the drop names a *value* (this lane's option, this day), and the caller
 * writes it to the record. Zones are any element carrying `data-drop-zone`;
 * the zone under the pointer wins, nothing under it means no drop.
 */

import { useCallback, useRef, useState } from 'react';
import { useDragGesture } from './use-drag-gesture';

export const DROP_ZONE_ATTR = 'data-drop-zone';

export interface DropZoneDrag<T> {
  /** The item in flight, or null. */
  dragging: T | null;
  /** The zone under the pointer while dragging. */
  over: string | null;
  /** Where the pointer is, for a floating preview (render it with `pointer-events: none`). */
  pointer: { x: number; y: number } | null;
  /** Put on the draggable element's `onPointerDown`. */
  start: (event: React.PointerEvent<HTMLElement>, item: T) => void;
  /** Read-and-clear: true if a drag just finished, so the element's click can be swallowed. */
  didDrag: () => boolean;
  /** Spread onto each drop zone. */
  zoneProps: (zone: string) => Record<string, string>;
}

function zoneAt(x: number, y: number): string | null {
  return document.elementFromPoint(x, y)?.closest(`[${DROP_ZONE_ATTR}]`)?.getAttribute(DROP_ZONE_ATTR) ?? null;
}

/**
 * @param onDrop called once per drop on a zone, with the item and the zone's
 *               value; dropping outside every zone (or pressing Escape) does nothing.
 */
export function useDropZoneDrag<T>(onDrop: (item: T, zone: string) => void): DropZoneDrag<T> {
  const [over, setOver] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const overRef = useRef<string | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const gesture = useDragGesture<T>({
    onMove: (_item, x, y) => {
      const zone = zoneAt(x, y);
      overRef.current = zone;
      setOver(zone);
      setPointer({ x, y });
    },
    // Before onEnd clears the resolved zone (see useDragGesture).
    onDrop: (item) => {
      if (overRef.current !== null) onDropRef.current(item, overRef.current);
    },
    onEnd: () => {
      overRef.current = null;
      setOver(null);
      setPointer(null);
    },
  });

  const zoneProps = useCallback((zone: string) => ({ [DROP_ZONE_ATTR]: zone }), []);

  return { dragging: gesture.dragging, over, pointer, start: gesture.start, didDrag: gesture.didDrag, zoneProps };
}
