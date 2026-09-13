/**
 * The drag *sensor*: when does a press become a drag, and where is the pointer.
 *
 * Everything that drags in this app is built on this rather than on HTML5 DnD
 * (`draggable` + dragstart/dragover/drop), for two reasons learned the hard way
 * in 2026-08:
 *
 * - **HTML5 DnD does not start from a `<button>`.** A form control swallows the
 *   mousedown the browser needs to begin a native drag, in every engine. The KB
 *   tree shipped with rows that were buttons and the drag was totally dead — no
 *   ghost, no drop target, nothing — while the code looked correct.
 * - **CDP's drag API cannot prove a drag works.** It injects dragover/drop and
 *   skips the very step the browser refuses, so automation passed on a dead
 *   feature. Pointer events fire on any element and a synthetic PointerEvent
 *   takes exactly the same path as a real one, so tests here are honest.
 *
 * The sensor model follows dnd-kit (distance for mice, long-press for touch);
 * the library itself is ~30 kB plus rewriting each list into its collision and
 * sortable abstractions, which a handful of sidebar lists do not need.
 *
 * This hook knows nothing about lists, trees or drop targets — it reports
 * "a drag started / the pointer is here / it ended here". Layer the meaning on
 * top: `useListReorder` for flat lists, `useTreeDrag` for the knowledge tree.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Mouse: start dragging once the pointer has travelled this far. */
export const DISTANCE_ACTIVATION_PX = 5;
/** Touch: start dragging after this long a press… */
export const LONG_PRESS_MS = 400;
/** …unless the finger moved further than this first (that gesture is a scroll). */
export const LONG_PRESS_TOLERANCE_PX = 8;
/**
 * Dragging within this many pixels of the scroller's edge scrolls it. Kept
 * small: these are short sidebar lists, and a wide zone means the last rows can
 * never be hovered without the list creeping away underneath.
 */
const EDGE_SCROLL_PX = 24;
const EDGE_SCROLL_STEP = 12;

/** Marks a control inside a draggable row that must never start a drag (a `⋯` menu, an input). */
export const NO_DRAG_ATTR = 'data-no-drag';

export interface DragGestureCallbacks<T> {
  /** The drag became real (distance or long press passed). */
  onStart?: (item: T) => void;
  /** Pointer moved while dragging. Resolve the drop target here. */
  onMove: (item: T, clientX: number, clientY: number) => void;
  /** Released while dragging — commit whatever `onMove` last resolved. */
  onDrop: (item: T) => void;
  /** Always runs when the gesture ends, dropped or cancelled. */
  onEnd?: () => void;
}

export interface DragGesture<T> {
  /** The item being dragged, or null. */
  dragging: T | null;
  /** Put on the row's `onPointerDown`. */
  start: (e: React.PointerEvent<HTMLElement>, item: T) => void;
  /** Read-and-clear: true if a drag just finished, so the row's click can be swallowed. */
  didDrag: () => boolean;
}

/** Nearest ancestor that actually scrolls, for the edge auto-scroll. */
function scrollerFor(el: HTMLElement | null): HTMLElement | null {
  let cursor: HTMLElement | null = el;
  while (cursor && cursor.scrollHeight <= cursor.clientHeight + 1) cursor = cursor.parentElement;
  return cursor;
}

