/** V2 transforms and face paths, shared verbatim with native. Geometry stays in the catalogue. */
import type { Pose, Species, State } from './plant-motion';
export interface Organ {
  at: readonly [number, number];
  gain: number;
  phase: number;
}
export interface MotionLayer {
  at?: readonly [number, number];
  part?: 'l' | 'r';
  organ?: Organ;
  tone: string;
  index: number;
}
export const MOTION_ORGANS: Partial<Record<Species, readonly (Organ | null)[]>> = {
  echeveria: [
    { at: [50, 50], gain: 0.28, phase: 0 },
    { at: [50, 50], gain: 0.28, phase: 0.63 },
    { at: [50, 50], gain: 0.28, phase: 1.26 },
    { at: [50, 50], gain: 0.28, phase: 1.8900000000000001 },
    { at: [50, 50], gain: 0.28, phase: 2.52 },
    { at: [50, 50], gain: 0.28, phase: 3.15 },
    { at: [50, 50], gain: 0.28, phase: 3.7800000000000002 },
    { at: [50, 50], gain: 0.28, phase: 4.41 },
    { at: [50, 50], gain: 0.28, phase: 5.04 },
    { at: [50, 50], gain: 0.17, phase: 0 },
    { at: [50, 50], gain: 0.17, phase: 0.8 },
    { at: [50, 50], gain: 0.17, phase: 1.6 },
    { at: [50, 50], gain: 0.17, phase: 2.4000000000000004 },
    { at: [50, 50], gain: 0.17, phase: 3.2 },
    { at: [50, 50], gain: 0.17, phase: 4 },
    { at: [50, 50], gain: 0.17, phase: 4.800000000000001 },
    null,
    null,
  ],
  opuntia: [null, null, null, null, { at: [51, 25], gain: 0.55, phase: 0.7 }, { at: [51, 25], gain: 0.55, phase: 0.7 }],
  eucalyptus: [
    null,
    { at: [61, 17], gain: 1.2, phase: 1.2 },
    { at: [58, 28], gain: 1, phase: 0.9 },
    { at: [56, 39], gain: 0.8, phase: 0.65 },
    { at: [54, 49], gain: 0.65, phase: 0.4 },
    { at: [53, 55], gain: 0.45, phase: 0.2 },
    { at: [47, 67], gain: 0.25, phase: 0 },
    null,
  ],
  lavender: [null, null, null, { at: [50, 83], gain: 0.42, phase: 0.8 }, null, null],
  sunflower: [
    null,
    { at: [50, 30], gain: 0.32, phase: 0 },
    { at: [60.58013454126451, 33.43769410125095], gain: 0.32, phase: 0.65 },
    { at: [67.11901729331277, 42.43769410125095], gain: 0.32, phase: 1.3 },
    { at: [67.11901729331277, 53.56230589874905], gain: 0.32, phase: 1.9500000000000002 },
    { at: [60.58013454126451, 62.56230589874905], gain: 0.32, phase: 2.6 },
    { at: [50, 66], gain: 0.32, phase: 3.25 },
    { at: [39.41986545873549, 62.56230589874905], gain: 0.32, phase: 3.9000000000000004 },
    { at: [32.880982706687234, 53.56230589874905], gain: 0.32, phase: 4.55 },
    { at: [32.880982706687234, 42.43769410125094], gain: 0.32, phase: 5.2 },
    { at: [39.41986545873548, 33.43769410125095], gain: 0.32, phase: 5.8500000000000005 },
    null,
    null,
  ],
  dandelion: [
    null,
    { at: [50, 26], gain: 0.35, phase: 0 },
    { at: [50, 26], gain: 0.35, phase: 0 },
    { at: [50, 26], gain: 0.35, phase: 0 },
    { at: [58.24379104323361, 27.88159150985404], gain: 0.35, phase: 0.48 },
    { at: [58.24379104323361, 27.88159150985404], gain: 0.35, phase: 0.48 },
    { at: [58.24379104323361, 27.88159150985404], gain: 0.35, phase: 0.48 },
    { at: [64.85479816689256, 33.153693764684064], gain: 0.35, phase: 0.96 },
    { at: [64.85479816689256, 33.153693764684064], gain: 0.35, phase: 0.96 },
    { at: [64.85479816689256, 33.153693764684064], gain: 0.35, phase: 0.96 },
    { at: [68.52363033145465, 40.772102254830024], gain: 0.35, phase: 1.44 },
    { at: [68.52363033145465, 40.772102254830024], gain: 0.35, phase: 1.44 },
    { at: [68.52363033145465, 40.772102254830024], gain: 0.35, phase: 1.44 },
    { at: [68.52363033145465, 49.227897745169976], gain: 0.35, phase: 1.92 },
    { at: [68.52363033145465, 49.227897745169976], gain: 0.35, phase: 1.92 },
    { at: [68.52363033145465, 49.227897745169976], gain: 0.35, phase: 1.92 },
    { at: [64.85479816689256, 56.84630623531594], gain: 0.35, phase: 2.4 },
    { at: [64.85479816689256, 56.84630623531594], gain: 0.35, phase: 2.4 },
    { at: [64.85479816689256, 56.84630623531594], gain: 0.35, phase: 2.4 },
    { at: [58.24379104323361, 62.11840849014596], gain: 0.35, phase: 2.88 },
    { at: [58.24379104323361, 62.11840849014596], gain: 0.35, phase: 2.88 },
    { at: [58.24379104323361, 62.11840849014596], gain: 0.35, phase: 2.88 },
    { at: [50, 64], gain: 0.35, phase: 3.36 },
    { at: [50, 64], gain: 0.35, phase: 3.36 },
    { at: [50, 64], gain: 0.35, phase: 3.36 },
    { at: [41.756208956766386, 62.11840849014596], gain: 0.35, phase: 3.84 },
    { at: [41.756208956766386, 62.11840849014596], gain: 0.35, phase: 3.84 },
    { at: [41.756208956766386, 62.11840849014596], gain: 0.35, phase: 3.84 },
    { at: [35.145201833107436, 56.846306235315936], gain: 0.35, phase: 4.32 },
    { at: [35.145201833107436, 56.846306235315936], gain: 0.35, phase: 4.32 },
    { at: [35.145201833107436, 56.846306235315936], gain: 0.35, phase: 4.32 },
    { at: [31.476369668545352, 49.227897745169976], gain: 0.35, phase: 4.8 },
    { at: [31.476369668545352, 49.227897745169976], gain: 0.35, phase: 4.8 },
    { at: [31.476369668545352, 49.227897745169976], gain: 0.35, phase: 4.8 },
    { at: [31.47636966854535, 40.77210225483004], gain: 0.35, phase: 5.279999999999999 },
    { at: [31.47636966854535, 40.77210225483004], gain: 0.35, phase: 5.279999999999999 },
    { at: [31.47636966854535, 40.77210225483004], gain: 0.35, phase: 5.279999999999999 },
    { at: [35.145201833107436, 33.153693764684064], gain: 0.35, phase: 5.76 },
    { at: [35.145201833107436, 33.153693764684064], gain: 0.35, phase: 5.76 },
    { at: [35.145201833107436, 33.153693764684064], gain: 0.35, phase: 5.76 },
    { at: [41.75620895676639, 27.88159150985404], gain: 0.35, phase: 6.24 },
    { at: [41.75620895676639, 27.88159150985404], gain: 0.35, phase: 6.24 },
    { at: [41.75620895676639, 27.88159150985404], gain: 0.35, phase: 6.24 },
    null,
    null,
  ],
};
export function layerGoal(plant: Species, l: MotionLayer, c: Pose, state: State) {
  'worklet';
  const i = l.index;
  let pivot = l.at ?? l.organ?.at;
  let angle = l.part ? c.leaf * (l.part === 'r' ? 1 : -0.62) : l.organ ? c.tip * l.organ.gain : 0;
  let scale = 1;
  if (plant === 'sprout' && i === 1) {
    pivot = [50, 35];
    angle = c.tip * 0.26;
  }
  if (plant === 'ivy' && i < 2) {
    pivot = [53, 33];
    angle = (state === 'thinking' ? c.gazeX * 0.4 : 0) + c.tip * 0.35;
  }
  if (plant === 'fern' && i >= 3) {
    pivot = [48, 72];
    angle = c.tip * 0.32;
  }
  if (plant === 'clover' && i > 0 && i < 4) {
    pivot = [50, 53];
    angle = c.tip * (i === 2 ? -1 : 1) * 0.35;
    scale = 1 + Math.abs(c.leaf) * 0.001;
  }
  if (plant === 'echeveria' && l.organ) {
    angle = 0;
    scale = 1 + Math.max(0, -c.leaf) * 0.003 * (l.tone === 'body' ? 1 : 0.65);
  }
  if (plant === 'eucalyptus' && l.organ) angle = c.leaf * l.organ.gain * 0.5;
  if (plant === 'lavender' && l.organ) angle = c.leaf * l.organ.gain * 0.65;
  if (plant === 'dandelion' && l.organ) angle = c.tip * l.organ.gain * 0.12;
  if (plant === 'maple' && i === 0) {
    pivot = [50, 94];
    angle = c.tip * 0.25;
  }
  const frequency = plant === 'eucalyptus' ? 5 + (i % 4) * 2 : 8 / (1 + (l.organ?.phase || 0) * 0.12);
  return { pivot, angle, scale, frequency };
}
const n = (x: number) => {
  'worklet';
  return Math.round(x * 1000) / 1000;
};
export function bodyTransform(c: Pose, pivot: readonly [number, number]) {
  'worklet';
  const [x, y] = pivot;
  return `translate(0 ${n(c.y)}) translate(${x} ${y}) rotate(${n(c.rot)}) scale(${n(c.sx)} ${n(c.sy)}) translate(${-x} ${-y})`;
}
export function organTransform(pivot: readonly [number, number] | undefined, angle: number, scale: number) {
  'worklet';
  if (!pivot) return '';
  const [x, y] = pivot;
  return `translate(${x} ${y}) rotate(${n(angle)}) scale(${n(scale)}) translate(${-x} ${-y})`;
}
export interface FaceMetrics {
  x: number;
  y: number;
  scale?: number;
  gap: number;
}
export function facePaths(c: Pose, f: FaceMetrics, size: number) {
  'worklet';
  const s = f.scale || 1,
    gap = Math.max(f.gap, size <= 20 ? 8.8 : 7),
    w = (size <= 20 ? 3.9 : 2.9) * s,
    h = Math.max(0.23, c.eye) * s;
  const eyes = [-1, 1].map((side) => {
    const x = f.x + side * gap,
      y = f.y,
      curve = c.curve * s;
    return `M${n(x - w)} ${y} C${n(x - w)} ${n(y + curve - h * 1.33)} ${n(x + w)} ${n(y + curve - h * 1.33)} ${n(x + w)} ${y} C${n(x + w)} ${n(y + curve + h * 1.33)} ${n(x - w)} ${n(y + curve + h * 1.33)} ${n(x - w)} ${y}Z`;
  });
  const brows = [-1, 1].map((side) => {
    const x = f.x + side * gap,
      y = f.y;
    return `M${n(x - 3)} ${n(y - 7 - side)} Q${x} ${n(y - 8.5)} ${n(x + 3)} ${n(y - 7 + side)}`;
  });
  const x = f.x,
    y = f.y + 8 * s,
    mw = c.width * s,
    opening = Math.max(0.2, c.mouth) * s;
  const mouth = `M${n(x - mw)} ${y} Q${x} ${n(y + c.smile - opening * 0.7)} ${n(x + mw)} ${y} Q${x} ${n(y + c.smile + opening * 1.5)} ${n(x - mw)} ${y}Z`;
  return { eyes, brows, mouth, transform: `translate(${n(c.gazeX)} ${n(c.gazeY)})` };
}
export function poseMatrix(c: Pose, pivot: readonly [number, number]): number[] {
  'worklet';
  const r = (c.rot * Math.PI) / 180,
    a = Math.cos(r) * c.sx,
    b = Math.sin(r) * c.sx,
    cc = -Math.sin(r) * c.sy,
    d = Math.cos(r) * c.sy;
  const [x, y] = pivot;
  return [a, b, cc, d, x - a * x - cc * y, c.y + y - b * x - d * y];
}
export function layerMatrix(pivot: readonly [number, number] | undefined, angle: number, scale: number): number[] {
  'worklet';
  return poseMatrix({ rot: angle, sx: scale, sy: scale, y: 0 } as Pose, pivot ?? [0, 0]);
}
