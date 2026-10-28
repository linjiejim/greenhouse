/**
 * Greenhouse design tokens — the single source for web and mobile.
 *
 * Nothing copies these values by hand. `pnpm tokens:build` (scripts/build-tokens.ts) renders:
 *   - apps/client/src/theme/tokens.generated.ts — the native palette (the client sits outside the
 *     pnpm workspace, so it gets a generated copy, never an import);
 *   - packages/ui-tokens/src/tokens.generated.ts — the `--gh-*` themes plugin frontends load.
 * tokens.test.ts fails when either file is stale.
 *
 * Names are roles, not hues. The brand is Haven: forest green #235D4D (light accent), pale sage
 * #B1D2BF (dark accent) and the seed lime #B6CA68, which is an accent only and never a text colour.
 * Dark mode is deep ink-green layers (#0F1510 / #1A231B / #202A21) that show elevation by
 * surface, not by shadow.
 */

export type ThemeMode = 'light' | 'dark';
export interface ModeValue {
  light: string;
  dark: string;
}

/** The fixed brand colours (logos/README.md). A workspace brand colour never changes these. */
export const brand = {
  forest: '#235D4D',
  sage: '#B1D2BF',
  seed: '#B6CA68',
} as const;

/**
 * The green ramp behind the web's `primary-*` utilities (and Branding Studio, which regenerates
 * it from a workspace brand colour). 600 is the light accent, 300 the dark accent.
 */
export const primaryRamp = {
  50: '#F1F6F3',
  100: '#E2EDE7',
  200: '#C8DDD1',
  300: brand.sage,
  400: '#6F9F89',
  500: '#2F6E5C',
  600: brand.forest,
  700: '#1C4D40',
  800: '#163E34',
  900: '#10291F',
} as const;

export type PrimaryShade = keyof typeof primaryRamp;

/** Semantic colours shared by every platform. */
export const color = {
  // Surfaces, back to front.
  canvas: { light: '#FFFFFF', dark: '#0F1510' }, // the reading page: conversations, documents
  sunken: { light: '#F6F8F7', dark: '#131A14' }, // inset tracks, code blocks, table toolbars
  chrome: { light: '#F2F5F3', dark: '#1A231B' }, // sidebar, grouped backgrounds
  deep: { light: '#E8EDE9', dark: '#0A0F0B' }, // the layer under a place (mobile sidebar)
  surface: { light: '#F6F8F7', dark: '#151C16' }, // quiet panels on the canvas
  card: { light: '#F8FAF9', dark: '#1A231B' }, // data cards
  raised: { light: '#FFFFFF', dark: '#202A21' }, // inputs, menus, dialogs, drawers
  fill: { light: '#ECF0ED', dark: '#243026' }, // neutral fills: hover, muted areas, skeletons
  scrim: { light: 'rgba(17, 17, 19, 0.32)', dark: 'rgba(0, 0, 0, 0.6)' },

  // Lines.
  line: { light: '#E1E7E2', dark: '#2C392E' }, // card and section borders
  lineStrong: { light: '#C2CBC5', dark: '#405143' }, // inputs, separators that must read

  // Text and icons.
  text: { light: '#1C1C1E', dark: '#F2F6F0' },
  secondary: { light: '#424944', dark: '#C6D0C3' }, // body and supporting text
  tertiary: { light: '#555C57', dark: '#9DAA9A' }, // labels, meta, placeholders (≥ 4.5:1)
  faint: { light: '#616863', dark: '#8E9C8B' }, // hints (≥ 4.5:1 on the canvas)

  // Brand accent. A workspace brand colour regenerates the web ramp, and these follow it there.
  accent: { light: primaryRamp[600], dark: primaryRamp[300] }, // primary fill, selected indicator
  accentHover: { light: primaryRamp[700], dark: '#C4DECE' },
  accentPressed: { light: primaryRamp[800], dark: '#D2E7DA' },
  accentText: { light: primaryRamp[600], dark: primaryRamp[300] }, // links and accent text
  accentTextStrong: { light: primaryRamp[700], dark: primaryRamp[200] }, // accent text on accentFill
  onAccent: { light: '#FFFFFF', dark: primaryRamp[900] }, // text on an accent fill
  accentFill: { light: '#DAE8E0', dark: 'rgba(177, 210, 191, 0.14)' }, // selected chip / row fill
  accentFillHover: { light: '#CCE0D4', dark: 'rgba(177, 210, 191, 0.22)' },
  accentEdge: { light: primaryRamp[500], dark: 'rgba(177, 210, 191, 0.45)' }, // bounded selected control
  accentWash: { light: primaryRamp[50], dark: 'rgba(177, 210, 191, 0.1)' }, // tint inside prose
  focus: { light: primaryRamp[600], dark: primaryRamp[300] },

  // The Greenhouse mark. Fixed: a workspace brand colour never changes it.
  brandMark: { light: brand.forest, dark: brand.sage },
  brandSeed: { light: brand.seed, dark: brand.seed }, // decorative only, never text

  // Status: a foreground + a soft fill. Never the only signal.
  success: { light: '#1F7A4C', dark: '#6FD39C' },
  successFill: { light: '#E3F3E9', dark: '#1A3326' },
  warning: { light: '#9A5B08', dark: '#FFC46B' },
  warningFill: { light: '#FFF2DE', dark: '#382B1B' },
  danger: { light: '#C23A34', dark: '#FF8A84' },
  dangerHover: { light: '#A8302B', dark: '#FFA19C' },
  dangerFill: { light: '#FCEBE9', dark: '#43231F' },
  // A solid delete button: the fill stays a deep red in dark mode so white words read on it.
  dangerSolid: { light: '#C23A34', dark: '#B8352F' },
  dangerSolidHover: { light: '#A8302B', dark: '#A12E29' },
  onDanger: { light: '#FFFFFF', dark: '#FFFFFF' },
  info: { light: '#2A64AD', dark: '#8CBBF5' },
  infoFill: { light: '#E6EEF9', dark: '#1B2A3D' },
  star: { light: '#9C6100', dark: '#FFCB47' },
  starHover: { light: '#7D4E00', dark: '#FFD873' },
} as const satisfies Record<string, ModeValue>;

