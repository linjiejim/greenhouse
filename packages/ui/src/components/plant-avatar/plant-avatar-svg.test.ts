/**
 * Builder guarantees (spec §10.2): every preset × state × size tier × theme × animate
 * builds well-formed XML, is deterministic, has no ids / defs / url(#), and the static
 * explicit-theme output needs no CSS (no class, no style; poses are transform attributes).
 *
 * Byte budget — measured over every preset × state (worst case named), October 2026:
 *   theme 'auto' (what the web ships): static 24px 4.58 KB (lotus sleep), animated 24px
 *   5.42 KB (lotus sleep), animated 120px 10.51 KB (sunflower waiting);
 *   explicit theme (mobile SvgXml, PNG exports): static 24px 4.04 KB (lotus done), static
 *   120px 9.60 KB (sunflower waiting).
 * 'auto' costs ≈ 0.6 KB over an explicit theme: every paint is `style="fill:var(--pa-<tone>,
 * <light hex>)"`. The root carries only the dark tones that differ from light (the per-paint
 * fallback already is the light palette).
 */

import { describe, expect, it } from 'vitest';
import { PLANT_IDS, PLANT_STATES, type PlantState, type PlantStateInput } from '@greenhouse/types';
import { PLANT_PRESETS, PLANT_TONES } from './plant-catalogue';
import { PLANT_FIT } from './plant-fit.generated';
import {
  EYE,
  FIT_TARGET,
  PLANT_AVATAR_CSS,
  PLANT_PHASE_SPAN,
  buildPlantAvatarSvg,
  buildPlantMonoLayers,
  eyeHalfGap,
  lodFor,
  plantPalette,
  poseFor,
  rimUnits,
  type PlantAvatarSvgOptions,
} from './plant-avatar-svg';

const SIZES = [16, 24, 48, 120] as const;
const THEMES = ['light', 'dark', 'auto'] as const;

/** Strict little XML well-formedness parser: one root, balanced tags, quoted unique attributes, escaped `&`. */
function parseXml(src: string): { root: string; elements: number } {
  const TAG_OPEN = /<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>/y;
  const TAG_CLOSE = /<\/([A-Za-z_][\w:.-]*)\s*>/y;
  const BARE_AMP = /&(?!amp;|lt;|gt;|quot;|apos;)/;
  const stack: string[] = [];
  let root: string | null = null;
  let elements = 0;
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') {
      const j = src.indexOf('<', i);
      const text = src.slice(i, j < 0 ? src.length : j);
      if (!stack.length && text.trim()) throw new Error(`text outside the root at ${i}`);
      if (BARE_AMP.test(text)) throw new Error(`unescaped & in text at ${i}`);
      i = j < 0 ? src.length : j;
      continue;
    }
    TAG_CLOSE.lastIndex = i;
    const close = TAG_CLOSE.exec(src);
    if (close) {
      const top = stack.pop();
      if (top !== close[1]) throw new Error(`</${close[1]}> closes <${top}> at ${i}`);
      i = TAG_CLOSE.lastIndex;
      continue;
    }
    TAG_OPEN.lastIndex = i;
    const open = TAG_OPEN.exec(src);
    if (!open) throw new Error(`malformed tag at ${i}: ${src.slice(i, i + 80)}`);
    const seen = new Set<string>();
    for (const [, name, value] of open[2]!.matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)) {
      if (seen.has(name!)) throw new Error(`duplicate attribute ${name} on <${open[1]}>`);
      seen.add(name!);
      if (BARE_AMP.test(value!)) throw new Error(`unescaped & in ${name}`);
    }
    if (!stack.length) {
      if (root) throw new Error('more than one root element');
      root = open[1]!;
    }
    elements++;
    if (!open[3]) stack.push(open[1]!);
    i = TAG_OPEN.lastIndex;
  }
  if (stack.length) throw new Error(`unclosed <${stack.join('> <')}>`);
  if (!root) throw new Error('no root element');
  return { root, elements };
}

function* matrix(): Generator<PlantAvatarSvgOptions> {
  for (const plant of PLANT_IDS)
    for (const state of PLANT_STATES)
      for (const size of SIZES)
        for (const theme of THEMES)
          for (const animate of [false, true]) yield { plant, state, size, theme, animate, seed: 'bot_1' };
}

