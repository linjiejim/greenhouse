/**
 * In-place state change for a mounted, animated plant avatar (web only — needs a DOM).
 *
 * The pose / part / look / fit transform attributes are patched and CSS transitions
 * interpolate them; colours cross-fade; motion classes are re-armed; the eye shape swaps
 * behind a blink (reduced motion: a 150ms cross-fade, see PLANT_AVATAR_CSS). Falls back to
 * replacing the element when plant, LOD or theme change. React: call it from
 * useLayoutEffect with the rendered <svg> instead of re-rendering the string.
 */

import { buildPlantAvatarSvg, type PlantAvatarSvgOptions } from './plant-avatar-svg';

export interface MorphTiming {
  /** ms before the eye shape swaps (0 = now, Infinity = never — frame captures / tests). Default 110. */
  swapDelay?: number;
}

export function morphPlantAvatar(
  svg: Element,
  o: PlantAvatarSvgOptions,
  { swapDelay = 110 }: MorphTiming = {},
): Element {
  const doc = svg.ownerDocument;
  const tpl = doc.createElement('template');
  tpl.innerHTML = buildPlantAvatarSvg({ ...o, animate: true });
  const next = tpl.content.firstElementChild!;
  const same = (a: string) => svg.getAttribute(a) === next.getAttribute(a);
  if (!svg.classList.contains('pa') || !same('data-plant') || !same('data-lod') || !same('data-theme')) {
    svg.replaceWith(next);
    return next;
  }
  if (svg.getAttribute('data-state') === next.getAttribute('data-state') && svg.innerHTML === next.innerHTML)
    return svg;
  const q = (root: ParentNode, s: string) => [...root.querySelectorAll(s)];
  // 1. root: state class, data, CSS vars (auto-theme colours live here)
  svg.setAttribute('class', next.getAttribute('class') + ' pa-morph');
  svg.setAttribute('data-state', next.getAttribute('data-state') ?? '');
  svg.setAttribute('style', next.getAttribute('style') || '');
  const label = next.getAttribute('aria-label');
  if (label) svg.setAttribute('aria-label', label);
  // 2. transforms on the persistent skeleton (same order in both trees)
  for (const sel of ['.pa-fit', '.pa-pose', '.pa-part', '.pa-look']) {
    const a = q(svg, sel);
    const b = q(next, sel);
    a.forEach((el, i) => {
      const t = b[i]?.getAttribute('transform');
      if (t != null) el.setAttribute('transform', t);
    });
  }
  // 3. colours of every painted layer (state desaturation / dimming)
  const shapesOf = (root: ParentNode) => q(root, '.pa-os path').filter((el) => !el.closest('.pa-eyes'));
  const sa = shapesOf(svg);
  const sb = shapesOf(next);
  sa.forEach((el, i) => {
    const src = sb[i];
    if (!src) return;
    for (const at of ['fill', 'stroke', 'style']) {
      const v = src.getAttribute(at);
      if (v != null && el.getAttribute(at) !== v) el.setAttribute(at, v);
    }
  });
  // 4. motion classes (re-armed), reach wrapper and effects
  const mo = svg.querySelector('.pa-mo');
  const os = svg.querySelector('.pa-os');
  mo?.setAttribute('class', next.querySelector('.pa-mo')?.getAttribute('class') ?? '');
  os?.setAttribute('class', next.querySelector('.pa-os')?.getAttribute('class') ?? '');
  q(svg, '.pa-bloom').forEach((el) => el.remove());
  const bloom = next.querySelector('.pa-bloom');
  if (bloom) svg.querySelector('.pa-fit')?.before(bloom);
  // 5. eyes: swap behind a blink
  const eyesA = svg.querySelector('.pa-eyes');
  const eyesB = next.querySelector('.pa-eyes');
  if (eyesA && eyesB && eyesA.innerHTML !== eyesB.innerHTML) {
    const swap = () => {
      eyesA.innerHTML = eyesB.innerHTML;
      eyesA.classList.remove('pa-shut');
    };
    if (swapDelay <= 0) swap();
    else {
      eyesA.classList.add('pa-shut');
      if (Number.isFinite(swapDelay)) (doc.defaultView || globalThis).setTimeout(swap, swapDelay);
    }
  }
  return svg;
}
