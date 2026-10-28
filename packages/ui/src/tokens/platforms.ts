/**
 * How the client palette names the shared roles. Pure data + lookups (no fs), read by the renderers
 * (./render.ts), so "which mobile key is which role" is written once.
 */

import { categorical, color, native, type ColorToken, type ModeValue, type ThemeMode } from './tokens';

type MobileSource = { role: ColorToken } | { value: ModeValue };
const role = (r: ColorToken): MobileSource => ({ role: r });
const value = (v: ModeValue): MobileSource => ({ value: v });
const both = (v: string): ModeValue => ({ light: v, dark: v });

/**
 * Mobile palette keys (apps/client/src/theme/palette.ts) → a shared role, or a native-only value
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
