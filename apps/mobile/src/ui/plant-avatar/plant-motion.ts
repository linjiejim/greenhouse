/** V2 motion model. DOM-free, and every update is a Reanimated worklet. */
export type State = 'idle' | 'thinking' | 'speaking' | 'done' | 'error' | 'waiting' | 'sleep' | 'hello';
export type Species =
  | 'sprout'
  | 'ivy'
  | 'sage'
  | 'basil'
  | 'fern'
  | 'clover'
  | 'monstera'
  | 'ginkgo'
  | 'maple'
  | 'echeveria'
  | 'opuntia'
  | 'lotus'
  | 'eucalyptus'
  | 'lavender'
  | 'sunflower'
  | 'dandelion';
export interface Personality {
  name: string;
  tempo: number;
  body: number;
  leaf: number;
  breath: number;
  quiet: number;
  lag: number;
}
export interface Pose {
  rot: number;
  y: number;
  sx: number;
  sy: number;
  gazeX: number;
  gazeY: number;
  eye: number;
  curve: number;
  mouth: number;
  smile: number;
  width: number;
  brow: number;
  leaf: number;
  tip: number;
  energy: number;
}
export interface MotionData {
  personality: Personality;
  species: Species;
  state: State;
  previous: State;
  revision: number;
  time: number;
  age: number;
  reduced: boolean;
  random: number;
  phase: number;
  values: Pose;
  velocities: Pose;
  origin: Pose;
  blinkStart: number;
  nextBlink: number;
}

const p = (
  name: string,
  tempo: number,
  body: number,
  leaf: number,
  breath: number,
  quiet: number,
  lag: number,
): Personality => Object.freeze({ name, tempo, body, leaf, breath, quiet, lag });

