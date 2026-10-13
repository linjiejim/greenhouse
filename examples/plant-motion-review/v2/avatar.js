import { Avatar as V1Avatar, runtime, wake, META, STATES, LABELS } from '../v1/motion.js';
import { MotionController, spring } from './controller.js';
const n = (x) => Math.round(x * 1000) / 1000;
/** Reuse the accepted A geometry and stable SVG nodes, replacing only motion. */
export class V2Avatar extends V1Avatar {
  constructor(host, plant, options = {}) {
    super(host, plant, options);
    this.model = new MotionController(plant, { state: options.state, seed: options.key });
    this.model.setReduced(runtime.reduced || this.static);
    this.current = this.model.values;
    this.organAngles = this.layers.map(() => [0, 0]);
    this.svg.dataset.version = 'v2';
    this.draw(0);
  }
  setState(state) {
    if (!this.model) return super.setState(state);
    if (!this.model.setState(state)) return;
    this.state = state;
    this.svg.dataset.state = state;
    const name = META.find((x) => x[0] === this.plant)[1];
    this.svg.setAttribute('aria-label', `${name} · ${LABELS[STATES.indexOf(state)]}`);
    this.dirty = true;
    if (runtime.reduced || this.static) this.draw(0);
    wake();
  }
  draw(dt) {
    if (!this.model) return super.draw(dt);
    this.dirty = false;
    runtime.draws++;
    this.model.setReduced(runtime.reduced || this.static);
    const c = this.model.advance(dt);
    this.current = this.model.values;
    const [px, py] = this.p.pivot;
    this.pose.setAttribute(
      'transform',
      `translate(0 ${n(c.y)}) translate(${px} ${py}) rotate(${n(c.rot)}) scale(${n(c.sx)} ${n(c.sy)}) translate(${-px} ${-py})`,
    );
    this.layers.forEach(({ l, group }, i) => {
      let pivot = l.part ? this.p.parts[l.part].at : l.organ?.at,
        angle = l.part ? c.leaf * (l.part === 'r' ? 1 : -0.62) : l.organ ? c.tip * l.organ.gain : 0,
        scale = 1;
      const state = this.model.state;
      // Only existing paths move; the silhouette topology and layer count stay fixed.
      if (this.plant === 'sprout' && i === 1) {
        pivot = [50, 35];
        angle = c.tip * 0.26;
      }
      if (this.plant === 'ivy' && i < 2) {
        pivot = [53, 33];
        angle = (state === 'thinking' ? c.gazeX * 0.4 : 0) + c.tip * 0.35;
      }
      if (this.plant === 'fern' && i >= 3) {
        pivot = [48, 72];
        angle = c.tip * 0.32;
      }
      if (this.plant === 'clover' && i > 0 && i < 4) {
        pivot = [50, 53];
        angle = c.tip * (i === 2 ? -1 : 1) * 0.35;
        scale = 1 + Math.abs(c.leaf) * 0.001;
      }
      if (this.plant === 'echeveria' && l.organ) {
        angle = 0;
        scale = 1 + Math.max(0, -c.leaf) * 0.003 * (l.tone === 'body' ? 1 : 0.65);
      }
      if (this.plant === 'eucalyptus' && l.organ) {
        angle = c.leaf * l.organ.gain * 0.5;
      }
      if (this.plant === 'lavender' && l.organ) {
        angle = c.leaf * l.organ.gain * 0.65;
      }
      if (this.plant === 'dandelion' && l.organ) {
        angle = c.tip * l.organ.gain * 0.12;
      }
      if (this.plant === 'maple' && i === 0) {
        pivot = [50, 94];
        angle = c.tip * 0.25;
      }
      if (pivot) {
        const delay = this.plant === 'eucalyptus' ? 5 + (i % 4) * 2 : 8 / (1 + (l.organ?.phase || 0) * 0.12);
        this.organAngles[i] =
          runtime.reduced || this.static ? [0, 0] : spring(...this.organAngles[i], angle, delay, dt);
        group.setAttribute(
          'transform',
          `translate(${pivot.join(' ')}) rotate(${n(this.organAngles[i][0])}) scale(${n(runtime.reduced ? 1 : scale)}) translate(${-pivot[0]} ${-pivot[1]})`,
        );
      }
    });
    this.face.setAttribute('transform', `translate(${n(c.gazeX)} ${n(c.gazeY)})`);
    const f = this.p.face,
      s = f.scale || 1,
      gap = Math.max(f.gap, this.size <= 20 ? 8.8 : 7),
      w = (this.size <= 20 ? 3.9 : 2.9) * s,
      h = Math.max(0.23, c.eye) * s;
    this.eyes.forEach((eye, i) => {
      const x = f.x + (i ? gap : -gap),
        y = f.y,
        curve = c.curve * s;
      eye.setAttribute(
        'd',
        `M${n(x - w)} ${y} C${n(x - w)} ${n(y + curve - h * 1.33)} ${n(x + w)} ${n(y + curve - h * 1.33)} ${n(x + w)} ${y} C${n(x + w)} ${n(y + curve + h * 1.33)} ${n(x - w)} ${n(y + curve + h * 1.33)} ${n(x - w)} ${y}Z`,
      );
      const d = i ? 1 : -1;
      this.brows[i].setAttribute('d', `M${n(x - 3)} ${n(y - 7 - d)} Q${x} ${n(y - 8.5)} ${n(x + 3)} ${n(y - 7 + d)}`);
      this.brows[i].setAttribute('opacity', n(c.brow));
    });
    const x = f.x,
      y = f.y + 8 * s,
      mw = c.width * s,
      opening = Math.max(0.2, c.mouth) * s;
    this.mouth.setAttribute(
      'd',
      `M${n(x - mw)} ${y} Q${x} ${n(y + c.smile - opening * 0.7)} ${n(x + mw)} ${y} Q${x} ${n(y + c.smile + opening * 1.5)} ${n(x - mw)} ${y}Z`,
    );
  }
}
