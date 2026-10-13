// @ts-check
/**
 * DOM-free experimental motion controller. Angles are degrees; lengths use the
 * shared 100-unit plant coordinate system. No production renderer imports this.
 * Retargeting preserves both position and velocity; there is no transition queue.
 */
/** @typedef {'idle'|'thinking'|'speaking'|'done'|'error'|'waiting'|'sleep'|'hello'} State */
/** @typedef {'sprout'|'ivy'|'sage'|'basil'|'fern'|'clover'|'monstera'|'ginkgo'|'maple'|'echeveria'|'opuntia'|'lotus'|'eucalyptus'|'lavender'|'sunflower'|'dandelion'} Species */
/** @typedef {{name:string,tempo:number,body:number,leaf:number,breath:number,quiet:number,lag:number}} Personality */
/** @typedef {{rot:number,y:number,sx:number,sy:number,gazeX:number,gazeY:number,eye:number,curve:number,mouth:number,smile:number,width:number,brow:number,leaf:number,tip:number,energy:number}} Pose */
/** @param {string} name @param {number} tempo @param {number} body @param {number} leaf @param {number} breath @param {number} quiet @param {number} lag @returns {Personality} */
const p = (name, tempo, body, leaf, breath, quiet, lag) =>
  Object.freeze({ name, tempo, body, leaf, breath, quiet, lag });
/** @type {Readonly<Record<Species,Personality>>} */
export const PERSONALITIES = Object.freeze({
  sprout: p('轻快迎接', 1.14, 1, 1.1, 4.8, 1.8, 0.09),
  ivy: p('灵巧好奇', 1.06, 0.82, 1.18, 5.1, 2.1, 0.11),
  sage: p('沉静思索', 0.8, 0.45, 0.55, 6.4, 3.1, 0.18),
  basil: p('亲切爽朗', 1.08, 0.72, 0.82, 5.3, 2, 0.1),
  fern: p('卷端机灵', 0.87, 0.58, 0.91, 5.8, 2.7, 0.16),
  clover: p('含蓄雀跃', 1.02, 0.78, 0.94, 5.0, 2.2, 0.12),
  monstera: p('宽厚从容', 0.78, 0.32, 0.42, 6.8, 3.4, 0.2),
  ginkgo: p('舒展安稳', 0.82, 0.48, 0.71, 6.1, 2.9, 0.17),
  maple: p('利落专注', 1.03, 0.52, 0.48, 5.7, 2.5, 0.09),
  echeveria: p('安静笃定', 0.76, 0.24, 0.48, 7.0, 3.8, 0.21),
  opuntia: p('慢热稳重', 0.74, 0.3, 0.58, 6.7, 3.3, 0.19),
  lotus: p('缓缓展开', 0.72, 0.35, 0.93, 7.2, 3.2, 0.24),
  eucalyptus: p('有条不紊', 0.92, 0.61, 1.03, 6.0, 2.6, 0.19),
  lavender: p('温和细腻', 0.86, 0.41, 0.87, 6.3, 2.8, 0.2),
  sunflower: p('明朗沉着', 1.0, 0.56, 0.64, 5.6, 2.3, 0.12),
  dandelion: p('轻盈有余韵', 0.98, 0.63, 1.16, 6.2, 2.9, 0.23),
});
/** @type {Readonly<Pose>} */
const REST = Object.freeze({
  rot: 0,
  y: 0,
  sx: 1,
  sy: 1,
  gazeX: 0,
  gazeY: 0,
  eye: 3.5,
  curve: 0,
  mouth: 0.6,
  smile: 2.5,
  width: 3.6,
  brow: 0,
  leaf: 0,
  tip: 0,
  energy: 0.5,
});
/** @type {Readonly<Record<State,Partial<Pose>>>} */
const FACES = Object.freeze({
  idle: {},
  thinking: { gazeX: 2.4, gazeY: -1.8, eye: 3.2, smile: 0.5, width: 2.7, energy: 0.13 },
  speaking: { eye: 3.7, mouth: 1.8, smile: 1.8, width: 3.8, energy: 0.3 },
  done: { eye: 0.4, curve: -2.5, mouth: 1.8, smile: 3.5, width: 4.1, energy: 0 },
  error: { eye: 3.1, brow: 0.55, smile: 0.2, mouth: 0.3, width: 2.7, energy: 0 },
  waiting: { eye: 3.8, mouth: 1.3, smile: 0.9, width: 2.2, energy: 0.3 },
  sleep: { eye: 0.23, curve: 1.8, mouth: 0.2, width: 2.1, smile: 0.5, gazeY: 1, energy: 0.15 },
  hello: { eye: 3.9, smile: 3.5, mouth: 1.1, width: 4, energy: 0 },
});
/** @param {number} n @param {number} lo @param {number} hi */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
/** A finite, smooth-ended one-shot. @param {number} t @param {number} start @param {number} duration */
const pulse = (t, start, duration) =>
  t <= start || t >= start + duration ? 0 : Math.sin((Math.PI * (t - start)) / duration) ** 2;