export type ColorToken = keyof typeof color;

/**
 * User-chosen colours: project and tag colours, select options, chart series. `fg` is text or an
 * icon on `fill`; dots and bars use `fg`.
 */
export const categorical = {
  gray: { fg: { light: '#5F6168', dark: '#B4B6BC' }, fill: { light: '#EEEEF1', dark: '#26272B' } },
  red: { fg: { light: '#C8302F', dark: '#FF9590' }, fill: { light: '#FDECEB', dark: '#3B1B1B' } },
  orange: { fg: { light: '#AD4600', dark: '#FFA25C' }, fill: { light: '#FEEEDF', dark: '#35210F' } },
  amber: { fg: { light: '#9C6100', dark: '#FFCB47' }, fill: { light: '#FDF3D3', dark: '#33270D' } },
  green: { fg: { light: '#1D7A4F', dark: '#5ED59A' }, fill: { light: '#E4F4EA', dark: '#16301F' } },
  teal: { fg: { light: '#00796A', dark: '#3CD3BA' }, fill: { light: '#DFF4F0', dark: '#0F2E2A' } },
  blue: { fg: { light: '#1F6CC0', dark: '#7DB9FF' }, fill: { light: '#E5F0FC', dark: '#13294A' } },
  purple: { fg: { light: '#7A45AE', dark: '#C9A2F5' }, fill: { light: '#F2EBFB', dark: '#2C1F3D' } },
  pink: { fg: { light: '#B42F7E', dark: '#FF8FCB' }, fill: { light: '#FCEAF4', dark: '#3A1B30' } },
} as const satisfies Record<string, { fg: ModeValue; fill: ModeValue }>;

export type CategoricalColor = keyof typeof categorical;

/** Chart series order: the accent first, then hues far apart from their neighbours. */
export const chartSeries = ['accent', 'blue', 'orange', 'purple', 'teal', 'pink', 'amber', 'red'] as const;

export const font = {
  sans: "Nunito, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace",
} as const;

export interface TypeStyle {
  size: number;
  line: number;
  weight: 400 | 500 | 600 | 700;
}