describe('buildPlantAvatarSvg — structural guarantees', () => {
  it('builds well-formed, deterministic, id-free markup for every preset × state × size × theme × animate', () => {
    let n = 0;
    for (const o of matrix()) {
      const svg = buildPlantAvatarSvg(o);
      const where = JSON.stringify(o);
      expect(parseXml(svg).root, where).toBe('svg');
      expect(buildPlantAvatarSvg({ ...o }), where).toBe(svg);
      expect(svg, where).not.toMatch(/\sid=|<defs|url\(#/);
      n++;
    }
    expect(n).toBe(PLANT_IDS.length * PLANT_STATES.length * SIZES.length * THEMES.length * 2);
  });

  it('static output with an explicit theme needs no CSS: no style, no classes below the root', () => {
    // The root keeps its identity classes (pa pa-<plant> pa-s-<state>) as inert hooks; nothing
    // the rendering depends on is a class or a style.
    for (const o of matrix()) {
      if (o.animate || o.theme === 'auto') continue;
      const svg = buildPlantAvatarSvg(o);
      const [rootTag] = svg.match(/^<svg[^>]*>/)!;
      expect(rootTag, JSON.stringify(o)).not.toContain('style=');
      expect(svg.slice(rootTag.length), JSON.stringify(o)).not.toMatch(/\s(class|style)=/);
      expect(svg).not.toContain('var(--');
    }
  });

  it("keeps the keyline in theme 'auto': the rim underlay paints fill and stroke from one style attribute", () => {
    const svg = buildPlantAvatarSvg({ plant: 'ivy', size: 24, theme: 'auto', animate: false });
    expect(svg).toContain('style="fill:var(--pa-rim,#1D4429);stroke:var(--pa-rim,#1D4429)" stroke-width=');
    expect(svg).not.toMatch(/style="[^"]*" style=/);
  });

  it('bakes each static pose into transform attributes about the species pivot', () => {
    for (const plant of PLANT_IDS) {
      const [px, py] = PLANT_PRESETS[plant].pivot;
      for (const state of PLANT_STATES) {
        const pose = poseFor(state);
        const svg = buildPlantAvatarSvg({ plant, state, size: 48, theme: 'light', animate: false });
        if (pose.rot)
          expect(svg, `${plant}/${state}`).toContain(
            ` transform="${pose.tx || pose.ty ? `translate(${pose.tx} ${pose.ty}) ` : ''}rotate(${pose.rot} ${px} ${py})`,
          );
        else if (state === 'idle') expect(svg, plant).not.toContain('rotate(');
      }
    }
  });

  it('animated output always carries the morphable skeleton', () => {
    for (const state of PLANT_STATES) {
      const svg = buildPlantAvatarSvg({ plant: 'lotus', state, size: 48 });
      for (const cls of ['pa-fit', 'pa-pose', 'pa-part', 'pa-mo', 'pa-os', 'pa-look', 'pa-eyes'])
        expect(svg).toContain(`class="${cls}`);
      expect(svg).toContain(`data-state="${state}"`);
    }
  });

  it("theme 'auto' paints through CSS vars with the light hex as fallback and carries only the dark tones that differ", () => {
    const svg = buildPlantAvatarSvg({ plant: 'ivy', theme: 'auto', animate: false });
    expect(svg).toContain('style="fill:var(--pa-body,#468C5A)"');
    const { light, dark } = plantPalette('ivy');
    const differing = PLANT_TONES.filter((t) => dark[t] !== light[t]);
    expect(differing).toContain('body');
    expect(differing).not.toContain('ink'); // same in both themes: the fallback covers it
    const [rootTag] = svg.match(/^<svg[^>]*>/)!;
    expect(rootTag).toContain(` style="${differing.map((t) => `--pa-d-${t}:${dark[t]}`).join(';')}"`);
    expect(svg).not.toContain('--pa-l-');
    expect(svg).not.toMatch(/\sfill="#/);
    // the stylesheet leaves the light palette to each paint's fallback and switches only dark
    expect(PLANT_AVATAR_CSS).toContain('\n.pa{display:block;overflow:visible}\n');
    expect(PLANT_AVATAR_CSS).toContain(
      '.dark-theme .pa,.pa-dark .pa{--pa-disc:var(--pa-d-disc);--pa-body:var(--pa-d-body);',
    );
    // static output carries no motion vars
    expect(rootTag).not.toContain('--pa-phase');
    expect(buildPlantAvatarSvg({ plant: 'ivy', theme: 'auto' })).toMatch(
      /^<svg[^>]* style="--pa-ox:[^"]*--pa-d-body:#5AA06C/,
    );
  });

  it('labels are escaped into role="img"; no label → aria-hidden; never a <title>', () => {
    const labelled = buildPlantAvatarSvg({ plant: 'ivy', label: '小青 · <思考中> & "x"' });
    expect(labelled).toContain('role="img" aria-label="小青 · &lt;思考中&gt; &amp; &quot;x&quot;"');
    expect(labelled).not.toContain('<title');
    expect(buildPlantAvatarSvg({ plant: 'ivy' })).toContain('aria-hidden="true"');
  });

  it('only the done portrait gets the bloom effect, and only when animated', () => {
    expect(buildPlantAvatarSvg({ plant: 'maple', state: 'done', size: 120 })).toContain('pa-bloom');
    expect(buildPlantAvatarSvg({ plant: 'maple', state: 'done', size: 32 })).not.toContain('pa-bloom');
    expect(buildPlantAvatarSvg({ plant: 'maple', state: 'done', size: 120, animate: false })).not.toContain('pa-bloom');
  });

  it('collapses ≤ 20px expressions to calm / happy / closed', () => {
    const glyph = buildPlantAvatarSvg({ plant: 'basil', state: 'error', size: 16, theme: 'light', animate: false });
    const calm = buildPlantAvatarSvg({ plant: 'basil', state: 'idle', size: 16, theme: 'light', animate: false });
    const eyes = (s: string) => s.match(/<ellipse[^>]*>/g);
    expect(eyes(glyph)).toHaveLength(2); // sad lids are paths above 20px
    expect(eyes(calm)).toHaveLength(2);
    expect(
      buildPlantAvatarSvg({ plant: 'basil', state: 'error', size: 24, theme: 'light', animate: false }),
    ).not.toContain('<ellipse');
  });

  it("stays within the byte budget, theme 'auto' as shipped (see the header for the measured worst cases)", () => {
    const KB = 1024;
    const budgets: [PlantAvatarSvgOptions, number][] = [
      [{ size: 24, theme: 'auto', animate: false }, 4.75 * KB],
      [{ size: 24, theme: 'auto' }, 5.5 * KB],
      [{ size: 120, theme: 'auto' }, 10.75 * KB],
      [{ size: 24, theme: 'light', animate: false }, 4.25 * KB],
      [{ size: 120, theme: 'light', animate: false }, 9.75 * KB],
    ];
    for (const [o, budget] of budgets)
      for (const plant of PLANT_IDS)
        for (const state of PLANT_STATES) {
          const where = JSON.stringify({ plant, state, ...o });
          expect(buildPlantAvatarSvg({ plant, state, seed: 'bot_1', ...o }).length, where).toBeLessThanOrEqual(budget);
        }
  });

  it('mono layers share geometry in currentColor, without disc or keyline', () => {
    const { silhouette, eyes } = buildPlantMonoLayers({ plant: 'clover', size: 44 });
    for (const s of [silhouette, eyes]) {
      expect(parseXml(s).root).toBe('svg');
      expect(s).not.toMatch(/#[0-9A-F]{6}/i);
      expect(s).not.toContain('r="50"');
    }
    expect(silhouette).not.toContain('<ellipse');
    expect(eyes).toContain('<ellipse');
    expect(eyes).not.toContain('<path d="M');
  });

  it('is total over unknown and prototype-named options', () => {
    const fallback = buildPlantAvatarSvg({ size: 24 });
    expect(buildPlantAvatarSvg({ plant: 'nope', size: 24 })).toBe(fallback);
    expect(buildPlantAvatarSvg({ plant: '__proto__', size: 24 })).toBe(fallback);
    expect(buildPlantAvatarSvg({ plant: 'constructor', size: 24 })).toBe(fallback);
    expect(buildPlantAvatarSvg({ lod: 'constructor' as never, size: 24 })).toBe(fallback);
    expect(buildPlantAvatarSvg({ state: 'toString' as PlantStateInput, size: 24 })).toBe(fallback);
    expect(poseFor('constructor').state).toBe('idle');
  });
});

describe('pose, LOD and metrics helpers', () => {
  it('maps product aliases onto plant states', () => {
    expect(poseFor('responding').state).toBe('speaking');
    expect(poseFor('working').state).toBe('speaking');
    expect(poseFor('needs_you').state).toBe('waiting');
    expect(poseFor('paused').state).toBe('sleep');
    expect(poseFor('unread').state).toBe('idle');
    expect(poseFor(undefined).state).toBe('idle');
  });

  it('switches LOD at 20 / 44px and keeps a 1px keyline (0.75px at glyph sizes)', () => {
    expect([lodFor(16), lodFor(20), lodFor(21), lodFor(44), lodFor(45), lodFor(160)]).toEqual([
      'glyph',
      'glyph',
      'avatar',
      'avatar',
      'portrait',
      'portrait',
    ]);
    expect(rimUnits(16) * (16 / 100)).toBeCloseTo(0.75);
    expect(rimUnits(48) * (48 / 100)).toBeCloseTo(1);
  });

  it('keeps ≥ 1.5px between the eyes at 16px for every species (must-fix #2)', () => {
    for (const plant of PLANT_IDS) {
      const m = EYE.glyph;
      const scale = Math.min(1.3, (FIT_TARGET.glyph - rimUnits(16)) / PLANT_FIT[plant].glyph[0]);
      const innerGap = 2 * (eyeHalfGap(plant, 'glyph') - m.rx * (PLANT_PRESETS[plant].face.scale || 1));
      expect(innerGap * scale * 0.16, plant).toBeGreaterThanOrEqual(1.5);
    }
  });
});

describe('PLANT_AVATAR_CSS', () => {
  it('kills every animation and transition under prefers-reduced-motion and cross-fades the eyes', () => {
    const rm = PLANT_AVATAR_CSS.slice(PLANT_AVATAR_CSS.indexOf('@media (prefers-reduced-motion:reduce)'));
    expect(rm).toContain('.pa *{animation:none!important;transition-duration:0s!important}');
    expect(rm).toContain('.pa .pa-eyes{transition:opacity .15s!important}');
  });

  it('caps ambient loops inside the stylesheet and offers a pause hook', () => {
    expect(PLANT_AVATAR_CSS).toContain(
      'pa-breathe 5s cubic-bezier(.37,0,.63,1) calc(var(--pa-phase) / 11) var(--pa-cycles)',
    );
    expect(PLANT_AVATAR_CSS).toContain('.pa-m-lean{animation:pa-lean 2.6s ease-in-out 3}');
    expect(PLANT_AVATAR_CSS).toContain('.pa-paused .pa *');
    expect(PLANT_AVATAR_CSS).toContain('.dark-theme .pa');
  });

  it('gives the seeded phase only to infinite loops; a capped loop starts at most a quarter cycle in', () => {
    const worst = -PLANT_PHASE_SPAN;
    const all = ANIMATIONS.filter((a) => a.anim !== 'none');
    expect(all.length).toBeGreaterThan(15);
    for (const a of all) {
      if (a.count === 'infinite') continue;
      expect(a.delay, a.selector).not.toBe('var(--pa-phase)');
      expect(seconds(a.delay, worst), a.selector).toBeGreaterThanOrEqual(-a.duration / 4);
    }
    // the live loops are the ones the phase desynchronises (two Bots never nod in unison)
    for (const selector of ['.pa .pa-m-think', '.pa .pa-o-bob', '.pa .pa-glance', '.pa .pa-m-speak']) {
      const a = all.find((x) => x.selector === selector)!;
      expect(a.count, selector).toBe('infinite');
      expect(a.delay, selector).toContain('var(--pa-phase)');
    }
    expect(effective('.pa-blink', 'thinking')).toMatchObject({ count: 'infinite', delay: 'var(--pa-phase)' });
  });

  it('lets a hero idle ≈ 15s and blink its whole blink cycle, whatever the seed', () => {
    // first shut frame of pa-blink (26.5% of 11s ≈ 2.9s)
    const keyframes = /@keyframes pa-blink\{(.*?)\}\}/.exec(PLANT_AVATAR_CSS)![1]!;
    const shut = /([\d.%,]+)\{transform:scaleY\(\.08\)/.exec(keyframes)![1]!.split(',').map(parseFloat);
    const breathe = ANIMATIONS.find((a) => a.selector === '.pa .pa-m-idle')!;
    const sway = ANIMATIONS.find((a) => a.selector === '.pa .pa-o-sway')!;
    const blink = effective('.pa-blink', 'idle');
    expect(blink.count).toBe('var(--pa-blinks)');
    const phases: number[] = [];
    for (const seed of ['sprouty', ...Array.from({ length: 300 }, (_, i) => `bot_${i}`)]) {
      const vars = rootVars(buildPlantAvatarSvg({ plant: 'sprout', size: 120, seed }));
      const phase = parseFloat(vars['--pa-phase']!);
      phases.push(phase);
      const cycles = Number(vars['--pa-cycles']);
      expect(cycles).toBe(3);
      expect(Number(vars['--pa-blinks'])).toBe(1);
      expect(breathe.duration * cycles + seconds(breathe.delay, phase), seed).toBeGreaterThanOrEqual(14);
      expect(sway.duration * cycles + seconds(sway.delay, phase), seed).toBeGreaterThanOrEqual(12);
      expect((Math.min(...shut) / 100) * blink.duration + seconds(blink.delay, phase), seed).toBeGreaterThan(0);
    }
    expect(phases[0]).toBe(-9.42); // the new-chat hero: once lost 9.4s of its idle and its blink
    expect(Math.min(...phases)).toBeLessThan(-10); // the sample spans the whole phase range
  });

  it('blinks forever only while thinking or speaking; every other state blinks one capped cycle or never', () => {
    for (const state of PLANT_STATES) {
      const blink = effective('.pa-blink', state);
      if (state === 'thinking' || state === 'speaking') expect(blink, state).toMatchObject({ count: 'infinite' });
      else if (blink.anim !== 'none') expect(blink, state).toMatchObject({ count: 'var(--pa-blinks)' });
    }
    expect(effective('.pa-blink', 'waiting')).toMatchObject({ anim: 'pa-blink', count: 'var(--pa-blinks)' });
    expect(buildPlantAvatarSvg({ plant: 'ivy', state: 'waiting' })).toContain('class="pa-blink"'); // its eyes do blink
  });
});

// ─── a little CSS reader for the loop assertions ────────────────────────────

interface Animation {
  anim: string;
  duration: number;
  delay: string;
  count: string;
}

/** Top-level rules of PLANT_AVATAR_CSS (keyframes and the reduced-motion block left out). */
function topLevelRules(css: string): { selectors: string[]; decls: [string, string][] }[] {
  let flat = '';
  let depth = 0;
  let skip = false;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === '@' && depth === 0) skip = true;
    if (c === '{') depth++;
    if (!skip) flat += c;
    if (c === '}' && --depth === 0) skip = false;
  }
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
    selectors: sel!.split(',').map((x) => x.trim()),
    decls: body!
      .split(';')
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')), d.slice(d.indexOf(':') + 1)] as [string, string]),
  }));
}

