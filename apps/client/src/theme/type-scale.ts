/**
 * The in-app text size (最小 / 更小 / 小 / 标准 / 大 / 特大 / 超大). React-free (./type-scale.test.ts).
 *
 * The chosen step multiplies the type ramp of src/theme.ts; React Native then multiplies the
 * result by the system Dynamic Type size, so both apply. Body text and cards follow it; native
 * bars, tab bars, menus and SwiftUI forms follow the system only.
 */

export const TEXT_STEPS = [0.8, 0.85, 0.9, 1, 1.1, 1.2, 1.35] as const;

/** i18n keys of the steps (`me.textStep.<name>`), in TEXT_STEPS order. */
export const TEXT_STEP_NAMES = ['smallest', 'smaller', 'small', 'standard', 'large', 'larger', 'largest'] as const;

export type TextStep = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const DEFAULT_TEXT_STEP: TextStep = 3;

/** A multiplier (the account preference, or the phone's saved `textScale`) as a step; anything unknown is the default. */
export function textStepOf(value: unknown): TextStep {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_TEXT_STEP;
  const index = TEXT_STEPS.findIndex((scale) => Math.abs(scale - n) < 0.001);
  return index >= 0 ? (index as TextStep) : DEFAULT_TEXT_STEP;
}

/** A text style at a multiplier: size and line height scale and round to whole points. */
export function scaleText<T extends { fontSize: number; lineHeight?: number }>(style: T, factor: number): T {
  if (factor === 1) return style;
  return {
    ...style,
    fontSize: Math.round(style.fontSize * factor),
    ...(style.lineHeight ? { lineHeight: Math.round(style.lineHeight * factor) } : {}),
  };
}
