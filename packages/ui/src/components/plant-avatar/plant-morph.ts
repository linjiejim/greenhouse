/** Mounted V2 avatars share one active-time rAF clock. No layout reads occur while drawing. */
import { MotionController, spring } from './plant-motion';
import { PLANT_LOD_CODES, PLANT_PRESETS, type PlantLayer } from './plant-catalogue';
import { buildPlantAvatarSvg, lodFor, poseFor, type PlantAvatarSvgOptions } from './plant-avatar-svg';
import {
  MOTION_ORGANS,
  bodyTransform,
  facePaths,
  layerGoal,
  organTransform,
  type MotionLayer,
} from './plant-motion-shapes';

const instances = new WeakMap<Element, PlantMotion>();
const runtimes = new WeakMap<Document, ReturnType<typeof makeRuntime>>();
function makeRuntime(doc: Document) {
  const win = doc.defaultView!;
  const active = new Set<PlantMotion>();
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let frame: number | undefined, last: number | undefined;
  const tick = (now: number) => {
    frame = undefined;
    const dt = last === undefined ? 0 : Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const item of active) if (!item.paused) item.draw(dt);
    wake();
  };
  const wake = () => {
    if (doc.visibilityState === 'hidden' || media?.matches || ![...active].some((item) => !item.paused)) {
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      frame = undefined;
      last = undefined;
      return;
    }
    if (frame === undefined) frame = win.requestAnimationFrame(tick);
  };
  const visibility = () => {
    last = undefined;
    for (const item of active)
      item.svg.parentElement?.classList.toggle('pa-paused', doc.visibilityState === 'hidden' || item.paused);
    wake();
  };
  const reduced = () => {
    for (const item of active) item.draw(0);
    visibility();
  };
  const observe =
    typeof win.IntersectionObserver === 'undefined'
      ? { observe(_el: Element) {}, unobserve(_el: Element) {}, disconnect() {} }
      : new win.IntersectionObserver((entries) => {
          for (const entry of entries) {
            const item = instances.get(entry.target);
            if (item) item.paused = !entry.isIntersecting;
          }
          visibility();
        });
  doc.addEventListener('visibilitychange', visibility);
  media?.addEventListener('change', reduced);
  return {
    active,
    media,
    wake,
    observe,
    dispose() {
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      observe.disconnect();
      doc.removeEventListener('visibilitychange', visibility);
      media?.removeEventListener('change', reduced);
      runtimes.delete(doc);
    },
  };
}
function runtime(doc: Document) {
  let value = runtimes.get(doc);
  if (!value) {
    value = makeRuntime(doc);
    runtimes.set(doc, value);
  }
  return value;
}
class PlantMotion {
  model: MotionController;
  paused = false;
  private root: ReturnType<typeof runtime>;
  private pose: Element;
  private face: Element;
  private eyes: Element[];
  private brows: Element[];
  private mouth: Element | null;
  private layers: { node: Element; layer: MotionLayer; spring: [number, number] }[] = [];
  private preset;
  private lod;
  private size;
  constructor(
    readonly svg: Element,
    private options: PlantAvatarSvgOptions,
  ) {
    const plant = options.plant as keyof typeof PLANT_PRESETS;
    this.size = options.size ?? 32;
    this.lod = options.lod ?? lodFor(this.size);
    this.preset = PLANT_PRESETS[plant];
    this.root = runtime(svg.ownerDocument);
    this.model = new MotionController(plant, { state: poseFor(options.state).state, seed: options.seed });
    // A greeting/entrance starts at contact, rather than at the end of its finite gesture.
    if (options.intro || this.model.state === 'hello') {
      this.model.age = 0;
    }
    this.pose = svg.querySelector('.pa-pose')!;
    this.face = svg.querySelector('.pa-look')!;
    const os = svg.querySelector('.pa-os')!;
    const paths = [...os.querySelectorAll('path')].filter((el) => !el.closest('.pa-look'));
    const visible = this.preset.layers
      .map((layer, index) => ({ layer, index }))
      .filter(({ layer }) => layer.lods.includes(PLANT_LOD_CODES[this.lod]));
    // Remove V1 part wrappers while retaining every painted path and its order.
    for (const [i, { layer, index }] of visible.entries()) {
      const node = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      node.append(paths[i]!);
      os.insertBefore(node, this.face);
      this.layers.push({ node, layer: this.descriptor(plant, layer, index), spring: [0, 0] });
    }
    os.querySelectorAll('.pa-part').forEach((el) => el.remove());
    svg.querySelector('.pa-bloom')?.remove();
    svg.querySelector('.pa-mk')?.remove();
    const ink = this.preset.palette.light.ink;
    const paint = `style="fill:var(--pa-ink,${ink})"`;
    this.face.innerHTML = `<g class="pa-eyes"><path ${paint}/><path ${paint}/>${this.lod === 'portrait' ? `<path fill="none" style="stroke:var(--pa-ink,${ink})" stroke-width="1.1" stroke-linecap="round"/><path fill="none" style="stroke:var(--pa-ink,${ink})" stroke-width="1.1" stroke-linecap="round"/>` : ''}${this.lod !== 'glyph' ? `<path ${paint}/>` : ''}</g>`;
    const facePaths = [...this.face.querySelectorAll('path')];
    this.eyes = facePaths.slice(0, 2);
    this.brows = this.lod === 'portrait' ? facePaths.slice(2, 4) : [];
    this.mouth = this.lod === 'glyph' ? null : facePaths.at(-1)!;
    instances.set(svg, this);
    this.root.active.add(this);
    this.draw(0);
    this.root.observe.observe(svg);
    this.root.wake();
  }
  private descriptor(plant: keyof typeof PLANT_PRESETS, layer: PlantLayer, index: number) {
    return {
      index,
      tone: layer.tone,
      part: layer.part,
      at: layer.part ? this.preset.parts?.[layer.part].at : undefined,
      organ: MOTION_ORGANS[plant]?.[index] ?? undefined,
    };
  }
  setState(options: PlantAvatarSvgOptions) {
    const state = poseFor(options.state).state;
    if (!this.model.setState(state)) return;
    this.options = options;
    this.svg.setAttribute('data-state', state);
    this.svg.classList.add('pa-morph');
    // Palette switches use the canonical builder, once per request, never per frame.
    const tpl = this.svg.ownerDocument.createElement('template');
    tpl.innerHTML = buildPlantAvatarSvg({ ...options, animate: true });
    const next = tpl.content.firstElementChild!;
    this.svg.setAttribute('style', next.getAttribute('style') ?? '');
    const from = [...this.svg.querySelectorAll('.pa-os path')].filter((el) => !el.closest('.pa-look'));
    const to = [...next.querySelectorAll('.pa-os path')].filter((el) => !el.closest('.pa-look'));
    from.forEach((el, i) => {
      const style = to[i]?.getAttribute('style');
      if (style) el.setAttribute('style', style);
    });
    if (this.root.media?.matches) {
      // The fade belongs to this request; a new request replaces it without a completion callback.
      this.face.getAnimations?.().forEach((animation) => animation.cancel());
      this.face.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
    }
    this.draw(0);
    this.root.wake();
  }
  draw(dt: number) {
    this.model.setReduced(this.root.media?.matches ?? false);
    const c = this.model.advance(dt);
    this.pose.setAttribute('transform', bodyTransform(c, this.preset.pivot));
    for (const item of this.layers) {
      const goal = layerGoal(this.model.species, item.layer, c, this.model.state);
      item.spring = this.model.reduced ? [0, 0] : spring(...item.spring, goal.angle, goal.frequency, dt);
      const value = organTransform(goal.pivot, item.spring[0], this.model.reduced ? 1 : goal.scale);
      if (item.node.getAttribute('transform') !== value) item.node.setAttribute('transform', value);
    }
    const paths = facePaths(c, this.preset.face, this.lod === 'glyph' ? 20 : this.size);
    this.face.setAttribute('transform', paths.transform);
    this.eyes.forEach((el, i) => el.setAttribute('d', paths.eyes[i]!));
    this.brows.forEach((el, i) => {
      el.setAttribute('d', paths.brows[i]!);
      el.setAttribute('opacity', String(c.brow));
    });
    this.mouth?.setAttribute('d', paths.mouth);
  }
  dispose() {
    this.root.active.delete(this);
    this.root.observe.unobserve(this.svg);
    instances.delete(this.svg);
    if (!this.root.active.size) this.root.dispose();
    else this.root.wake();
  }
}
export function mountPlantMotion(svg: Element, options: PlantAvatarSvgOptions): () => void {
  const motion = new PlantMotion(svg, options);
  return () => motion.dispose();
}
/** Retarget an existing instance, preserving current position and velocity. */
export function morphPlantAvatar(svg: Element, options: PlantAvatarSvgOptions): Element {
  const instance = instances.get(svg);
  if (instance) instance.setState(options);
  return svg;
}
