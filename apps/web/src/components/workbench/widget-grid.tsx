/**
 * Draggable widget grid — shared by the Home workbench and the Tables dashboard.
 *
 * Two consumers is the whole reason this is a component rather than page-local
 * code (and the reason the dependency is justified at all): collision handling
 * and vertical compaction are exactly the parts of a dashboard grid that are
 * tedious to get right twice.
 *
 * Below the `md` breakpoint the grid degrades to a single column ordered by the
 * saved `y`, and dragging is off — a 12-column drag target on a phone is not a
 * feature. Read mode also disables dragging entirely so a card's own content
 * (links, sorting, buttons) stays clickable.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import GridLayout, { type Layout, type LayoutItem } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';

/**
 * Measure the container ourselves rather than using the library's
 * `useContainerWidth`: that hook stayed on its 1280px default here (the page
 * mounts lazily behind Suspense, so its initial measurement ran before the
 * element had a width and nothing re-measured), which laid a 980px container
 * out at 1280 and pushed the right-hand column off screen.
 */
function useMeasuredWidth() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? element.clientWidth;
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  return { containerRef, width };
}

export interface WidgetGridItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  /** Compact single-column height; desktop height remains the saved `h`. */
  mobileH?: number;
}

interface WidgetGridProps {
  items: WidgetGridItem[];
  /** Rendered inside each grid cell, keyed by item id. */
  renderItem: (id: string) => React.ReactNode;
  /** Drag + resize are only possible in edit mode. */
  editing?: boolean;
  onLayoutChange?: (items: WidgetGridItem[]) => void;
  columns?: number;
  rowHeight?: number;
  /** Width under which the grid collapses to one column. */
  singleColumnBelow?: number;
  className?: string;
}

/** Grid handle class — dragging starts on the card header, not the whole card. */
export const WIDGET_DRAG_HANDLE_CLASS = 'widget-drag-handle';

function toLayout(items: readonly WidgetGridItem[], columns: number): Layout {
  return items.map((item) => ({
    i: item.id,
    x: Math.min(item.x, Math.max(0, columns - item.w)),
    y: item.y,
    w: Math.min(item.w, columns),
    h: item.h,
    minW: item.minW,
    minH: item.minH,
  }));
}

function fromLayout(layout: readonly LayoutItem[], items: readonly WidgetGridItem[]): WidgetGridItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return layout.flatMap((entry) => {
    const source = byId.get(entry.i);
    return source ? [{ ...source, x: entry.x, y: entry.y, w: entry.w, h: entry.h }] : [];
  });
}

function sameLayout(left: readonly WidgetGridItem[], right: readonly WidgetGridItem[]): boolean {
  if (left.length !== right.length) return false;
  const byId = new Map(right.map((item) => [item.id, item]));
  return left.every((item) => {
    const other = byId.get(item.id);
    return other && other.x === item.x && other.y === item.y && other.w === item.w && other.h === item.h;
  });
}

export function WidgetGrid({
  items,
  renderItem,
  editing = false,
  onLayoutChange,
  columns = 12,
  rowHeight = 52,
  singleColumnBelow = 768,
  className,
}: WidgetGridProps) {
  const { width, containerRef } = useMeasuredWidth();
  // Driven by the measured container, not `window.innerWidth`: the sidebar can
  // collapse without a window resize, and a window that reports 0 (offscreen or
  // pre-layout) would otherwise latch the grid into single-column until the
  // next resize event that may never come.
  const narrow = width > 0 && width < singleColumnBelow;

  const ordered = useMemo(() => [...items].sort((left, right) => left.y - right.y || left.x - right.x), [items]);

  // One return, and the measured container is always mounted. An early return
  // for the narrow case would leave the ref unattached on the first render, and
  // since the observer is set up once, the grid could never learn its width if
  // the viewport started narrow (or was measured before layout settled).
  return (
    <div ref={containerRef} className={className}>
      {narrow ? (
        // Single column: the saved layout still decides the order, but nothing
        // is draggable and every card takes the full width.
        <div className="flex flex-col gap-3">
          {ordered.map((item) => (
            // An explicit height gives the child's `h-full` a containing block.
            // `minHeight` left the card at intrinsic height and the unused saved
            // grid height became an invisible gap between mobile cards.
            <div key={item.id} style={{ height: Math.max(item.minH ?? 1, item.mobileH ?? item.h) * 48 }}>
              {renderItem(item.id)}
            </div>
          ))}
        </div>
      ) : (
        // Nothing is laid out until the container has been measured — rendering
        // at a guessed width makes every card jump on the first real measure.
        width > 0 && (
          <GridLayout
            width={width}
            layout={toLayout(items, columns)}
            gridConfig={{ cols: columns, rowHeight, margin: [12, 12], containerPadding: [0, 0] }}
            dragConfig={{ enabled: editing, bounded: false, handle: `.${WIDGET_DRAG_HANDLE_CLASS}` }}
            resizeConfig={{ enabled: editing }}
            onLayoutChange={(layout) => {
              if (!onLayoutChange) return;
              const next = fromLayout(layout, items);
              // RGL emits on mount and on every compaction pass; only report real moves.
              if (!sameLayout(next, items)) onLayoutChange(next);
            }}
          >
            {items.map((item) => (
              <div key={item.id}>{renderItem(item.id)}</div>
            ))}
          </GridLayout>
        )
      )}
    </div>
  );
}
