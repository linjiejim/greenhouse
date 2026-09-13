/** @vitest-environment happy-dom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOVER_FLYOUT_CLOSE_DELAY_MS, useHoverFlyout } from './use-hover-flyout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function Harness() {
  const flyout = useHoverFlyout();
  return (
    <div data-testid="hover-root" onMouseEnter={flyout.openNow} onMouseLeave={flyout.closeSoon}>
      <button type="button">Trigger</button>
      {flyout.open && <div role="menu">Panel</div>}
    </div>
  );
}

async function mountHarness() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Harness />));
  return container.querySelector<HTMLElement>('[data-testid="hover-root"]')!;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  vi.useRealTimers();
  container?.remove();
  root = null;
  container = null;
});

describe('useHoverFlyout', () => {
  it('keeps an interactive panel mounted for the shared pointer-crossing grace period', async () => {
    vi.useFakeTimers();
    const hoverRoot = await mountHarness();

    await act(async () => hoverRoot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(container?.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => {
      hoverRoot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(HOVER_FLYOUT_CLOSE_DELAY_MS - 1);
    });
    expect(container?.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(1));
    expect(container?.querySelector('[role="menu"]')).toBeNull();
  });

  it('cancels a pending close when the pointer reaches the flyout again', async () => {
    vi.useFakeTimers();
    const hoverRoot = await mountHarness();

    await act(async () => hoverRoot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => {
      hoverRoot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(80);
      hoverRoot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(HOVER_FLYOUT_CLOSE_DELAY_MS);
    });

    expect(container?.querySelector('[role="menu"]')).not.toBeNull();
  });
});
