import { nativeStatus } from './status.generated';

/** Native string palette; React-free so contrast is checked without a native install. */
/** Haven forest green in light mode and pale sage in dark mode. */
const BRAND_LIGHT = '#235D4D';
const BRAND_DARK = '#B1D2BF';

export const lightHex = {
  // ── Brand ──
  accent: BRAND_LIGHT,
  /** Text/icons on a filled accent surface. */
  onAccent: '#FFFFFF',
  /** Tinted fill behind accent content (selected rows, AI avatar, chips). */
  accentFill: '#B4CDBD',
  /** Accent-colored text that must stay readable on `accentFill`. */
  accentText: '#235D4D',
  /**
   * Glyphs / text on a filled *non-accent* color (a system-color icon tile, a
   * gray avatar, a project's color) — white in both schemes, like the icons
   * in iOS Settings. On the accent itself use `onAccent`.
   */
  onTint: '#FFFFFF',

  // ── Backgrounds (plain + grouped) ──
  background: '#F2F4F3',
  secondaryBackground: '#E8EDE9',
  tertiaryBackground: '#FFFFFF',
  groupedBackground: '#E8EDE9',
  secondaryGroupedBackground: '#FFFFFF',
  tertiaryGroupedBackground: '#F2F2F7',

  // ── Text ──
  label: '#000000',
  secondaryLabel: '#424944',
  tertiaryLabel: '#4D534F',
  quaternaryLabel: 'rgba(60,60,67,0.18)',
  placeholder: '#4D534F',
  link: BRAND_LIGHT,

  // ── Separators / fills ──
  separator: '#BFC8C1',
  opaqueSeparator: '#BFC8C1',
  fill: 'rgba(120,120,128,0.2)',
  secondaryFill: 'rgba(120,120,128,0.16)',
  tertiaryFill: 'rgba(118,118,128,0.12)',
  quaternaryFill: 'rgba(116,116,128,0.08)',

  // ── Haven status roles, with native data colors ──
  ...nativeStatus.light,
  yellow: '#FFCC00',
  indigo: '#5856D6',
  purple: '#AF52DE',
  gray: '#8E8E93',

  // ── Chat ──
  /** The user's message bubble. */
  bubble: '#FFFFFF',

  // ── Code blocks (always dark, both schemes) ──
  codeBg: '#1C1C1E',
  codeHeader: '#2C2C2E',
  codeText: '#E5E5EA',
  codeComment: '#8E8E93',
  codeLabel: '#AEAEB2',
  /** Syntax colors on the always-dark code card (Xcode's default dark theme). */
  codeKeyword: '#FC5FA3',
  codeString: '#FC6A5D',
  codeNumber: '#D0BF69',

  /** Dimming layer under the drawer / custom overlays. */
  scrim: 'rgba(0,0,0,0.22)',
};

export type HexPalette = typeof lightHex;

export const darkHex: HexPalette = {
  accent: BRAND_DARK,
  onAccent: '#123427',
  accentFill: 'rgba(177,210,191,0.16)',
  accentText: '#D7EFDD',
  onTint: '#FFFFFF',

  background: '#000000',
  secondaryBackground: '#1C1C1E',
  tertiaryBackground: '#2C2C2E',
  groupedBackground: '#000000',
  secondaryGroupedBackground: '#1C1C1E',
  tertiaryGroupedBackground: '#2C2C2E',

  label: '#FFFFFF',
  secondaryLabel: 'rgba(235,235,245,0.6)',
  tertiaryLabel: '#97979E',
  quaternaryLabel: 'rgba(235,235,245,0.16)',
  placeholder: '#97979E',
  link: BRAND_DARK,

  separator: 'rgba(84,84,88,0.6)',
  opaqueSeparator: '#38383A',
  fill: 'rgba(120,120,128,0.36)',
  secondaryFill: 'rgba(120,120,128,0.32)',
  tertiaryFill: 'rgba(118,118,128,0.24)',
  quaternaryFill: 'rgba(118,118,128,0.18)',

  yellow: '#FFD60A',
  ...nativeStatus.dark,
  indigo: '#5E5CE6',
  purple: '#BF5AF2',
  gray: '#8E8E93',

  bubble: '#1C1C1E',

  codeBg: '#1C1C1E',
  codeHeader: '#2C2C2E',
  codeText: '#E5E5EA',
  codeComment: '#8E8E93',
  codeLabel: '#AEAEB2',
  codeKeyword: '#FC5FA3',
  codeString: '#FC6A5D',
  codeNumber: '#D0BF69',

  scrim: 'rgba(0,0,0,0.45)',
};
