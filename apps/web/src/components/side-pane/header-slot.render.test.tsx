/**
 * @vitest-environment happy-dom
 *
 * The pane has exactly one header row, and a body's controls belong in it.
 *
 * This is the regression for the duplicated chrome an HTML preview used to
 * show: the pane titled the document, then the body titled it again one row
 * lower and hung its toolbar off that second row. So the assertions are about
 * position — one title, and the body's buttons inside the pane header, left of
 * the pane's own full-screen and close controls.
 *
 * Client rendering rather than `renderToStaticMarkup`: zustand serves the
 * *initial* state as its server snapshot, so a statically rendered pane is
 * always the closed one, and portals need a real DOM anyway.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatSidePane } from './chat-side-pane';
import { openSidePane, useSidePaneStore } from '../../stores/side-pane-store';

const PAGE = '<!doctype html><html><body><h1>Report</h1></body></html>';
const TITLE = 'Sprinkler category research';

/** React only batches `act()` when the environment opts in. */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

let container: HTMLElement;
let root: Root;

/** Mount the pane with an HTML preview open and its lazy body resolved. */
async function mountPane(): Promise<void> {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  openSidePane({ kind: 'html', code: PAGE, title: TITLE });

  root = createRoot(container);
  await act(async () => {
    root.render(<ChatSidePane />);
  });
  // The body is lazy(); resolving its chunk and flushing lets it portal its
  // toolbar into the header.
  await import('./html-preview');
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function headerButtons(header: Element | null): (string | null)[] {
  return [...(header?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label'));
}

beforeEach(mountPane);

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSidePaneStore.getState().close();
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
});

describe('side pane header', () => {
  it('names the document once', () => {
    // Twice meant the pane title and the body title, stacked.
    const labels = [...container.querySelectorAll('*')].filter((el) => el.textContent?.trim() === TITLE);
    expect(labels).toHaveLength(1);
  });

  it('puts the preview controls in the pane header, left of the pane controls', () => {
    const header = container.querySelector('aside > div');
    expect(header).not.toBeNull();
    expect(headerButtons(header)).toEqual([
      'Show source',
      'Refresh',
      'Download HTML',
      'Export PDF',
      'Full screen',
      'Collapse side panel',
    ]);
  });

  it('leaves the body itself chrome-free', () => {
    // Everything below the header is the document and nothing else.
    const body = container.querySelector('aside > div:nth-child(2)');
    expect(body?.querySelector('button')).toBeNull();
    expect(body?.querySelector('iframe')).not.toBeNull();
  });
});

describe('side pane full screen', () => {
  /** happy-dom reports 1024px, so the pane starts split-capable. */
  const clickFullscreen = async () => {
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Full screen',
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
    await flush();
  };

  it('swaps the column for a full-window overlay, keeping the body mounted', async () => {
    expect(container.querySelector('aside')).not.toBeNull();

    await clickFullscreen();

    expect(container.querySelector('aside')).toBeNull();
    const overlay = container.querySelector('div.fixed.inset-0');
    expect(overlay).not.toBeNull();
    // The document and its toolbar survive the move — this is one pane changing
    // shape, not a second surface that re-renders the preview from scratch.
    expect(overlay!.querySelector('iframe')).not.toBeNull();
    expect(headerButtons(overlay!.firstElementChild)).toContain('Export PDF');
    expect(headerButtons(overlay!.firstElementChild)).toContain('Exit full screen');
  });

  it('leaves full screen on Escape rather than closing the pane', async () => {
    await clickFullscreen();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await flush();

    // Back to the column, still open: Escape means "give me the conversation
    // back", not "throw this away".
    expect(container.querySelector('aside')).not.toBeNull();
    expect(useSidePaneStore.getState().isOpen).toBe(true);
  });
});