/** The type scale. Nothing renders below 12px; 16/26 is the reading size (messages, documents). */
export const type = {
  caption: { size: 12, line: 16, weight: 400 }, // timestamps, badges, meta
  label: { size: 13, line: 18, weight: 500 }, // field labels, column headers
  bodySm: { size: 13, line: 20, weight: 400 }, // dense lists and table cells
  body: { size: 14, line: 22, weight: 400 }, // default UI text, navigation rows
  bodyLg: { size: 16, line: 26, weight: 400 }, // reading: messages, documents
  titleSm: { size: 15, line: 22, weight: 600 }, // section and card titles
  title: { size: 18, line: 26, weight: 600 }, // dialog and module titles
  titleLg: { size: 22, line: 30, weight: 600 }, // page titles
  display: { size: 28, line: 36, weight: 700 }, // document titles, the greeting
  code: { size: 13, line: 20, weight: 400 },
} as const satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof type;

/** 4px grid. */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

export const radius = {
  xs: 4, // checkbox
  sm: 6, // badge, tag, inline code
  md: 8, // button, input, menu item, row highlight
  lg: 12, // card, popover, menu, toast, rich block
  xl: 16, // dialog, large card, message bubble
  '2xl': 20, // composer
  sheet: 24, // phone sheet top corners
  full: 9999,
} as const;

/** Two elevation levels. Dark mode shows elevation by surface layer, so dark shadows only separate. */
export const shadow = {
  /** Small raised items inside a surface: the selected segment, a control, a tooltip. */
  control: {
    light: '0 1px 2px rgba(17, 17, 19, 0.06), 0 2px 6px rgba(17, 17, 19, 0.05)',
    dark: '0 0 0 1px rgba(255, 255, 255, 0.04)',
  },
  /** Floating layers: menus, popovers, dialogs, drawers, toasts. */
  floating: {
    light: '0 2px 8px rgba(17, 17, 19, 0.06), 0 12px 32px rgba(17, 17, 19, 0.12)',
    dark: '0 0 0 1px rgba(255, 255, 255, 0.06), 0 12px 32px rgba(0, 0, 0, 0.5)',
  },
} as const satisfies Record<string, ModeValue>;

export const motion = {
  fast: 140, // hover, press, toggle
  base: 200, // menus, popovers, fades, message appear
  slow: 240, // drawer and sheet enter
  exit: 180, // anything leaving
  loop: 1000, // one cycle of a looping indicator
  easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
  easeEnter: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  easeExit: 'cubic-bezier(0.3, 0, 1, 1)',
} as const;

export const zIndex = {
  sticky: 10,
  dropdown: 20,
  scrim: 40,
  modal: 50,
  nested: 60,
  toast: 80,
} as const;

/**
 * Native-only values. In dark mode the page is the ink-green canvas under chrome cells, like the
 * web; iOS keeps its translucent system fills and an always-dark code card; everything else on
 * mobile reads the shared roles above.
 */
export const native = {
  base: { light: color.surface.light, dark: color.canvas.dark }, // plain page background
  elevated: { light: '#FFFFFF', dark: color.fill.dark }, // tertiary backgrounds
  separator: { light: color.lineStrong.light, dark: 'rgba(84, 84, 88, 0.6)' },
  opaqueSeparator: { light: color.lineStrong.light, dark: '#38383A' },
  quaternaryLabel: { light: 'rgba(60, 60, 67, 0.18)', dark: 'rgba(235, 235, 245, 0.16)' },
  fill: { light: 'rgba(120, 120, 128, 0.2)', dark: 'rgba(120, 120, 128, 0.36)' },
  secondaryFill: { light: 'rgba(120, 120, 128, 0.16)', dark: 'rgba(120, 120, 128, 0.32)' },
  tertiaryFill: { light: 'rgba(118, 118, 128, 0.12)', dark: 'rgba(118, 118, 128, 0.24)' },
  quaternaryFill: { light: 'rgba(116, 116, 128, 0.08)', dark: 'rgba(118, 118, 128, 0.18)' },
  sidebarSelection: { light: 'rgba(35, 93, 77, 0.12)', dark: 'rgba(177, 210, 191, 0.16)' },
  yellow: { light: '#FFCC00', dark: '#FFD60A' }, // sparkles: decorative
  scrim: { light: 'rgba(0, 0, 0, 0.22)', dark: 'rgba(0, 0, 0, 0.45)' },
  code: {
    bg: '#1C1C1E',
    header: '#2C2C2E',
    text: '#E5E5EA',
    comment: '#8E8E93',
    label: '#AEAEB2',
    keyword: '#FC5FA3',
    string: '#FC6A5D',
    number: '#D0BF69',
  },
} as const;