/** @param {string} text */
const hash = (text) => [...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) || 1;
/** Exact critically damped spring solution (no unstable Euler integration).
 * @param {number} value @param {number} velocity @param {number} goal @param {number} frequency @param {number} dt
 * @returns {[number,number]} */
export function spring(value, velocity, goal, frequency, dt) {
  const delta = value - goal,
    c = velocity + frequency * delta,
    decay = Math.exp(-frequency * dt);
  return [goal + (delta + c * dt) * decay, (velocity - frequency * c * dt) * decay];
}
export class MotionController {
  /** @param {Species} species @param {{state?:State,seed?:string}} [options] */
  constructor(species, { state = 'idle', seed = '' } = {}) {
    this.personality = PERSONALITIES[species];
    this.species = species;
    this.state = state;
    this.previous = state;
    this.revision = 0;
    this.time = 0;
    this.age = 2;
    this.reduced = false;
    this.random = hash(species + seed);
    this.phase = (this.random % 997) / 997;
    /** @type {Pose} */ this.values = { ...REST, ...FACES[state] };
    /** @type {Pose} */ this.velocities = /** @type {Pose} */ (
      Object.fromEntries(Object.keys(REST).map((k) => [k, 0]))
    );
    this.origin = { ...this.values };
    this.blinkStart = -1;
    this.nextBlink = this.gap();
  }
  gap() {
    let x = this.random;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.random = x >>> 0;
    return 3 + (3 * this.random) / 4294967296;
  }
  /** @param {State} state */
  setState(state) {
    if (!Object.hasOwn(FACES, state) || state === this.state) return false;
    this.revision++;
    this.previous = this.state;
    this.state = state;
    this.age = 0;
    this.origin = { ...this.values };
    if (this.reduced) this.snap();
    return true;
  }
  /** @param {boolean} enabled */
  setReduced(enabled) {
    if (this.reduced === enabled) return;
    this.reduced = enabled;
    if (enabled) this.snap();
    else {
      this.origin = { ...this.values };
      this.age = 2;
    }
  }
  snap() {
    this.values = { ...REST, ...FACES[this.state] };
    this.values.rot = 0;
    this.values.y = 0;
    this.values.sx = 1;
    this.values.sy = 1;
    this.values.leaf = 0;
    this.values.tip = 0;
    for (const key of Object.keys(this.velocities)) this.velocities[/** @type {keyof Pose} */ (key)] = 0;
  }
  /** @returns {Pose} */
  goal() {
    const p = this.personality,
      t = this.age * p.tempo,
      waking = this.previous === 'sleep' && this.state !== 'sleep' && this.age < 0.62;
    let goal = { ...REST, ...FACES[this.state] };
    if (this.state === 'thinking') {
      goal.rot = -2.3 * p.body;
      goal.leaf = -0.55 * p.leaf;
    }
    if (this.state === 'sleep') {
      goal.rot = 1.7 * p.body;
      goal.y = 1.2;
      goal.sy = 0.994;
      goal.leaf = 1.6 * p.leaf;
    }
    if (this.state === 'hello') {
      const e = t < 1.12 ? Math.sin((t / 1.12) * Math.PI) ** 2 : 0;
      goal.rot = 1.6 * p.body * Math.sin((t / 1.12) * Math.PI * 4) * e;
      goal.leaf = 3.6 * p.leaf * Math.sin((t / 1.12) * Math.PI * 4 - 0.15) * e;
      goal.sy = 1 + 0.006 * e;
    }
    if (this.state === 'done') {
      const delay = this.previous === 'thinking' ? 0.1 : 0.04;
      if (t < delay)
        goal = {
          ...goal,
          eye: this.origin.eye,
          curve: this.origin.curve,
          mouth: this.origin.mouth,
          smile: this.origin.smile,
        };
      goal.y = -1.65 * p.body * pulse(t, 0.1, 0.67);
      goal.leaf = -1.7 * p.leaf * pulse(t, 0.17, 0.67);
      goal.sy = 1 + 0.008 * pulse(t, 0.12, 0.6);
    }
    if (this.state === 'error') {
      goal.rot = 1.5 * p.body * pulse(t, 0.1, 0.55);
      goal.sy = 1 - 0.008 * pulse(t, 0.13, 0.55);
      goal.leaf = 0.8 * p.leaf * pulse(t, 0.2, 0.52);
    }
    // Gaze gets a head start, with no queued events. Interruptions replace this
    // goal immediately and retain the current spring velocities.
    if (t < 0.065 && this.state !== 'sleep') {
      goal.rot = this.origin.rot;
      goal.y = this.origin.y;
      goal.leaf = this.origin.leaf;
    }
    if (waking) {
      goal.rot = 0;
      goal.y = 0;
      goal.gazeX = 0;
      goal.gazeY = this.age < 0.2 ? 0.5 : 0;
      goal.eye = this.age < 0.17 ? 1.4 : 3.6;
      goal.curve = 0;
      goal.leaf = this.age < 0.28 ? this.origin.leaf : 0;
      goal.mouth = 0.4;
      goal.smile = 1.6;
    }
    const talkDelay = this.previous === 'sleep' ? 0.5 : 0.075;
    if (this.state === 'speaking' && this.age >= talkDelay) {
      const durations = [0.19, 0.29, 0.23, 0.31],
        count = 2 + (hash(this.species) % 3),
        phrase = ((this.age - talkDelay) * p.tempo) % 1.8;
      let cursor = 0,
        opening = 0;
      for (let i = 0; i < count; i++) {
        const duration = durations[i];
        if (phrase >= cursor && phrase < cursor + duration)
          opening = Math.sin(((phrase - cursor) / duration) * Math.PI) ** 2 * (2.1 + (i % 2) * 0.6);
        cursor += duration;
      }
      goal.mouth = 0.45 + opening;
      goal.width = 3.4 + opening * 0.16;
      goal.y = -0.22 * p.body * opening;
      goal.leaf = -0.24 * p.leaf * opening;
    }
    // Species change the ordering and the gesture, not the accepted silhouette.
    if (this.species === 'ginkgo' && this.state === 'hello') {
      goal.rot = 1.65 * pulse(t, 0.08, 1.1);
      goal.leaf = 0;
    }
    if (this.species === 'opuntia' && ['hello', 'done'].includes(this.state)) {
      goal.rot = 0;
      goal.y = 0.55 * pulse(t, 0.35, 0.6);
      goal.leaf = 0;
    }
    if (this.species === 'echeveria') {
      goal.rot = 0;
      goal.y = 0;
      goal.sy = 1;
    }
    if (this.species === 'monstera' && this.state === 'done') {
      goal.rot = 0;
      goal.y = -0.5 * pulse(t, 0.13, 0.8);
      goal.sy = 1 + 0.004 * pulse(t, 0.13, 0.8);
    }
    if (this.species === 'sage' && this.state === 'error') {
      goal.rot = 0;
      goal.sx = 1 - 0.006 * pulse(t, 0.12, 0.65);
    }
    if (this.species === 'sunflower' && this.state === 'done') {
      goal.rot = 0;
      goal.y = -0.85 * pulse(t, 0.1, 0.8);
    }
    if (this.species === 'dandelion' && this.state === 'sleep') {
      goal.rot = 0.3;
      goal.y = 1.25;
      goal.leaf = 0.35;
    }
    if (this.state === 'speaking' && this.age >= talkDelay) {
      const phrase = ((this.age - talkDelay) * p.tempo) % 1.8;
      if (this.species === 'basil') {
        goal.y = -0.2 * pulse(phrase, 0, 0.27);
        goal.sy = 1 + 0.004 * pulse(phrase, 0, 0.27);
        goal.leaf = 0;
      }
      if (this.species === 'lavender') {
        goal.rot = 0;
        goal.y = 0;
        goal.sy = 1;
        goal.leaf = 0.9 * pulse(phrase, 0.83, 0.32);
      }
    }
    return goal;
  }
  /** @param {number} dt Seconds of active time; callers stop advancing while hidden/paused. */
  advance(dt) {
    if (this.reduced || dt <= 0 || !Number.isFinite(dt)) return this.sample();
    dt = Math.min(dt, 0.25);
    this.time += dt;
    this.age += dt;
    const goal = this.goal();
    for (const key of /** @type {(keyof Pose)[]} */ (Object.keys(REST))) {
      let frequency = 15 * this.personality.tempo;
      if (['gazeX', 'gazeY'].includes(key)) frequency = 34;
      if (['eye', 'curve', 'mouth', 'smile', 'width', 'brow'].includes(key)) frequency = 30;
      if (this.state === 'sleep') frequency = key === 'eye' ? 11 : 12;
      if (key === 'leaf') frequency = 11 * this.personality.tempo;
      if (key === 'tip') {
        frequency = 1.8 / this.personality.lag;
        goal.tip = this.values.leaf * 0.7 + this.values.rot * 0.3;
      }
      [this.values[key], this.velocities[key]] = spring(
        this.values[key],
        this.velocities[key],
        goal[key],
        frequency,
        dt,
      );
    }
    // Transform guardrails are shared across profiles, independent of interruption rate.
    this.values.rot = clamp(this.values.rot, -3.2, 3.2);
    this.values.sx = clamp(this.values.sx, 0.989, 1.011);
    this.values.sy = clamp(this.values.sy, 0.986, 1.014);
    if (this.time >= this.nextBlink) {
      this.blinkStart = this.time;
      this.nextBlink = this.time + this.gap();
    }
    return this.sample();
  }
  sample() {
    const p = this.personality,
      v = { ...this.values };
    if (this.reduced) return v;
    const cycle = p.breath + p.quiet,
      phase = (this.time + this.phase * cycle) % cycle,
      breath = phase < 1.6 ? Math.sin((phase / 1.6) * Math.PI * 2) * Math.sin((phase / 1.6) * Math.PI) ** 2 : 0;
    v.y += breath * 0.45 * v.energy;
    v.sy += breath * 0.003 * v.energy;
    const blinkAge = this.time - this.blinkStart;
    if (blinkAge >= 0 && blinkAge < 0.18 && this.state !== 'sleep')
      v.eye *= Math.max(0.07, Math.abs(blinkAge / 0.09 - 1));
    return v;
  }
}
