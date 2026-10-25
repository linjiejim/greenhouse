/**
 * How each platform names the shared roles. Pure data + lookups (no fs), read by the renderers
 * (./render.ts) and by the parity test, so "which web variable is which mobile key" is written once.
 */

import {
  categorical,
  chartSeries,
  color,
  native,
  shadow,
  type ColorToken,
  type ModeValue,
  type ThemeMode,
} from './tokens';

/** Web `--t-*` variables → the role they render. Names stay stable: the whole web app uses them. */
export const WEB_ROLES = {
  '--t-surface-canvas': 'canvas',
  '--t-surface-chrome': 'chrome',
  '--t-surface': 'surface',
  '--t-surface-card': 'card',
  '--t-surface-raised': 'raised',
  '--t-surface-muted': 'fill',
  '--t-surface-sunken': 'sunken',
  '--t-fg': 'text',
  '--t-fg-secondary': 'secondary',
  '--t-fg-muted': 'tertiary',
  '--t-fg-faint': 'faint',
  '--t-edge': 'line',
  '--t-edge-strong': 'lineStrong',
  '--t-success': 'success',
  '--t-success-subtle': 'successFill',
  '--t-success-fg': 'success',
  '--t-warning': 'warning',
  '--t-warning-subtle': 'warningFill',
  '--t-warning-fg': 'warning',
  '--t-danger': 'danger',
  '--t-danger-subtle': 'dangerFill',
  '--t-danger-fg': 'danger',
  '--t-info': 'info',
  '--t-info-subtle': 'infoFill',
  '--t-info-fg': 'info',
  '--t-destructive': 'danger',
  '--t-destructive-hover': 'dangerHover',
  '--t-star': 'star',
  '--t-star-hover': 'starHover',
  '--t-accent': 'accent',
  '--t-accent-hover': 'accentHover',
  '--t-accent-pressed': 'accentPressed',
  '--t-on-accent': 'onAccent',
  '--t-primary-subtle': 'accentFill',
  '--t-primary-subtle-hover': 'accentFillHover',
  '--t-primary-edge': 'accentEdge',
  '--t-primary-fg': 'accentText',
  '--t-primary-fg-strong': 'accentTextStrong',
  '--t-primary-wash': 'accentWash',
  '--t-focus-ring': 'focus',
  '--t-brand-mark': 'brandMark',
  '--t-brand-seed': 'brandSeed',
  '--t-scrim': 'scrim',
} as const satisfies Record<string, ColorToken>;

/** Roles that never follow a workspace brand colour (the mark is fixed). */
export const FIXED_ROLES: ReadonlySet<ColorToken> = new Set(['brandMark', 'brandSeed']);

type MobileSource = { role: ColorToken } | { value: ModeValue };
const role = (r: ColorToken): MobileSource => ({ role: r });
const value = (v: ModeValue): MobileSource => ({ value: v });
const both = (v: string): ModeValue => ({ light: v, dark: v });

/**
 * Mobile palette keys (apps/mobile/src/theme/palette.ts) → a shared role, or a native-only value
 * from `native`. Keys keep iOS's semantic names so screens never change when a value does.
 */
export const MOBILE_ROLES = {
  accent: role('accent'),
  onAccent: role('onAccent'),
  accentFill: role('accentFill'),
  accentText: role('accentText'),
  onTint: value(both('#FFFFFF')),
  mark: role('brandMark'),
  seed: role('brandSeed'),

  background: value(native.base),
  secondaryBackground: role('chrome'),
  tertiaryBackground: value(native.elevated),
  groupedBackground: value({ light: color.chrome.light, dark: native.base.dark }),
  secondaryGroupedBackground: value({ light: color.raised.light, dark: color.chrome.dark }),
  tertiaryGroupedBackground: value({ light: native.base.light, dark: native.elevated.dark }),
  sidebarBackground: role('deep'),
  sidebarSelection: value(native.sidebarSelection),
  /** The brand canvas behind sign-in (never the system grey). */
  brandCanvas: value({ light: color.chrome.light, dark: native.base.dark }),

  label: role('text'),
  secondaryLabel: role('secondary'),
  tertiaryLabel: role('tertiary'),
  quaternaryLabel: value(native.quaternaryLabel),
  placeholder: role('tertiary'),
  link: role('accentText'),

  separator: value(native.separator),
  opaqueSeparator: value(native.opaqueSeparator),
  fill: value(native.fill),
  secondaryFill: value(native.secondaryFill),
  tertiaryFill: value(native.tertiaryFill),
  quaternaryFill: value(native.quaternaryFill),

  red: role('danger'),
  redFill: role('dangerFill'),
  orange: role('warning'),
  orangeFill: role('warningFill'),
  green: role('success'),
  greenFill: role('successFill'),
  blue: role('info'),
  blueFill: role('infoFill'),
  // Solid tiles behind a white glyph take the light status colours in both modes.
  redTile: value(both(color.danger.light)),
  orangeTile: value(both(color.warning.light)),
  greenTile: value(both(color.success.light)),
  blueTile: value(both(color.info.light)),
  yellow: value(native.yellow),
  indigo: value(categorical.blue.fg),
  purple: value(categorical.purple.fg),
  gray: value(categorical.gray.fg),

  codeBg: value(both(native.code.bg)),
  codeHeader: value(both(native.code.header)),
  codeText: value(both(native.code.text)),
  codeComment: value(both(native.code.comment)),
  codeLabel: value(both(native.code.label)),
  codeKeyword: value(both(native.code.keyword)),
  codeString: value(both(native.code.string)),
  codeNumber: value(both(native.code.number)),

  scrim: value(native.scrim),
} as const satisfies Record<string, MobileSource>;

export type MobilePaletteKey = keyof typeof MOBILE_ROLES;

/** The resolved mobile palette for one mode. */
export function mobilePalette(mode: ThemeMode): Record<MobilePaletteKey, string> {
  const out = {} as Record<MobilePaletteKey, string>;
  for (const [key, source] of Object.entries(MOBILE_ROLES) as Array<[MobilePaletteKey, MobileSource]>) {
    out[key] = 'role' in source ? color[source.role][mode] : source.value[mode];
  }
  return out;
}

/** The resolved web colour variables for one mode (literal values, before ramp references). */
export function webColors(mode: ThemeMode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, r] of Object.entries(WEB_ROLES)) out[name] = color[r][mode];
  for (const [name, pair] of Object.entries(categorical)) {
    out[`--t-cat-${name}`] = pair.fg[mode];
    out[`--t-cat-${name}-fill`] = pair.fill[mode];
  }
  chartSeries.forEach((series, index) => {
    out[`--t-chart-${index + 1}`] = series === 'accent' ? color.accent[mode] : categorical[series].fg[mode];
  });
  for (const [name, v] of Object.entries(shadow)) out[`--t-shadow-${name}`] = v[mode];
  return out;
}
