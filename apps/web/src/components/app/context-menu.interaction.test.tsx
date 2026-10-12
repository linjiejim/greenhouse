/** @vitest-environment happy-dom */

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu } from './context-menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Example({ onPick }: { onPick: () => void }) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button onClick={(event) => setTrigger(trigger ? null : event.currentTarget)}>More</button>
      {trigger && (
        <ContextMenu
          position={{ x: 10, y: 20 }}
          returnFocusTo={trigger}
          onClose={() => setTrigger(null)}
          items={[
            { label: 'First', onClick: onPick, testId: 'first-action' },
            { label: 'Second', onClick: onPick },
            { label: 'Third', onClick: onPick },
          ]}
        />
      )}
    </>
  );
}

async function key(value: string) {
  await act(async () =>
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })),
  );
}

describe('ContextMenu keyboard access', () => {
  it('focuses the first action, supports arrow/Home/End navigation, and restores focus on Escape', async () => {
    const onPick = vi.fn();
    await act(async () => root.render(<Example onPick={onPick} />));
    const trigger = container.querySelector('button')!;
    await act(async () => trigger.click());
    expect(document.activeElement?.getAttribute('data-testid')).toBe('first-action');
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Second');
    await key('End');
    expect(document.activeElement?.textContent).toBe('Third');
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('First');
    await key('ArrowUp');
    expect(document.activeElement?.textContent).toBe('Third');
    await key('Home');
    expect(document.activeElement?.textContent).toBe('First');
    await key('Escape');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('activates an action once and lets a second trigger click close the menu', async () => {
    const onPick = vi.fn();
    await act(async () => root.render(<Example onPick={onPick} />));
    const trigger = container.querySelector('button')!;
    await act(async () => trigger.click());
    await act(async () => (container.querySelector('[data-testid="first-action"]') as HTMLButtonElement).click());
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      trigger.click();
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('does not take focus back from content opened by a menu action', async () => {
    const destination = document.createElement('input');
    document.body.appendChild(destination);
    try {
      await act(async () => root.render(<Example onPick={() => destination.focus()} />));
      await act(async () => container.querySelector('button')!.click());
      await act(async () => (container.querySelector('[data-testid="first-action"]') as HTMLButtonElement).click());
      expect(document.activeElement).toBe(destination);
    } finally {
      destination.remove();
    }
  });
});
