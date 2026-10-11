/** @vitest-environment happy-dom */

/**
 * The shared widget grid reports only what a person did. react-grid-layout
 * emits `onLayoutChange` on mount after pushing overlaps apart and compacting
 * (a stored layout below the minimum sizes always overlaps once clamped), and
 * reporting that rewrote a dashboard's stored layout just by opening it. The
 * library is replaced by a stand-in that behaves the same way.
 */

import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventCallback, Layout } from 'react-grid-layout';
import { WidgetGrid, type WidgetGridItem } from './widget-grid';

/** Where the stand-in "compacts" the pivot to on mount, and where a drag drops it. */
const compacted: Layout = [
  { i: 'kpi', x: 0, y: 0, w: 4, h: 3 },
  { i: 'pivot', x: 6, y: 3, w: 6, h: 9 },
];
const dragged: Layout = [
  { i: 'kpi', x: 0, y: 0, w: 4, h: 3 },
  { i: 'pivot', x: 4, y: 0, w: 6, h: 9 },
];

const grid = vi.hoisted(() => ({
  props: null as null | {
    onLayoutChange?: (layout: Layout) => void;
    onDragStart?: EventCallback;
    onDragStop?: EventCallback;
  },
}));

vi.mock('react-grid-layout', () => ({
  default: function FakeGridLayout(props: {
    onLayoutChange?: (layout: Layout) => void;
    onDragStart?: EventCallback;
    onDragStop?: EventCallback;
    children: React.ReactNode;
  }) {
    grid.props = props;
    // Like RGL: resolve collisions / compact, then announce the result on mount.
    useEffect(() => props.onLayoutChange?.(compacted), []); // eslint-disable-line react-hooks/exhaustive-deps
    return <div>{props.children}</div>;
  },
}));
vi.mock('react-grid-layout/css/styles.css', () => ({}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items: WidgetGridItem[] = [
  { id: 'kpi', x: 0, y: 0, w: 4, h: 3, minW: 3, minH: 3 },
  // Stored at w:4, clamped up to its minimum of 6: now it overlaps.
  { id: 'pivot', x: 6, y: 0, w: 6, h: 9, minW: 6, minH: 4 },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalResizeObserver = globalThis.ResizeObserver;
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

beforeEach(() => {
  // A measured, desktop-wide container.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback([{ contentRect: { width: 1200 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.ResizeObserver = originalResizeObserver;
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
  grid.props = null;
});

describe('WidgetGrid', () => {
  it('does not report the layout it was drawn with, only a drag that changed it', async () => {
    const onLayoutChange = vi.fn();
    await act(async () => {
      root.render(
        <WidgetGrid items={items} editing onLayoutChange={onLayoutChange} renderItem={(id) => <span>{id}</span>} />,
      );
    });
    expect(grid.props).not.toBeNull();
    // Opening the dashboard: the library compacted and announced it; nothing is saved.
    expect(onLayoutChange).not.toHaveBeenCalled();

    // A click on the handle that moves nothing is not a change either.
    const event = new Event('mouseup');
    await act(async () => {
      grid.props!.onDragStart?.(compacted, null, null, null, event, null);
      grid.props!.onDragStop?.(compacted, null, null, null, event, null);
    });
    expect(onLayoutChange).not.toHaveBeenCalled();

    // A real drag reports the arrangement the person sees.
    await act(async () => {
      grid.props!.onDragStart?.(compacted, null, null, null, event, null);
      grid.props!.onDragStop?.(dragged, null, null, null, event, null);
    });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    expect(onLayoutChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'kpi', x: 0, y: 0, w: 4, h: 3 }),
      expect.objectContaining({ id: 'pivot', x: 4, y: 0, w: 6, h: 9 }),
    ]);
  });

  it('tells its host whether it is one column, from its own measurement and threshold', async () => {
    const onSingleColumnChange = vi.fn();
    await act(async () => {
      root.render(
        <WidgetGrid
          items={items}
          editing
          singleColumnBelow={1300}
          onSingleColumnChange={onSingleColumnChange}
          renderItem={(id) => <span>{id}</span>}
        />,
      );
    });
    // 1200px measured, under the host's 1300 threshold: one column, and no grid to drag.
    expect(onSingleColumnChange).toHaveBeenLastCalledWith(true);
    expect(grid.props).toBeNull();

    await act(async () => {
      root.render(
        <WidgetGrid
          items={items}
          editing
          singleColumnBelow={480}
          onSingleColumnChange={onSingleColumnChange}
          renderItem={(id) => <span>{id}</span>}
        />,
      );
    });
    expect(onSingleColumnChange).toHaveBeenLastCalledWith(false);
    expect(grid.props).not.toBeNull();
  });
});
