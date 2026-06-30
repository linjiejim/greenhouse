/**
 * Scroll-activity tracker — reveals scrollbars only while scrolling.
 *
 * Scrollbars are styled transparent at rest in app.css. This adds an
 * `.is-scrolling` class to whichever element is currently scrolling and
 * removes it shortly after motion stops, so the bar fades in on scroll
 * and back out when idle (hover reveal is handled in CSS).
 *
 * Uses a single capture-phase listener (the `scroll` event does not bubble)
 * and a WeakMap of per-element idle timers, so it scales to any number of
 * scroll containers without per-component wiring.
 */

const IDLE_MS = 700;

let installed = false;

export function initScrollActivity(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  const timers = new WeakMap<Element, number>();

  document.addEventListener(
    'scroll',
    (e) => {
      // Root/document scroll reports `document` as target → map to <html>.
      const node = e.target as Node;
      const el = node instanceof Element ? node : document.documentElement;
      if (!el) return;

      el.classList.add('is-scrolling');
      const prev = timers.get(el);
      if (prev) clearTimeout(prev);
      timers.set(
        el,
        window.setTimeout(() => {
          el.classList.remove('is-scrolling');
          timers.delete(el);
        }, IDLE_MS),
      );
    },
    { capture: true, passive: true },
  );
}
