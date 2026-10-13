/**
 * Render and event helpers for the kit's happy-dom tests. Each test file sets
 * `@vitest-environment happy-dom` and calls `setupKit()` once.
 */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

export function setupKit() {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.documentElement.removeAttribute('style');
    vi.useRealTimers();
  });
}

export const render = (element: ReactElement) => act(() => root.render(element));
export const screen = () => host;

/** The one element matching `selector` inside the document. */
export function get<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`No element matches ${selector}`);
  return found;
}

/** The element with this role and accessible name (aria-label or text). */
export function byRole<T extends HTMLElement = HTMLElement>(role: string, name?: string): T {
  const selector = [`[role="${role}"]`, implicit[role]].filter(Boolean).join(', ');
  const all = Array.from(document.querySelectorAll<T>(selector));
  const match = all.find(
    (element) =>
      name === undefined || element.getAttribute('aria-label') === name || element.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No ${role} named ${name ?? '(any)'}`);
  return match;
}
const implicit: Record<string, string> = { button: 'button:not([role])', checkbox: 'input[type="checkbox"]' };

export function key(target: Element, name: string, init: KeyboardEventInit = {}) {
  let event!: KeyboardEvent;
  act(() => {
    event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
  });
  return event;
}

export function click(target: HTMLElement) {
  act(() => target.click());
}

export function focus(target: HTMLElement) {
  act(() => target.focus());
}

export function pointer(target: Element, type: 'pointerover' | 'pointerout' | 'pointerdown', pointerType = 'mouse') {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType }));
  });
}

export function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

export const active = () => document.activeElement as HTMLElement | null;
