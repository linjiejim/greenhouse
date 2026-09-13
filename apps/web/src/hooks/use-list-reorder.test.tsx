/**
 * @vitest-environment happy-dom
 *
 * The shared list reorder, driven by pointer events end to end.
 *
 * This is the test the HTML5 version could not have had: injected drag events
 * skip the browser's "should this start a drag" decision, so they proved
 * nothing. A synthetic PointerEvent takes exactly the path a real one does.
 */

import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveTo, isSameOrder, useListReorder } from './use-list-reorder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('moveTo', () => {
  it('moves an item later, accounting for its own removal', () => {
    expect(moveTo([1, 2, 3, 4], 1, 2)).toEqual([2, 3, 1, 4]);
  });

  it('moves an item earlier', () => {
    expect(moveTo([1, 2, 3, 4], 4, 1)).toEqual([1, 4, 2, 3]);
  });

  it('clamps out-of-range positions instead of producing holes', () => {
    expect(moveTo([1, 2, 3], 1, 99)).toEqual([2, 3, 1]);
    expect(moveTo([1, 2, 3], 3, -5)).toEqual([3, 1, 2]);
  });

  it('leaves the list alone when the id is not in it', () => {
    const ids = [1, 2, 3];
    expect(moveTo(ids, 9, 0)).toBe(ids);
  });

  it('isSameOrder compares element-wise', () => {
    expect(isSameOrder([1, 2], [1, 2])).toBe(true);
    expect(isSameOrder([1, 2], [2, 1])).toBe(false);
    expect(isSameOrder([1, 2], [1, 2, 3])).toBe(false);
  });
});

// ── Gesture ─────────────────────────────────────────────

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

function List({
  ids,
  onCommit,
  onOpen,
}: {
  ids: string[];
  onCommit: (next: string[]) => void;
  onOpen?: (id: string) => void;
}): ReactElement {
  const reorder = useListReorder(ids, onCommit);
  return createElement(
    'div',
    null,
    reorder.order.map((id) =>
      createElement(
        'button',
        {
          key: id,
          ...reorder.itemProps(id),
          'data-testid': `row-${id}`,
          // How every caller wires it: the click that ends a drag is swallowed.
          onClick: () => {
            if (reorder.didDrag()) return;
            onOpen?.(id);
          },
        },
        reorder.draggingId === id ? `${id} dragging` : id,
      ),
    ),
  );
}

async function mount(ids: string[], onCommit: (next: string[]) => void, onOpen?: (id: string) => void) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(List, { ids, onCommit, onOpen }));
  });
  return (id: string) => container!.querySelector(`[data-testid="row-${id}"]`) as HTMLElement;
}

function pointer(type: string, y: number): PointerEvent {
  // happy-dom has PointerEvent; the fields the hook reads are the mouse ones.
  return new PointerEvent(type, { bubbles: true, clientX: 0, clientY: y, button: 0, pointerId: 1 });
}

/** press → move past the sensor → release, with the row under the pointer stubbed. */
async function drag(source: HTMLElement, over: HTMLElement | null, distance = 20) {
  const from = vi.spyOn(document, 'elementFromPoint').mockReturnValue(over);
  await act(async () => {
    source.dispatchEvent(pointer('pointerdown', 0));
  });
  await act(async () => {
    window.dispatchEvent(pointer('pointermove', distance));
  });
  const draggingNow = source.textContent?.includes('dragging') ?? false;
  await act(async () => {
    window.dispatchEvent(pointer('pointerup', distance));
  });
  from.mockRestore();
  return { draggingNow };
}

describe('useListReorder (pointer gesture)', () => {
  it('reorders on drop and reports the new order exactly once', async () => {
    const onCommit = vi.fn();
    const row = await mount(['a', 'b', 'c'], onCommit);

    const { draggingNow } = await drag(row('a'), row('c'));

    expect(draggingNow).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(['b', 'c', 'a']);
  });

  it('does not start below the distance threshold', async () => {
    const onCommit = vi.fn();
    const row = await mount(['a', 'b'], onCommit);

    const { draggingNow } = await drag(row('a'), row('b'), 3);

    expect(draggingNow).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when the item is dropped where it started', async () => {
    const onCommit = vi.fn();
    const row = await mount(['a', 'b'], onCommit);

    await drag(row('a'), row('a'));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('ignores a drag that ends on nothing', async () => {
    const onCommit = vi.fn();
    const row = await mount(['a', 'b'], onCommit);

    await drag(row('a'), null);

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('swallows the click that ends a drag', async () => {
    const onOpen = vi.fn();
    const row = await mount(['a', 'b'], vi.fn(), onOpen);
    const source = row('a');
    const from = vi.spyOn(document, 'elementFromPoint').mockReturnValue(row('b'));

    // One synchronous block on purpose: the browser dispatches the click in the
    // same task as pointerup, ahead of any timer. Awaiting in between would let
    // the flag's expiry win and test something that never happens.
    await act(async () => {
      source.dispatchEvent(pointer('pointerdown', 0));
      window.dispatchEvent(pointer('pointermove', 20));
      window.dispatchEvent(pointer('pointerup', 20));
      source.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    from.mockRestore();

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('stops swallowing once the drop is over, even if no click followed it', async () => {
    // Dropping on ANOTHER row sends the synthetic click to a common ancestor,
    // not to the row — so nothing consumes the flag, and without the expiry it
    // would sit there and eat the user's next real click.
    const onOpen = vi.fn();
    const row = await mount(['a', 'b'], vi.fn(), onOpen);

    await drag(row('a'), row('b'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      row('a').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('never starts from a control marked data-no-drag', async () => {
    const onCommit = vi.fn();
    const row = await mount(['a', 'b'], onCommit);
    const optOut = document.createElement('span');
    optOut.setAttribute('data-no-drag', '');
    row('a').append(optOut);

    const { draggingNow } = await drag(optOut, row('b'));

    expect(draggingNow).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
