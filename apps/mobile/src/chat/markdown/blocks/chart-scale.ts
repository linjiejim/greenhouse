/**
 * The value axis of a cartesian chart — pure, so the root vitest can pin it
 * (no React here): a "nice" range that always includes 0 (bars grow from the
 * baseline, negative ones down), round steps (1 / 2 / 2.5 / 5 × 10ⁿ), and
 * compact tick labels (1.2k, 3.5M, 0.25).
 */

export interface ValueScale {
  min: number;
  max: number;
  step: number;
  /** min → max inclusive. */
  ticks: number[];
}

const STEPS = [1, 2, 2.5, 5, 10];

function niceStep(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const fraction = rough / base;
  const nice = STEPS.find((s) => fraction <= s + 1e-9) ?? 10;
  return nice * base;
}

/** Round off floating noise (0.1 + 0.2) at the step's precision. */
function clean(value: number, step: number): number {
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  return Number(value.toFixed(Math.min(digits, 12)));
}

/** A range over `values` (and 0) cut into at most `maxTicks` round steps. */
export function niceScale(values: readonly number[], maxTicks = 4): ValueScale {
  const finite = values.filter((v) => Number.isFinite(v));
  let lo = Math.min(0, ...finite);
  let hi = Math.max(0, ...finite);
  if (lo === hi) hi = lo + 1;
  const step = niceStep((hi - lo) / Math.max(1, maxTicks));
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(clean(v, step));
  return { min: clean(lo, step), max: clean(hi, step), step, ticks };
}

/** "1.2k", "3.5M", "0.25", "-40" — short enough for a 40-pt gutter. */
export function formatTick(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const trim = (n: number) => String(Number(n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)));
  if (abs >= 1e9) return `${sign}${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${trim(abs / 1e6)}M`;
  if (abs >= 1e4) return `${sign}${trim(abs / 1e3)}k`;
  return `${sign}${trim(abs)}`;
}