export function useDragGesture<T>(callbacks: DragGestureCallbacks<T>): DragGesture<T> {
  const [dragging, setDragging] = useState<T | null>(null);

  // Everything mutable for the gesture in flight. Window listeners are bound on
  // pointerdown and released on pointerup, so nothing survives idle.
  const gesture = useRef<{
    pointerId: number;
    item: T;
    startX: number;
    startY: number;
    active: boolean;
    longPress?: number;
    element: HTMLElement;
    detach: () => void;
  } | null>(null);
  const draggedRef = useRef(false);
  const clearDragged = useRef<number | null>(null);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const finish = useCallback(() => {
    const g = gesture.current;
    if (!g) return;
    if (g.longPress) window.clearTimeout(g.longPress);
    if (g.active) {
      // The click the browser synthesises after pointerup has to be swallowed,
      // or the drop also "opens" the row. But that click only reaches the row
      // when the gesture started and ended on it — drop somewhere else and the
      // click goes to a common ancestor instead, leaving the flag set to eat
      // the user's NEXT click. So it expires on its own: the synthetic click
      // arrives before this timeout, nothing else does.
      if (clearDragged.current) window.clearTimeout(clearDragged.current);
      clearDragged.current = window.setTimeout(() => {
        draggedRef.current = false;
        clearDragged.current = null;
      }, 0);
    }
    try {
      g.element.releasePointerCapture(g.pointerId);
    } catch {
      /* already released, or capture never taken */
    }
    g.detach();
    gesture.current = null;
    setDragging(null);
    cbRef.current.onEnd?.();
  }, []);

  const activate = useCallback(() => {
    const g = gesture.current;
    if (!g || g.active) return;
    g.active = true;
    draggedRef.current = true;
    setDragging(g.item);
    try {
      g.element.setPointerCapture(g.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }
    cbRef.current.onStart?.(g.item);
  }, []);

  const start = useCallback(
    (e: React.PointerEvent<HTMLElement>, item: T) => {
      // Primary button only, and never from a control that opted out.
      if (e.button !== 0 || gesture.current) return;
      if ((e.target as HTMLElement).closest(`[${NO_DRAG_ATTR}]`)) return;

      const element = e.currentTarget;

      const onMove = (ev: PointerEvent) => {
        const g = gesture.current;
        if (!g || ev.pointerId !== g.pointerId) return;
        const travelled = Math.hypot(ev.clientX - g.startX, ev.clientY - g.startY);

        if (!g.active) {
          if (ev.pointerType === 'touch') {
            // A finger that moves before the long press is scrolling the list.
            if (travelled > LONG_PRESS_TOLERANCE_PX) finish();
            return;
          }
          if (travelled < DISTANCE_ACTIVATION_PX) return;
          activate();
        }

        // Stop the browser from turning the drag into a text selection.
        ev.preventDefault();
        cbRef.current.onMove(g.item, ev.clientX, ev.clientY);

        const scroller = scrollerFor(g.element);
        if (scroller) {
          const rect = scroller.getBoundingClientRect();
          if (ev.clientY - rect.top < EDGE_SCROLL_PX) scroller.scrollTop -= EDGE_SCROLL_STEP;
          else if (rect.bottom - ev.clientY < EDGE_SCROLL_PX) scroller.scrollTop += EDGE_SCROLL_STEP;
        }
      };

      const onUp = (ev: PointerEvent) => {
        const g = gesture.current;
        if (!g || ev.pointerId !== g.pointerId) return;
        // onDrop BEFORE finish(): `onEnd` is where callers clear the resolved
        // drop target, so finishing first hands onDrop an empty target and the
        // drop silently does nothing.
        if (g.active) cbRef.current.onDrop(g.item);
        finish();
      };

      const onCancel = () => finish();
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') finish();
      };

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey);

      gesture.current = {
        pointerId: e.pointerId,
        item,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        element,
        detach: () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('keydown', onKey);
        },
      };
      if (e.pointerType === 'touch') {
        gesture.current.longPress = window.setTimeout(activate, LONG_PRESS_MS);
      }
    },
    [activate, finish],
  );

  // A gesture in flight when the list unmounts would leak its listeners.
  useEffect(
    () => () => {
      gesture.current?.detach();
      if (clearDragged.current) window.clearTimeout(clearDragged.current);
    },
    [],
  );

  const didDrag = useCallback(() => {
    const dragged = draggedRef.current;
    draggedRef.current = false;
    return dragged;
  }, []);

  return { dragging, start, didDrag };
}
