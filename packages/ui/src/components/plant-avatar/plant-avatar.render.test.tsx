/**
 * @vitest-environment happy-dom
 */

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingMessageBubble } from '../chat/streaming-message-bubble';
import { PLANT_SETTLE_MS, PlantAvatar, PlantAvatarStack, type PlantAvatarProps } from './plant-avatar';
import { morphPlantAvatar } from './plant-morph';
import { buildPlantAvatarSvg, ensurePlantAvatarStyles } from './plant-avatar-svg';

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

  it('resolves stored avatars (plant > template > legacy colour) and forces the glyph LOD when compact', () => {
    avatar({ avatar: { color: 'ocean' }, stableId: 'custom:1', size: 'xs' });
    expect(svg().getAttribute('class')).toContain('pa-echeveria');
    expect(svg().getAttribute('class')).toContain('pa-lod-avatar');
    avatar({ avatar: { color: 'ocean' }, templateKey: 'chief', size: 'xs', compact: true });
    expect(svg().getAttribute('class')).toContain('pa-ivy');
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
    expect(before.querySelector('.pa-mo')!.getAttribute('class')).toContain('pa-m-speak');
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
        disconnect() {}
      },
    );
    avatar({ plant: 'clover', size: 'md', state: 'speaking' });
    expect(span().className).not.toContain('pa-paused');
    act(() => notify!([{ isIntersecting: false }]));
    expect(span().className).toContain('pa-paused');
    act(() => notify!([{ isIntersecting: true }]));
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

  it('patches transforms, motion classes and swaps the eyes behind a blink', () => {
    vi.useFakeTimers();
    const el = mount(buildPlantAvatarSvg({ plant: 'sprout', size: 48, theme: 'auto' }));
    const poseBefore = el.querySelector('.pa-pose')!.getAttribute('transform');
    expect(morphPlantAvatar(el, { plant: 'sprout', size: 48, theme: 'auto', state: 'sleep' })).toBe(el);
    expect(el.querySelector('.pa-pose')!.getAttribute('transform')).not.toBe(poseBefore);
    expect(el.querySelector('.pa-eyes')!.getAttribute('class')).toContain('pa-shut');
    vi.advanceTimersByTime(110);
    expect(el.querySelector('.pa-eyes')!.getAttribute('class')).not.toContain('pa-shut');
    expect(el.querySelector('.pa-eyes')!.innerHTML).toContain('<path'); // closed ∪ arcs
    vi.useRealTimers();
  });

  it('keeps the thinking circumnutation running through a morph; only entrance one-shots stop', () => {
    ensurePlantAvatarStyles();
    const o = { plant: 'sprout', size: 48, theme: 'auto', seed: 'bot_1' } as const;
    const el = mount(buildPlantAvatarSvg(o));
    const mo = el.querySelector('.pa-mo')!;
    const os = el.querySelector('.pa-os')!;
    morphPlantAvatar(el, { ...o, state: 'thinking' }, { swapDelay: 0 });
    expect(el.getAttribute('class')).toContain('pa-morph');
    // the X nod and the Y bob a quarter-phase apart draw the ellipse; losing the bob flattens it
    expect(getComputedStyle(mo).animation).toContain('pa-nod-x');
    expect(os.getAttribute('class')).toContain('pa-o-bob');
    expect(getComputedStyle(os).animation).toContain('pa-nod-y');
    expect(getComputedStyle(os).animation).toContain('infinite');
    // the droop is an entrance: the pose transition already plays it
    morphPlantAvatar(el, { ...o, state: 'error' }, { swapDelay: 0 });
    expect(os.getAttribute('class')).toContain('pa-o-droop');
    expect(getComputedStyle(os).animation).toBe('none');
  });

  it('replaces the element when the plant, LOD or theme changes', () => {
    const el = mount(buildPlantAvatarSvg({ plant: 'sprout', size: 48 }));
    const next = morphPlantAvatar(el, { plant: 'ivy', size: 48 });
    expect(next).not.toBe(el);
    expect(host.firstElementChild).toBe(next);
    expect(next.getAttribute('data-plant')).toBe('ivy');
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

describe('<StreamingMessageBubble/> initial wait', () => {
  it('shows the built-in sprout thinking', () => {
    render(createElement(StreamingMessageBubble, { text: '', reasoning: '', toolCalls: [], isStreaming: true }));
    const el = host.querySelector('svg.pa')!;
    expect(el.getAttribute('class')).toContain('pa-sprout');
    expect(el.getAttribute('data-state')).toBe('thinking');
  });
});
