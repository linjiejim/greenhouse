/**
 * @vitest-environment happy-dom
 */

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANT_SETTLE_MS, PlantAvatar, PlantAvatarStack, type PlantAvatarProps } from './plant-avatar';
import { mountPlantMotion, morphPlantAvatar } from './plant-morph';
import { buildPlantAvatarSvg, plantPalette } from './plant-avatar-svg';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.head.querySelectorAll('style[data-plant-avatar]').forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

const render = (el: ReactElement) => act(() => root.render(el));
const avatar = (props: PlantAvatarProps) => render(createElement(PlantAvatar, props));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});
const span = () => host.querySelector<HTMLSpanElement>('.pa-root')!;
const svg = () => host.querySelector('svg')!;

describe('<PlantAvatar/>', () => {
  it('names itself only when a label is given; the svg inside stays decorative', () => {
    avatar({ plant: 'ivy', label: 'Ivy, thinking' });
    expect(span().getAttribute('role')).toBe('img');
    expect(span().getAttribute('aria-label')).toBe('Ivy, thinking');
    expect(svg().getAttribute('aria-hidden')).toBe('true');

    avatar({ plant: 'ivy' });
    expect(span().getAttribute('role')).toBeNull();
    expect(span().getAttribute('aria-hidden')).toBe('true');
  });

  it('maps size presets to px and uses the theme-switchable auto palette', () => {
    for (const [size, px] of [
      ['xs', 24],
      ['sm', 32],
      ['md', 48],
      ['lg', 80],
      ['xl', 120],
      [30, 30],
    ] as const) {
      avatar({ plant: 'maple', size });
      expect(span().style.width).toBe(`${px}px`);
      expect(svg().getAttribute('width')).toBe(String(px));
    }
    expect(svg().outerHTML).toContain('var(--pa-body,');
  });

  it('paints the dark disc and body under a [data-theme="dark"] ancestor, the Native Haven theme switch', () => {
    const { light, dark } = plantPalette('ivy');
    const tone = (name: string) => getComputedStyle(svg()).getPropertyValue(`--pa-${name}`).trim();
    host.setAttribute('data-theme', 'dark');
    avatar({ plant: 'ivy', size: 'sm' });
    expect(tone('disc')).toBe(dark.disc);
    expect(tone('body')).toBe(dark.body);
    act(() => root.unmount());
    root = createRoot(host);
    host.setAttribute('data-theme', 'light');
    avatar({ plant: 'ivy', size: 'sm' });
    // Unset in light: every paint falls back to its light hex.
    expect(tone('disc')).toBe('');
    expect(svg().outerHTML).toContain(`var(--pa-disc,${light.disc})`);
  });

  it('resolves stored avatars (plant > template > legacy colour) and forces the glyph LOD when compact', () => {
    avatar({ avatar: { color: 'ocean' }, stableId: 'custom:1', size: 'xs' });
    expect(svg().getAttribute('class')).toContain('pa-echeveria');
    expect(svg().getAttribute('class')).toContain('pa-lod-avatar');
    avatar({ avatar: { color: 'ocean' }, templateKey: 'researcher', size: 'xs', compact: true });
    expect(svg().getAttribute('class')).toContain('pa-dandelion');
    expect(svg().getAttribute('class')).toContain('pa-lod-glyph');
    avatar({ plant: 'lotus', avatar: { color: 'ocean' }, size: 'sm', compact: true });
    expect(svg().getAttribute('class')).toContain('pa-lotus');
    expect(svg().getAttribute('class')).toContain('pa-lod-avatar'); // compact only applies ≤ 24px
  });

  it('is static by default in lists and animated for live states and heroes', () => {
    avatar({ plant: 'sage', size: 'sm' });
    expect(svg().querySelector('.pa-mo')).toBeNull();
    avatar({ plant: 'sage', size: 'sm', state: 'thinking' });
    expect(svg().querySelector('.pa-mo')).not.toBeNull();
    avatar({ plant: 'sage', size: 'xl' });
    expect(svg().querySelector('.pa-mo')).not.toBeNull();
    avatar({ plant: 'sage', size: 'sm', state: 'thinking', animate: false });
    expect(svg().querySelector('.pa-mo')).toBeNull();
  });

  it('morphs the mounted svg in place on a state change instead of re-mounting it', () => {
    avatar({ plant: 'fern', size: 'md', state: 'thinking', stableId: 'bot_1' });
    const before = svg();
    avatar({ plant: 'fern', size: 'md', state: 'responding', stableId: 'bot_1' });
    expect(svg()).toBe(before);
    expect(before.getAttribute('data-state')).toBe('speaking');
    expect(before.getAttribute('class')).toContain('pa-morph');
    expect(before.querySelector('.pa-eyes')).not.toBeNull();
  });

  it('rebuilds a static avatar on a state change', () => {
    avatar({ plant: 'basil', size: 'sm', animate: false });
    const idle = svg().outerHTML;
    avatar({ plant: 'basil', size: 'sm', state: 'sleep', animate: false });
    expect(svg().outerHTML).not.toBe(idle);
    expect(svg().getAttribute('class')).toContain('pa-s-sleep');
  });

  it('injects the stylesheet once per document', () => {
    render(
      createElement('div', null, [
        createElement(PlantAvatar, { key: 1, plant: 'ivy' }),
        createElement(PlantAvatar, { key: 2, plant: 'sage', state: 'thinking' }),
        createElement(PlantAvatar, { key: 3, plant: 'fern', size: 'xl' }),
      ]),
    );
    expect(document.head.querySelectorAll('style[data-plant-avatar]')).toHaveLength(1);
  });

  it('pauses motion while offscreen or while the tab is hidden', () => {
    let notify: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          notify = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    avatar({ plant: 'clover', size: 'md', state: 'speaking' });
    expect(span().className).not.toContain('pa-paused');
    act(() => notify!([{ isIntersecting: false, target: svg() } as unknown as { isIntersecting: boolean }]));
    expect(span().className).toContain('pa-paused');
    act(() => notify!([{ isIntersecting: true, target: svg() } as unknown as { isIntersecting: boolean }]));
    expect(span().className).not.toContain('pa-paused');

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(span().className).toContain('pa-paused');
    visibility.mockRestore();
  });
});