export const PERSONALITIES: Readonly<Record<Species, Personality>> = Object.freeze({
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

const REST: Readonly<Pose> = Object.freeze({
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

const FACES: Readonly<Record<State, Partial<Pose>>> = Object.freeze({
  idle: {},
  thinking: { gazeX: 2.4, gazeY: -1.8, eye: 3.2, smile: 0.5, width: 2.7, energy: 0.13 },
  speaking: { eye: 3.7, mouth: 1.8, smile: 1.8, width: 3.8, energy: 0.3 },
  done: { eye: 0.4, curve: -2.5, mouth: 1.8, smile: 3.5, width: 4.1, energy: 0 },
  error: { eye: 3.1, brow: 0.55, smile: 0.2, mouth: 0.3, width: 2.7, energy: 0 },
  waiting: { eye: 3.8, mouth: 1.3, smile: 0.9, width: 2.2, energy: 0.3 },
  sleep: { eye: 0.23, curve: 1.8, mouth: 0.2, width: 2.1, smile: 0.5, gazeY: 1, energy: 0.15 },
  hello: { eye: 3.9, smile: 3.5, mouth: 1.1, width: 4, energy: 0 },
});

const clamp = (n: number, lo: number, hi: number) => {
  'worklet';
  return Math.max(lo, Math.min(hi, n));
};

const pulse = (t: number, start: number, duration: number) => {
  'worklet';
  return t <= start || t >= start + duration ? 0 : Math.sin((Math.PI * (t - start)) / duration) ** 2;
};

const hash = (text: string) => {
  'worklet';
  return [...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) || 1;
};

export function spring(value: number, velocity: number, goal: number, frequency: number, dt: number): [number, number] {
  'worklet';
  const delta = value - goal,
    c = velocity + frequency * delta,
    decay = Math.exp(-frequency * dt);
  return [goal + (delta + c * dt) * decay, (velocity - frequency * c * dt) * decay];
}
function gap(m: MotionData) {
  'worklet';
  let x = m.random;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  m.random = x >>> 0;
  return 3 + (3 * m.random) / 4294967296;
}
function snap(m: MotionData) {
  'worklet';
  m.values = { ...REST, ...FACES[m.state] };
  m.values.rot = 0;
  m.values.y = 0;
  m.values.sx = 1;
  m.values.sy = 1;
  m.values.leaf = 0;
  m.values.tip = 0;
  for (const key of Object.keys(m.velocities) as (keyof Pose)[]) m.velocities[key] = 0;
}
export function createMotion(
  species: Species,
  { state = 'idle', seed = '' }: { state?: State; seed?: string } = {},
): MotionData {
  'worklet';
  const random = hash(species + seed);
  const m: MotionData = {
    personality: PERSONALITIES[species],
    species,
    state,
    previous: state,
    revision: 0,
    time: 0,
    age: 2,
    reduced: false,
    random,
    phase: (random % 997) / 997,
    values: { ...REST, ...FACES[state] },
    velocities: { ...REST },
    origin: { ...REST, ...FACES[state] },
    blinkStart: -1,
    nextBlink: 0,
  };
  for (const key of Object.keys(m.velocities) as (keyof Pose)[]) m.velocities[key] = 0;
  m.nextBlink = gap(m);
  return m;
}
export function setMotionState(m: MotionData, state: State) {
  'worklet';
  if (!Object.hasOwn(FACES, state) || state === m.state) return false;
  m.revision++;
  m.previous = m.state;
  m.state = state;
  m.age = 0;
  m.origin = { ...m.values };
  if (m.reduced) snap(m);
  return true;
}
export function setMotionReduced(m: MotionData, enabled: boolean) {
  'worklet';
  if (m.reduced === enabled) return;
  m.reduced = enabled;
  if (enabled) snap(m);
  else {
    m.origin = { ...m.values };
    m.age = 2;
  }
}
export function motionGoal(m: MotionData): Pose {
  'worklet';
  const p = m.personality,
    t = m.age * p.tempo,
    waking = m.previous === 'sleep' && m.state !== 'sleep' && m.age < 0.62;
  let goal = { ...REST, ...FACES[m.state] };
  if (m.state === 'thinking') {
    goal.rot = -2.3 * p.body;
    goal.leaf = -0.55 * p.leaf;
  }
  if (m.state === 'sleep') {
    goal.rot = 1.7 * p.body;
    goal.y = 1.2;
    goal.sy = 0.994;
    goal.leaf = 1.6 * p.leaf;
  }
  if (m.state === 'hello') {
    const e = t < 1.12 ? Math.sin((t / 1.12) * Math.PI) ** 2 : 0;
    goal.rot = 1.6 * p.body * Math.sin((t / 1.12) * Math.PI * 4) * e;
    goal.leaf = 3.6 * p.leaf * Math.sin((t / 1.12) * Math.PI * 4 - 0.15) * e;
    goal.sy = 1 + 0.006 * e;
  }
  if (m.state === 'done') {
    const delay = m.previous === 'thinking' ? 0.1 : 0.04;
    if (t < delay)
      goal = {
        ...goal,
        eye: m.origin.eye,
        curve: m.origin.curve,
        mouth: m.origin.mouth,
        smile: m.origin.smile,
      };
    goal.y = -1.65 * p.body * pulse(t, 0.1, 0.67);
    goal.leaf = -1.7 * p.leaf * pulse(t, 0.17, 0.67);
    goal.sy = 1 + 0.008 * pulse(t, 0.12, 0.6);
  }
  if (m.state === 'error') {
    goal.rot = 1.5 * p.body * pulse(t, 0.1, 0.55);
    goal.sy = 1 - 0.008 * pulse(t, 0.13, 0.55);
    goal.leaf = 0.8 * p.leaf * pulse(t, 0.2, 0.52);
  }
  // Gaze gets a head start, with no queued events. Interruptions replace this
  // goal immediately and retain the current spring velocities.
  if (t < 0.065 && m.state !== 'sleep') {
    goal.rot = m.origin.rot;
    goal.y = m.origin.y;
    goal.leaf = m.origin.leaf;
  }
  if (waking) {
    goal.rot = 0;
    goal.y = 0;
    goal.gazeX = 0;
    goal.gazeY = m.age < 0.2 ? 0.5 : 0;
    goal.eye = m.age < 0.17 ? 1.4 : 3.6;
    goal.curve = 0;
    goal.leaf = m.age < 0.28 ? m.origin.leaf : 0;
    goal.mouth = 0.4;
    goal.smile = 1.6;
  }
  const talkDelay = m.previous === 'sleep' ? 0.5 : 0.075;
  if (m.state === 'speaking' && m.age >= talkDelay) {
    const durations = [0.19, 0.29, 0.23, 0.31],
      count = 2 + (hash(m.species) % 3),
      phrase = ((m.age - talkDelay) * p.tempo) % 1.8;
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
  if (m.species === 'ginkgo' && m.state === 'hello') {
    goal.rot = 1.65 * pulse(t, 0.08, 1.1);
    goal.leaf = 0;
  }
  if (m.species === 'opuntia' && ['hello', 'done'].includes(m.state)) {
    goal.rot = 0;
    goal.y = 0.55 * pulse(t, 0.35, 0.6);
    goal.leaf = 0;
  }
  if (m.species === 'echeveria') {
    goal.rot = 0;
    goal.y = 0;
    goal.sy = 1;
  }
  if (m.species === 'monstera' && m.state === 'done') {
    goal.rot = 0;
    goal.y = -0.5 * pulse(t, 0.13, 0.8);
    goal.sy = 1 + 0.004 * pulse(t, 0.13, 0.8);
  }
  if (m.species === 'sage' && m.state === 'error') {
    goal.rot = 0;
    goal.sx = 1 - 0.006 * pulse(t, 0.12, 0.65);
  }
  if (m.species === 'sunflower' && m.state === 'done') {
    goal.rot = 0;
    goal.y = -0.85 * pulse(t, 0.1, 0.8);
  }
  if (m.species === 'dandelion' && m.state === 'sleep') {
    goal.rot = 0.3;
    goal.y = 1.25;
    goal.leaf = 0.35;
  }
  if (m.state === 'speaking' && m.age >= talkDelay) {
    const phrase = ((m.age - talkDelay) * p.tempo) % 1.8;
    if (m.species === 'basil') {
      goal.y = -0.2 * pulse(phrase, 0, 0.27);
      goal.sy = 1 + 0.004 * pulse(phrase, 0, 0.27);
      goal.leaf = 0;
    }
    if (m.species === 'lavender') {
      goal.rot = 0;
      goal.y = 0;
      goal.sy = 1;
      goal.leaf = 0.9 * pulse(phrase, 0.83, 0.32);
    }
  }
  return goal;
}
export function sampleMotion(m: MotionData): Pose {
  'worklet';
  const p = m.personality,
    v = { ...m.values };
  if (m.reduced) return v;
  const cycle = p.breath + p.quiet,
    phase = (m.time + m.phase * cycle) % cycle,
    breath = phase < 1.6 ? Math.sin((phase / 1.6) * Math.PI * 2) * Math.sin((phase / 1.6) * Math.PI) ** 2 : 0;
  v.y += breath * 0.45 * v.energy;
  v.sy += breath * 0.003 * v.energy;
  const blinkAge = m.time - m.blinkStart;
  if (blinkAge >= 0 && blinkAge < 0.18 && m.state !== 'sleep') v.eye *= Math.max(0.07, Math.abs(blinkAge / 0.09 - 1));
  return v;
}
export function advanceMotion(m: MotionData, dt: number): Pose {
  'worklet';
  if (m.reduced || dt <= 0 || !Number.isFinite(dt)) return sampleMotion(m);
  dt = Math.min(dt, 0.25);
  m.time += dt;
  m.age += dt;
  const goal = motionGoal(m);
  for (const key of Object.keys(REST) as (keyof Pose)[]) {
    let frequency = 15 * m.personality.tempo;
    if (['gazeX', 'gazeY'].includes(key)) frequency = 34;
    if (['eye', 'curve', 'mouth', 'smile', 'width', 'brow'].includes(key)) frequency = 30;
    if (m.state === 'sleep') frequency = key === 'eye' ? 11 : 12;
    if (key === 'leaf') frequency = 11 * m.personality.tempo;
    if (key === 'tip') {
      frequency = 1.8 / m.personality.lag;
      goal.tip = m.values.leaf * 0.7 + m.values.rot * 0.3;
    }
    [m.values[key], m.velocities[key]] = spring(m.values[key], m.velocities[key], goal[key], frequency, dt);
  }
  // Transform guardrails are shared across profiles, independent of interruption rate.
  m.values.rot = clamp(m.values.rot, -3.2, 3.2);
  m.values.sx = clamp(m.values.sx, 0.989, 1.011);
  m.values.sy = clamp(m.values.sy, 0.986, 1.014);
  if (m.time >= m.nextBlink) {
    m.blinkStart = m.time;
    m.nextBlink = m.time + gap(m);
  }
  return sampleMotion(m);
}
/** Instance facade for web and the frozen comparison surface. */
export class MotionController {
  personality: MotionData['personality'] = PERSONALITIES.sprout;
  species: MotionData['species'] = 'sprout';
  state: MotionData['state'] = 'idle';
  previous: MotionData['previous'] = 'idle';
  revision: MotionData['revision'] = 0;
  time: MotionData['time'] = 0;
  age: MotionData['age'] = 2;
  reduced: MotionData['reduced'] = false;
  random: MotionData['random'] = 1;
  phase: MotionData['phase'] = 0;
  values: MotionData['values'] = { ...REST };
  velocities: MotionData['velocities'] = { ...REST };
  origin: MotionData['origin'] = { ...REST };
  blinkStart: MotionData['blinkStart'] = -1;
  nextBlink: MotionData['nextBlink'] = 0;

  constructor(species: Species, options: { state?: State; seed?: string } = {}) {
    Object.assign(this, createMotion(species, options));
  }
  setState(state: State) {
    return setMotionState(this, state);
  }
  setReduced(enabled: boolean) {
    setMotionReduced(this, enabled);
  }
  advance(dt: number) {
    return advanceMotion(this, dt);
  }
  sample() {
    return sampleMotion(this);
  }
  goal() {
    return motionGoal(this);
  }
}
