/**
 * The page's overlay stack: Escape closes only the top layer, only the bottom modal layer draws a
 * scrim, and Tab stays inside the top modal layer. Every kit Dialog, Drawer and popup joins it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

interface Layer {
  id: number;
  modal: boolean;
  escape: () => void;
  root: () => HTMLElement | null;
}
let layers: Layer[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

const TABBABLE =
  'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]';

function onKey(event: KeyboardEvent) {
  const top = layers.at(-1);
  if (!top) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    top.escape();
    return;
  }
  if (event.key !== 'Tab' || !top.modal) return;
  const root = top.root();
  const nodes = Array.from(root?.querySelectorAll<HTMLElement>(TABBABLE) ?? []);
  if (!root || !nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!root.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Join the stack while mounted. Returns whether this layer is on top and whether it draws the
 * scrim (the lowest modal layer does). Focus returns to where it was when the layer leaves.
 */
export function useLayer(options: { modal: boolean; onEscape: () => void; root: () => HTMLElement | null }) {
  const [id] = useState(() => ++nextId);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!layers.length) window.addEventListener('keydown', onKey, true);
    const layer: Layer = {
      id,
      modal: options.modal,
      escape: () => latest.current.onEscape(),
      root: () => latest.current.root(),
    };
    // Mounted together, a nested layer's effect runs first: keep the outer one below it.
    const mine = layer.root();
    const inner = mine ? layers.findIndex((other) => !!other.root() && mine.contains(other.root())) : -1;
    layers = inner === -1 ? [...layers, layer] : [...layers.slice(0, inner), layer, ...layers.slice(inner)];
    changed();
    return () => {
      layers = layers.filter((layer) => layer.id !== id);
      if (!layers.length) window.removeEventListener('keydown', onKey, true);
      changed();
      if (previous?.isConnected) previous.focus();
    };
    // a layer's modality is fixed for its lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => {
      const top = layers.at(-1)?.id === id;
      const scrim = layers.find((layer) => layer.modal)?.id === id;
      return (top ? 1 : 0) + (scrim ? 2 : 0);
    },
  );
  return { top: (snapshot & 1) === 1, scrim: (snapshot & 2) === 2 };
}

/** True while any modal layer is open (a page may pause shortcuts). */
export function hasModalLayer() {
  return layers.some((layer) => layer.modal);
}