describe('morphPlantAvatar', () => {
  const mount = (html: string) => {
    host.innerHTML = html;
    return host.firstElementChild!;
  };

  it('retargets the same SVG and face nodes without delayed swaps', () => {
    const options = { plant: 'sprout', size: 48, theme: 'auto', state: 'hello' } as const;
    const el = mount(buildPlantAvatarSvg(options));
    cleanups.push(mountPlantMotion(el, options));
    const eyes = el.querySelector('.pa-eyes');
    const paths = [...el.querySelectorAll('.pa-eyes path')];
    for (const state of ['sleep', 'speaking', 'error', 'done', 'thinking'] as const)
      morphPlantAvatar(el, { ...options, state });
    expect(el.getAttribute('data-state')).toBe('thinking');
    expect(el.querySelector('.pa-eyes')).toBe(eyes);
    expect([...el.querySelectorAll('.pa-eyes path')]).toEqual(paths);
    expect(el.querySelector('.pa-shut')).toBeNull();
  });

  it('shares one frame loop across mounted instances and cancels it on unmount', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let next = 0;
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      callbacks.set(++next, cb);
      return next;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      callbacks.delete(id);
    });
    avatar({ plant: 'sage', size: 120 });
    render(
      createElement('div', null, [
        createElement(PlantAvatar, { key: 1, plant: 'sage', size: 120 }),
        createElement(PlantAvatar, { key: 2, plant: 'ivy', state: 'speaking' }),
      ]),
    );
    expect(callbacks.size).toBe(1);
    act(() => root.render(null));
    expect(callbacks.size).toBe(0);
    request.mockRestore();
    cancel.mockRestore();
  });
});

