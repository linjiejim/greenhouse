import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { themeTokens } from './tokens.generated.js';

const css = readFileSync(new URL('../tailwind.css', import.meta.url), 'utf8');
const used = [...new Set([...css.matchAll(/var\((--gh-[a-z0-9-]+)\)/g)].map((m) => m[1]!))];
const names = [...css.matchAll(/^\s+(--color-[a-z0-9-]+):/gm)].map((m) => m[1]!);

// The 3.x web app's semantic colours, kept so a ported plugin UI keeps its class names.
const LEGACY = [
  'surface-canvas',
  'surface-chrome',
  'surface',
  'surface-card',
  'surface-raised',
  'surface-muted',
  'surface-sunken',
  'fg',
  'fg-secondary',
  'fg-muted',
  'fg-faint',
  'edge',
  'edge-strong',
  'logo-safe',
  ...[50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => `primary-${n}`),
  ...['success', 'warning', 'danger', 'info'].flatMap((s) => [s, `${s}-subtle`, `${s}-fg`]),
  'destructive',
  'destructive-hover',
  'on-destructive',
  'star',
  'star-hover',
  'primary-subtle',
  'primary-subtle-hover',
  'primary-edge',
  'primary-fg',
  'primary-fg-strong',
  'accent',
  'accent-hover',
  'accent-pressed',
  'on-accent',
  ...['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink'].flatMap((c) => [
    `cat-${c}`,
    `cat-${c}-fill`,
  ]),
];

// The jim-uiux / shadcn names new plugin code (and the React kit) uses.
const SEMANTIC = [
  'background',
  'foreground',
  'muted-foreground',
  'faint-foreground',
  'card',
  'popover',
  'sunken',
  'muted',
  'hover',
  'pressed',
  'selected',
  'border',
  'input',
  'ring',
  'primary',
  'primary-foreground',
  'primary-hover',
  'destructive-foreground',
  'destructive-subtle',
  'scrim',
];

describe('tailwind.css embed theme', () => {
  it('maps only tokens the host sends, in both appearances', () => {
    for (const mode of ['light', 'dark'] as const) {
      const missing = used.filter((name) => !(name in themeTokens[mode]));
      expect(missing, mode).toEqual([]);
    }
  });

  it('keeps every 3.x colour name beside the semantic ones', () => {
    expect(names.map((n) => n.slice('--color-'.length)).sort()).toEqual([...LEGACY, ...SEMANTIC].sort());
  });

  it('gives embeds the type scale, role radii, elevation, Nunito and a host-driven dark variant', () => {
    for (const name of ['caption', 'label', 'body', 'body-lg', 'title-sm', 'title', 'title-lg', 'display'])
      expect(css).toContain(`--text-${name}:`);
    for (const name of ['control', 'menu', 'dialog', 'card', 'sheet']) expect(css).toContain(`--radius-${name}:`);
    expect(css).toContain('--shadow-overlay: var(--gh-shadow-floating)');
    expect(css).toContain("url('./fonts/nunito-variable.woff2')");
    expect(css).toMatch(/@custom-variant dark .*data-theme='dark'/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
