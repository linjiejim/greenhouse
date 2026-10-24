/**
 * Greenhouse V1 colors for RN content, as strings (React-free, so ./palette.test.ts checks
 * contrast without a native install). The brand comes from the web app's tokens
 * (apps/web/src/app.css: `--primary-500` #2E8B3D and its scale, the `--t-*` surfaces and status
 * roles); native controls keep system styling and take the accent as their tint.
 *
 * Light: the web's green-tinted surfaces. Dark: content surfaces mirror UIKit's system
 * backgrounds (#000 / #1C1C1E) so RN content and native Hosts never mix traits; the accent is
 * the web's dark-mode green.
 */

/** V1 green (`--primary-500`) in light mode; the web's dark-mode green in dark mode. */
const BRAND_LIGHT = '#2E8B3D';
const BRAND_DARK = '#76C97D';

export const lightHex = {
  // ── Brand ──
  accent: BRAND_LIGHT,
  /** Text/icons on a filled accent surface. */
  onAccent: '#FFFFFF',
  /** Tinted fill behind accent content (selected rows, chips) — `--t-primary-subtle`. */
  accentFill: '#E1EDD6',
  /** Accent-colored text that must stay readable on `accentFill` — `--primary-700`. */
  accentText: '#1F6B34',
  /**
   * Glyphs / text on a filled *non-accent* color (a system-color icon tile, a
   * gray avatar, a project's color) — white in both schemes, like the icons
   * in iOS Settings. On the accent itself use `onAccent`.
   */
  onTint: '#FFFFFF',

  // ── Backgrounds (plain + grouped) — `--t-surface*` ──
  background: '#F4F8F1',
  secondaryBackground: '#EEF5EA',
  tertiaryBackground: '#FFFFFF',
  groupedBackground: '#F1F7ED',
  secondaryGroupedBackground: '#FFFFFF',
  tertiaryGroupedBackground: '#F4F8F1',

  // ── Text — `--t-fg*` ──
  label: '#2B2B2B',
  secondaryLabel: '#455147',
  tertiaryLabel: '#5F6A61',
  quaternaryLabel: 'rgba(60,60,67,0.18)',
  placeholder: '#5F6A61',
  /** Links on content surfaces — `--primary-600` (the 500 is a fill, not a text color). */
  link: '#277A35',

  // ── Separators / fills ──
  separator: '#BFCDB8',
  opaqueSeparator: '#BFCDB8',
  fill: 'rgba(120,120,128,0.2)',
  secondaryFill: 'rgba(120,120,128,0.16)',
  tertiaryFill: 'rgba(118,118,128,0.12)',
  quaternaryFill: 'rgba(116,116,128,0.08)',

  // ── Status roles (`--t-danger-fg` / `-subtle`, …) ──
  red: '#B03A35',
  redFill: '#FFF0EF',
  orange: '#8F431D',
  orangeFill: '#FFF3EC',
  green: '#1F6B34',
  greenFill: '#EEF5EA',
  blue: '#24566E',
  blueFill: '#EDF7FA',
  /**
   * Solid status tiles behind an onTint (white) glyph — a row's kind icon. The text roles above
   * are pale in dark mode (readable as text on black), so tiles take their own darker fills.
   */
  redTile: '#B03A35',
  orangeTile: '#8F431D',
  greenTile: '#1F6B34',
  blueTile: '#24566E',
  yellow: '#FFCC00',
  indigo: '#5856D6',
  purple: '#AF52DE',
  gray: '#8E8E93',

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

  /** Dimming layer under custom overlays. */
  scrim: 'rgba(0,0,0,0.22)',
};

export type HexPalette = typeof lightHex;

export const darkHex: HexPalette = {
  accent: BRAND_DARK,
  onAccent: '#0F1510',
  accentFill: 'rgba(118,201,125,0.16)',
  accentText: '#A5DDA9',
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

  red: '#F4AAA6',
  redFill: '#3A2221',
  orange: '#F0B98F',
  orangeFill: '#38281C',
  green: '#A5DDA9',
  greenFill: '#1C2E1E',
  blue: '#A1CFE1',
  blueFill: '#1A2B33',
  redTile: '#B3362F',
  orangeTile: '#9C4A1C',
  greenTile: '#2A7A37',
  blueTile: '#2A6582',
  yellow: '#FFD60A',
  indigo: '#5E5CE6',
  purple: '#BF5AF2',
  gray: '#8E8E93',

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