const time = (t: string) => (t.endsWith('ms') ? parseFloat(t) / 1000 : parseFloat(t));
const isTime = (t: string) => /^-?[\d.]+m?s$/.test(t) || t.startsWith('calc(') || t === 'var(--pa-phase)';

function shorthand(value: string): Animation {
  if (value === 'none') return { anim: 'none', duration: 0, delay: '0s', count: '0' };
  const tokens = value.match(/[\w-]+\((?:[^()]|\([^()]*\))*\)|\S+/g)!;
  const times = tokens.filter(isTime);
  return {
    anim: tokens.find((t) => t.startsWith('pa-'))!,
    duration: time(times[0]!),
    delay: times[1] ?? '0s',
    count: tokens.find((t) => /^\d+$|^infinite$|^var\(--pa-(cycles|blinks)\)$/.test(t)) ?? '1',
  };
}

/** A delay expression (`1.2s`, `var(--pa-phase)`, `calc(var(--pa-phase) / 11)`, `calc(… - .75s)`) in seconds. */
function seconds(expr: string, phase: number): number {
  const e = expr.replaceAll('var(--pa-phase)', `${phase}s`);
  const calc = /^calc\((\S+) ([-+*/]) (\S+)\)$/.exec(e);
  if (!calc) return time(e);
  const [a, op, b] = [time(calc[1]!), calc[2], calc[3]!];
  if (op === '/') return a / Number(b);
  if (op === '*') return a * Number(b);
  return op === '-' ? a - time(b) : a + time(b);
}

