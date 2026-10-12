/** @vitest-environment happy-dom */

/**
 * The builder canvas: one breakpoint decides whether cards drag — the shared
 * grid's own measurement — and the hint and the drag handles follow it, so
 * nothing promises a drag the grid does not do. Reordering from the card menu
 * moves places only; every card keeps its size. The page-tab layout keeps the
 * canvas at least that wide before it puts columns beside it.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCard, AppPage } from '@greenhouse/types/apps';
import { I18nProvider } from '../../../lib/i18n';
import { CANVAS_SINGLE_COLUMN_BELOW, PageCanvas, swapWithNeighbour } from './canvas';
import { pagesTabLayout } from './pages-tab';
import { REQUESTS, schemaFixture } from './test-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const grid = vi.hoisted(() => ({ rendered: 0, dragEnabled: undefined as boolean | undefined }));
vi.mock('react-grid-layout', () => ({
  default: function FakeGridLayout(props: { dragConfig?: { enabled?: boolean }; children: React.ReactNode }) {
    grid.rendered += 1;
    grid.dragEnabled = props.dragConfig?.enabled;
    return <div data-testid="grid-layout">{props.children}</div>;
  },
}));
vi.mock('react-grid-layout/css/styles.css', () => ({}));

const originalResizeObserver = globalThis.ResizeObserver;
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
let measuredWidth = 0;

function card(id: string, layout: AppCard['layout']): AppCard {
  return { id, kind: 'records', title: id, layout, source: { tableId: REQUESTS }, fieldIds: [1] };
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  grid.rendered = 0;
  grid.dragEnabled = undefined;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => measuredWidth });
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback(
        [{ contentRect: { width: measuredWidth } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  globalThis.ResizeObserver = originalResizeObserver;
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
});

async function mountCanvas(width: number, cards?: AppCard[]) {
  measuredWidth = width;
  const page: AppPage = {
    id: 'home',
    title: 'Home',
    cards: cards ?? [card('mine', { x: 0, y: 0, w: 6, h: 6 }), card('all', { x: 6, y: 0, w: 6, h: 6 })],
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="en">
        <PageCanvas
          page={page}
          schema={schemaFixture()}
          errors={[]}
          selectedCardId={null}
          onSelect={() => undefined}
          onLayout={() => undefined}
          onRemove={() => undefined}
          onAdd={() => undefined}
        />
      </I18nProvider>,
    ),
  );
}

describe('the canvas grid', () => {
  it('drags and resizes on a laptop-width canvas (narrower than a runtime page), and says so', async () => {
    // A 1440px window with the sidebar open leaves the canvas column about 520px.
    await mountCanvas(520);
    expect(grid.rendered).toBeGreaterThan(0);
    expect(grid.dragEnabled).toBe(true);
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.textContent).toContain('Drag a card by its title to move it');
    expect(container.querySelectorAll('.widget-drag-handle')).toHaveLength(2);
  });

  it('describes external configuration without fetching results, and shows custom execution as unavailable', async () => {
    await mountCanvas(520, [
      {
        id: 'external',
        kind: 'external',
        layout: { x: 0, y: 0, w: 6, h: 4 },
        source: {
          kind: 'connector',
          server: 'metrics',
          tool: 'summary',
          input: {},
          map: { kind: 'kpi', value: '/total' },
        },
      },
      { id: 'custom', kind: 'custom', layout: { x: 6, y: 0, w: 6, h: 4 }, html: '<p>Do not run</p>', bindings: [] },
    ]);
    expect(container.textContent).toContain('Source: metrics / summary');
    expect(container.textContent).toContain('Display: Number');
    expect(container.textContent).toContain('Data bindings: 0');
    expect(container.textContent).toContain('cannot run yet');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).not.toContain('Do not run');
  });

  it('says to use the card menu when the grid it drew is one column, and offers no drag handle', async () => {
    await mountCanvas(CANVAS_SINGLE_COLUMN_BELOW - 1);
    expect(grid.rendered).toBe(0);
    expect(container.textContent).toContain('Its menu moves it earlier or later.');
    expect(container.textContent).not.toContain('Drag a card');
    expect(container.querySelectorAll('.widget-drag-handle')).toHaveLength(0);
  });
});

describe('the page tab layout', () => {
  it('puts columns beside the canvas only while the canvas keeps its grid width', () => {
    // Unmeasured: the desktop layout.
    expect(pagesTabLayout(0)).toBe('columns');
    // 13rem list + 24rem properties + two 1rem gaps + the canvas minimum.
    expect(pagesTabLayout(208 + 384 + 32 + CANVAS_SINGLE_COLUMN_BELOW)).toBe('columns');
    expect(pagesTabLayout(208 + 384 + 32 + CANVAS_SINGLE_COLUMN_BELOW - 1)).toBe('beside');
    expect(pagesTabLayout(384 + 16 + CANVAS_SINGLE_COLUMN_BELOW)).toBe('beside');
    expect(pagesTabLayout(384 + 16 + CANVAS_SINGLE_COLUMN_BELOW - 1)).toBe('stacked');
  });
});

describe('moving a card earlier or later', () => {
  it('changes places only: each card keeps its own size', () => {
    const records = card('records', { x: 0, y: 0, w: 12, h: 6 });
    const kpi = card('kpi', { x: 0, y: 6, w: 3, h: 2 });
    expect(swapWithNeighbour([records, kpi], 'records', 1)).toEqual([
      { id: 'kpi', x: 0, y: 0, w: 3, h: 2 },
      { id: 'records', x: 0, y: 2, w: 12, h: 6 },
    ]);
    expect(swapWithNeighbour([records, kpi], 'kpi', -1)).toEqual([
      { id: 'kpi', x: 0, y: 0, w: 3, h: 2 },
      { id: 'records', x: 0, y: 2, w: 12, h: 6 },
    ]);
  });

  it('keeps two cards of one row side by side when they still fit, and stays inside the twelve columns', () => {
    const left = card('left', { x: 0, y: 0, w: 4, h: 3 });
    const right = card('right', { x: 4, y: 0, w: 8, h: 5 });
    expect(swapWithNeighbour([left, right], 'right', -1)).toEqual([
      { id: 'right', x: 0, y: 0, w: 8, h: 5 },
      { id: 'left', x: 8, y: 0, w: 4, h: 3 },
    ]);

    const narrow = card('narrow', { x: 6, y: 0, w: 6, h: 2 });
    const wide = card('wide', { x: 0, y: 2, w: 12, h: 4 });
    expect(swapWithNeighbour([narrow, wide], 'wide', -1)).toEqual([
      { id: 'wide', x: 0, y: 0, w: 12, h: 4 },
      { id: 'narrow', x: 6, y: 4, w: 6, h: 2 },
    ]);
    expect(swapWithNeighbour([narrow, wide], 'narrow', -1)).toBeNull();
  });
});
