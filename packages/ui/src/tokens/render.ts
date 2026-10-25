/**
 * Renders the token module into the two generated files. Pure (no fs, no formatter) so the
 * freshness tests can compare it with what is committed; scripts/build-tokens.ts writes them.
 */

import { rgbTriplet } from './contrast';
import { FIXED_ROLES, WEB_ROLES, mobilePalette, webColors } from './platforms';
import {
  categorical,
  color,
  font,
  motion,
  primaryRamp,
  radius,
  type,
  zIndex,
  type ColorToken,
  type ThemeMode,
} from './tokens';

export const WEB_CSS_PATH = 'packages/ui/src/tokens/tokens.css';
export const MOBILE_TS_PATH = 'apps/mobile/src/theme/tokens.generated.ts';

const HEADER = 'GENERATED from packages/ui/src/tokens/tokens.ts by `pnpm tokens:build` — do not edit by hand.';

const RAMP_BY_TRIPLET = new Map(
  Object.entries(primaryRamp).map(([shade, hex]) => [rgbTriplet(hex).triplet, shade] as const),
);

/**
 * A role that sits on the green ramp is written as a reference to it, so a workspace brand colour
 * (Branding Studio regenerates `--primary-*`) flows into the accent, links, focus and fills.
 */
function webValue(variable: string, literal: string): string {
  const roleName = (WEB_ROLES as Record<string, ColorToken>)[variable];
  if (roleName && FIXED_ROLES.has(roleName)) return literal;
  if (literal.startsWith('#') || literal.startsWith('rgb')) {
    const { triplet, alpha } = rgbTriplet(literal);
    const shade = RAMP_BY_TRIPLET.get(triplet);
    if (shade) return alpha === 1 ? `rgb(var(--primary-${shade}))` : `rgb(var(--primary-${shade}) / ${alpha})`;
  }
  return literal;
}

function modeBlock(mode: ThemeMode): string[] {
  const lines = Object.entries(webColors(mode)).map(([name, literal]) => `${name}: ${webValue(name, literal)};`);
  lines.push(`color-scheme: ${mode};`);
  return lines;
}

const rem = (px: number) => `${+(px / 16).toFixed(4)}rem`;

function staticBlock(): string[] {
  const lines: string[] = [];
  for (const [shade, hex] of Object.entries(primaryRamp)) lines.push(`--primary-${shade}: ${rgbTriplet(hex).triplet};`);
  for (const [name, value] of Object.entries(motion)) {
    const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    lines.push(typeof value === 'number' ? `--gh-duration-${kebab}: ${value}ms;` : `--gh-${kebab}: ${value};`);
  }
  for (const [name, value] of Object.entries(zIndex)) lines.push(`--gh-z-${name}: ${value};`);
  return lines;
}

/** Tailwind theme variables: utilities (`rounded-lg`, `text-caption`, `ease-standard`, …) compile from these. */
function themeBlock(): string[] {
  const lines: string[] = [];
  lines.push(`--font-sans: ${font.sans};`);
  lines.push(`--font-mono: ${font.mono};`);
  lines.push(`--radius: ${rem(radius.xs)};`);
  for (const [name, px] of Object.entries(radius)) {
    if (name !== 'full') lines.push(`--radius-${name}: ${rem(px)};`);
  }
  for (const name of ['caption', 'label', 'bodyLg'] as const) {
    const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    lines.push(`--text-${kebab}: ${rem(type[name].size)};`);
    lines.push(`--text-${kebab}--line-height: ${rem(type[name].line)};`);
  }
  lines.push(`--ease-standard: ${motion.easeStandard};`);
  lines.push(`--ease-enter: ${motion.easeEnter};`);
  lines.push(`--ease-exit: ${motion.easeExit};`);
  lines.push(`--default-transition-duration: ${motion.fast}ms;`);
  lines.push(`--default-transition-timing-function: ${motion.easeStandard};`);
  lines.push(`--animate-spin: spin ${motion.loop}ms linear infinite;`);
  return lines;
}

function block(selector: string, declarations: string[]): string {
  return `${selector} {\n${declarations.map((line) => `  ${line}`).join('\n')}\n}`;
}

/** The web's CSS variables (unformatted; the build script and the test both run prettier on it). */
export function renderWebCss(): string {
  return [
    `/* ${HEADER} */`,
    '/* Light is :root; the theme system toggles .dark-theme on <html>. app.css maps these into Tailwind. */',
    '',
    block('@theme', themeBlock()),
    '',
    block(':root', staticBlock()),
    '',
    block(':root', modeBlock('light')),
    '',
    block('.dark-theme', modeBlock('dark')),
    '',
  ].join('\n');
}

/** The mobile copy (apps/mobile sits outside the workspace, so it cannot import this package). */
export function renderMobileTs(): string {
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const categoricalHex = Object.fromEntries(
    (['light', 'dark'] as const).map((mode) => [
      mode,
      Object.fromEntries(
        Object.entries(categorical).map(([name, pair]) => [name, { fg: pair.fg[mode], fill: pair.fill[mode] }]),
      ),
    ]),
  );
  return [
    `/** ${HEADER} */`,
    '',
    '/** The native palette per appearance (keys: apps/mobile/src/theme/palette.ts). */',
    `export const nativePalette = ${json({ light: mobilePalette('light'), dark: mobilePalette('dark') })} as const;`,
    '',
    '/** User-chosen colours (projects, tags, options): text or icon `fg` on `fill`. */',
    `export const categoricalHex = ${json(categoricalHex)} as const;`,
    '',
    '/** The shared radius scale in points. */',
    `export const radiusScale = ${json(radius)} as const;`,
    '',
    '/** Motion durations in ms and easing curves. */',
    `export const motionTokens = ${json(motion)} as const;`,
    '',
    '/** Brand colours of the mark. */',
    `export const brandHex = ${json({ mark: color.brandMark, seed: color.brandSeed })} as const;`,
    '',
  ].join('\n');
}
