/**
 * Renders the Native Haven token module into CSS custom properties.
 * Pure (no fs) so the unit test can compare it with the committed `haven.css`.
 */

import {
  avatar,
  breakpoint,
  categorical,
  chartSeries,
  color,
  font,
  icon,
  layout,
  motion,
  radius,
  shadow,
  share,
  space,
  stroke,
  type,
  zIndex,
  type ThemeMode,
} from './haven';

export const CSS_PREFIX = '--gh-';

export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function cssVar(name: string): string {
  return `${CSS_PREFIX}${kebab(name)}`;
}

function modeDeclarations(mode: ThemeMode): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(color)) lines.push(`${cssVar(name)}: ${value[mode]};`);
  for (const [name, pair] of Object.entries(categorical)) {
    lines.push(`${cssVar(`cat-${name}`)}: ${pair.fg[mode]};`);
    lines.push(`${cssVar(`cat-${name}-fill`)}: ${pair.fill[mode]};`);
  }
  chartSeries.forEach((series, index) => {
    const value = series === 'accent' ? `var(${cssVar('accent')})` : `var(${cssVar(`cat-${series}`)})`;
    lines.push(`${cssVar(`chart-${index + 1}`)}: ${value};`);
  });
  for (const [name, value] of Object.entries(shadow)) lines.push(`${cssVar(`shadow-${name}`)}: ${value[mode]};`);
  lines.push(`color-scheme: ${mode};`);
  return lines;
}

function staticDeclarations(): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(font)) lines.push(`${cssVar(`font-${name}`)}: ${value};`);
  for (const [name, style] of Object.entries(type)) {
    const family = `var(${cssVar(`font-${'family' in style ? style.family : 'sans'}`)})`;
    lines.push(`${cssVar(`type-${name}`)}: ${style.weight} ${style.size}px/${style.line}px ${family};`);
  }
  for (const [name, value] of Object.entries(space)) {
    lines.push(`${cssVar(`space-${name.replace('.', '_')}`)}: ${value}px;`);
  }
  for (const [name, value] of Object.entries(radius)) lines.push(`${cssVar(`radius-${name}`)}: ${value}px;`);
  for (const [name, value] of Object.entries(motion)) lines.push(`${cssVar(name)}: ${value};`);
  for (const [name, value] of Object.entries(zIndex)) lines.push(`${cssVar(`z-${name}`)}: ${value};`);
  for (const [name, value] of Object.entries(layout)) lines.push(`${cssVar(name)}: ${value}px;`);
  for (const [name, value] of Object.entries(share)) lines.push(`${cssVar(`${name}-share`)}: ${value}%;`);
  for (const [name, value] of Object.entries(avatar)) lines.push(`${cssVar(`avatar-${name}`)}: ${value}px;`);
  for (const [name, value] of Object.entries(stroke)) lines.push(`${cssVar(`stroke-${name}`)}: ${value}px;`);
  lines.push(`${cssVar('icon-sm')}: ${icon.sm}px;`);
  lines.push(`${cssVar('icon-md')}: ${icon.md}px;`);
  lines.push(`${cssVar('icon-lg')}: ${icon.lg}px;`);
  lines.push(`${cssVar('icon-stroke')}: ${icon.stroke};`);
  return lines;
}

function block(selector: string, declarations: string[], indent = ''): string {
  const body = declarations.map((line) => `${indent}  ${line}`).join('\n');
  return `${indent}${selector} {\n${body}\n${indent}}`;
}

/**
 * Theme selection:
 *   - `data-theme="light|dark"` on any ancestor (the app sets it on <html>; previews set it on a frame),
 *   - with no `data-theme` on <html>, the OS preference decides (no-JS fallback for "system").
 */
export function renderHavenCss(): string {
  const breakpoints = Object.entries(breakpoint)
    .map(([name, value]) => `${name} ${value}px`)
    .join(' · ');
  return [
    '/* GENERATED from packages/ui/src/tokens/haven.ts by `pnpm tokens:build` — do not edit by hand. */',
    '/* Spec: docs/design-system/foundations.md */',
    `/* Breakpoints (use in media queries, not variables): ${breakpoints} */`,
    '',
    block(':root', staticDeclarations()),
    '',
    block(":root,\n[data-theme='light']", modeDeclarations('light')),
    '',
    block("[data-theme='dark']", modeDeclarations('dark')),
    '',
    '@media (prefers-color-scheme: dark) {',
    block(':root:not([data-theme])', modeDeclarations('dark'), '  '),
    '}',
    '',
  ].join('\n');
}