const RULES = topLevelRules(PLANT_AVATAR_CSS);
const ANIMATIONS = RULES.flatMap((r) =>
  r.decls
    .filter(([k]) => k === 'animation')
    .flatMap(([, v]) => r.selectors.map((selector) => ({ selector, ...shorthand(v) }))),
);

/**
 * The animation `.pa .X` ends up with on a root in `state`: the base rule, then the state's
 * own rules (`.pa.pa-s-<state> .X`, more specific) — shorthand or longhands.
 */
function effective(target: string, state: PlantState): Animation {
  let out = shorthand('none');
  for (const selector of [`.pa ${target}`, `.pa.pa-s-${state} ${target}`])
    for (const rule of RULES.filter((r) => r.selectors.includes(selector)))
      for (const [k, v] of rule.decls) {
        if (k === 'animation') out = shorthand(v);
        else if (k === 'animation-delay') out = { ...out, delay: v };
        else if (k === 'animation-iteration-count') out = { ...out, count: v };
      }
  return out;
}

/** Custom properties on the root <svg>. */
const rootVars = (svg: string): Record<string, string> =>
  Object.fromEntries(
    /^<svg[^>]* style="([^"]*)"/
      .exec(svg)![1]!
      .split(';')
      .map((d) => d.split(':') as [string, string]),
  );