describe('<PlantAvatarStack/>', () => {
  const items = ['bot_a', 'bot_b', 'bot_c', 'bot_d', 'bot_e'].map((id, i) => ({
    id,
    name: `Bot ${i}`,
    avatar: { color: ['forest', 'ocean', 'autumn', 'blossom', 'sunset'][i] },
  }));

  it('overlaps compact glyph chips by 6px at 24px, first on top, and sizes the +N chip from the avatar', () => {
    render(createElement(PlantAvatarStack, { items, max: 3 }));
    const stack = host.querySelector<HTMLElement>('[data-testid="plant-avatar-stack"]')!;
    expect(stack.style.isolation).toBe('isolate');
    const chips = [...stack.children] as HTMLElement[];
    expect(chips).toHaveLength(4);
    expect(chips[0]!.style.marginLeft).toBe('');
    expect(chips[1]!.style.marginLeft).toBe('-6px');
    expect(Number(chips[0]!.style.zIndex)).toBeGreaterThan(Number(chips[1]!.style.zIndex));
    for (const chip of chips.slice(0, 3))
      expect(chip.querySelector('svg')!.getAttribute('class')).toContain('pa-lod-glyph');
    const more = chips[3]!;
    expect(more.textContent).toBe('+2');
    expect(more.style.height).toBe('24px');
    expect(more.style.minWidth).toBe('24px');
  });

  it('moves the speaking Bot first and animates only it', () => {
    render(createElement(PlantAvatarStack, { items, max: 3, size: 'sm', speakingId: 'bot_d' }));
    const svgs = [...host.querySelectorAll('svg')];
    expect(svgs[0]!.getAttribute('class')).toContain('pa-lotus');
    expect(svgs[0]!.getAttribute('data-state')).toBe('speaking');
    expect(svgs.slice(1).every((s) => !s.querySelector('.pa-mo'))).toBe(true);
    const chips = [...host.querySelector('[data-testid="plant-avatar-stack"]')!.children] as HTMLElement[];
    expect(chips[1]!.style.marginLeft).toBe('-8px'); // overlap scales with size (32px)
  });

  it('morphs the Bot that stopped speaking back to idle in place, then settles to the static avatar', () => {
    vi.useFakeTimers();
    try {
      render(createElement(PlantAvatarStack, { items, max: 3, speakingId: 'bot_b' }));
      const speakingSvg = host.querySelector('svg.pa-echeveria')!;
      expect(speakingSvg.getAttribute('data-state')).toBe('speaking');

      const stack = host.querySelector('[data-testid="plant-avatar-stack"]')!;
      const chip = speakingSvg.closest('[data-testid="plant-avatar-stack"] > *')!;
      expect(stack.firstElementChild).toBe(chip);

      // React moving the chip back to its slot would re-insert the node and snap the morph.
      const moved: Node[] = [];
      const observer = new MutationObserver((records) => records.forEach((r) => moved.push(...r.removedNodes)));
      observer.observe(stack, { childList: true });
      render(createElement(PlantAvatarStack, { items, max: 3, speakingId: null }));
      // Same node, now idle: a morph, not a rebuild into the static string — and it keeps the lead slot.
      const settling = host.querySelector('svg.pa-echeveria')!;
      expect(settling).toBe(speakingSvg);
      expect(settling.getAttribute('data-state')).toBe('idle');
      expect(stack.firstElementChild).toBe(chip);
      act(() => vi.advanceTimersByTime(PLANT_SETTLE_MS - 50));
      expect(stack.firstElementChild).toBe(chip);
      expect(host.querySelector('svg.pa-echeveria')).toBe(speakingSvg);
      observer.takeRecords().forEach((r) => moved.push(...r.removedNodes));
      observer.disconnect();
      expect(moved).not.toContain(chip);

      act(() => vi.advanceTimersByTime(60));
      const settled = host.querySelector('svg.pa-echeveria')!;
      expect(settled).not.toBe(speakingSvg);
      expect(settled.querySelector('.pa-mo')).toBeNull();
      expect(stack.children[1]!.querySelector('svg')).toBe(settled); // back in its own slot, static
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the ring colour of the surface it sits on', () => {
    render(createElement(PlantAvatarStack, { items, max: 2, ringClassName: 'ring-primary-subtle' }));
    const chips = [...host.querySelector('[data-testid="plant-avatar-stack"]')!.children] as HTMLElement[];
    for (const chip of chips) expect(chip.className).toContain('ring-primary-subtle');
    expect(chips[0]!.className).not.toContain('ring-surface-raised');
  });
});
