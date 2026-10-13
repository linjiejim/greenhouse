/**
 * Placement and dismissal for every floating layer of the kit: menus, picker panels, the "?"
 * bubble and tooltips (docs/design-system/components.md, 菜单). Panels are `position: fixed`
 * and stay inside the closest `[data-floating-boundary]` ancestor (a preview frame), else the
 * viewport. Menus and pickers close on an outside pointer, a scroll that moves their anchor,
 * Escape or Tab.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { space } from '../tokens/haven';

export const FLOATING_BOUNDARY = '[data-floating-boundary]';

/** Kept between a panel and the boundary edge. */
const EDGE = space['2'];
/** Between a panel and its anchor. */
const GAP = space['1'];

/** The rectangle floating layers stay inside: the closest boundary, else the viewport. */
export function boundaryRect(element: Element | null): DOMRect {
  const boundary = element?.closest(FLOATING_BOUNDARY);
  if (boundary) return boundary.getBoundingClientRect();
  const root = document.documentElement;
  return new DOMRect(0, 0, root.clientWidth || window.innerWidth, root.clientHeight || window.innerHeight);
}

export interface Placement {
  /** The anchor: a trigger's rectangle, or a point (zero size) for a right-click menu. */
  rect: () => DOMRect | null;
  /** The anchor edge the panel opens from; it flips to the opposite edge when there is no room. */
  side?: 'bottom' | 'right';
  /** Position along that edge. */
  align?: 'start' | 'center' | 'end';
  /** At least as wide as the anchor (Select). */
  matchWidth?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** Places a fixed panel next to an anchor and keeps it there while it, the window or the panel resizes. */
export function useFloating<T extends HTMLElement = HTMLDivElement>(open: boolean, placement: Placement) {
  const panel = useRef<T>(null);
  const latest = useRef(placement);
  latest.current = placement;
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: -9999, top: -9999 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const { rect: anchor, side = 'bottom', align = 'start', matchWidth = false } = latest.current;
      const rect = anchor();
      const element = panel.current;
      if (!rect || !element) return;
      if (matchWidth) element.style.minWidth = `${rect.width}px`;
      const frame = boundaryRect(element);
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const gap = rect.width || rect.height ? GAP : 0;
      const along = (start: number, size: number, extent: number) =>
        align === 'end' ? start + size - extent : align === 'center' ? start + (size - extent) / 2 : start;
      let left: number;
      let top: number;
      if (side === 'right') {
        left = rect.right + gap;
        if (left + width > frame.right - EDGE && rect.left - gap - width >= frame.left + EDGE)
          left = rect.left - gap - width;
        top = along(rect.top, rect.height, height);
      } else {
        top = rect.bottom + gap;
        if (top + height > frame.bottom - EDGE && rect.top - gap - height >= frame.top + EDGE)
          top = rect.top - gap - height;
        left = along(rect.left, rect.width, width);
      }
      left = clamp(left, frame.left + EDGE, frame.right - EDGE - width);
      top = clamp(top, frame.top + EDGE, frame.bottom - EDGE - height);
      setStyle({ position: 'fixed', left, top, minWidth: matchWidth ? rect.width : undefined });
    };
    place();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (panel.current) resize?.observe(panel.current);
    window.addEventListener('resize', place);
    return () => {
      resize?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open]);
  return { panel, style };
}

/**
 * Closes a floating layer on a pointer press outside the given elements, or on a scroll that
 * carries them away. A scroll elsewhere (a thread pinning itself to its newest message) leaves
 * the layer open: its anchor did not move.
 */
export function useDismiss(open: boolean, close: () => void, inside: RefObject<HTMLElement | null>[]) {
  const latest = useRef({ close, inside });
  latest.current = { close, inside };
  useEffect(() => {
    if (!open) return;
    const elements = () =>
      latest.current.inside.map((ref) => ref.current).filter((element): element is HTMLElement => !!element);
    const pointer = (event: Event) => {
      if (elements().some((element) => element.contains(event.target as Node))) return;
      latest.current.close();
    };
    const scroll = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      const scroller = !target || target === document ? document.documentElement : target;
      const own = elements();
      if (own.some((element) => element.contains(scroller))) return;
      if (own.some((element) => scroller.contains(element))) latest.current.close();
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
}

/** Arrow keys, Home and End move focus between the enabled items of a list. */
export function moveFocus(container: HTMLElement | null, selector: string, key: string) {
  const items = Array.from(container?.querySelectorAll<HTMLElement>(selector) ?? []);
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : key === 'ArrowDown'
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
  items[next].focus();
}
