/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResizeHandle } from './ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

function pointer(type: string, x: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, clientX: x, clientY: 0, button: 0, pointerId: 1 });
}

async function mount(props: React.ComponentProps<typeof ResizeHandle>) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(ResizeHandle, props)));
  const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
  Object.defineProperties(separator, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  return separator;
}

async function drag(separator: HTMLDivElement, from: number, to: number) {
  await act(async () => separator.dispatchEvent(pointer('pointerdown', from)));
  await act(async () => separator.dispatchEvent(pointer('pointermove', to)));
  await act(async () => separator.dispatchEvent(pointer('pointerup', to)));
}

describe('ResizeHandle collapse gestures', () => {
  it('collapses only after the pointer moves past the minimum threshold', async () => {
    const onChange = vi.fn();
    const onCollapse = vi.fn();
    const separator = await mount({
      orientation: 'vertical',
      value: 240,
      min: 240,
      max: 420,
      onChange,
      onCollapse,
      collapseThreshold: 24,
      label: 'Resize sidebar',
    });

    await drag(separator, 300, 290);

    expect(onCollapse).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(240);

    onChange.mockClear();
    await drag(separator, 300, 275);

    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports an outward drag value before the pointer is released', async () => {
    const onResizeEnd = vi.fn();
    const separator = await mount({
      orientation: 'vertical',
      value: 60,
      min: 60,
      max: 240,
      onChange: vi.fn(),
      onResizeEnd,
      label: 'Resize sidebar',
    });

    await drag(separator, 60, 90);

    expect(onResizeEnd).toHaveBeenCalledWith(90);
  });

  it('keeps reporting live values in both directions until the pointer is released', async () => {
    const onResizeStart = vi.fn();
    const onChange = vi.fn();
    const onResizeEnd = vi.fn();
    const separator = await mount({
      orientation: 'vertical',
      value: 60,
      min: 60,
      max: 420,
      onResizeStart,
      onChange,
      onResizeEnd,
      label: 'Resize sidebar',
    });

    await act(async () => separator.dispatchEvent(pointer('pointerdown', 60)));
    await act(async () => separator.dispatchEvent(pointer('pointermove', 260)));
    await act(async () => separator.dispatchEvent(pointer('pointermove', 180)));

    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenNthCalledWith(1, 260);
    expect(onChange).toHaveBeenNthCalledWith(2, 180);
    expect(onResizeEnd).not.toHaveBeenCalled();

    await act(async () => separator.dispatchEvent(pointer('pointerup', 180)));
    expect(onResizeEnd).toHaveBeenCalledWith(180);
  });
});
