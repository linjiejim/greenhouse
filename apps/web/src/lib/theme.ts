/**
 * Greenhouse brand theme system.
 *
 * The product has one visual identity and two resolved appearance modes. Users
 * can pin either mode or follow the operating-system preference. Both resolved
 * modes keep the same Greenhouse green palette; only surfaces, text, borders, and
 * status colors change.
 */

export type ThemeKey = 'system' | 'light' | 'dark';
export type ResolvedThemeKey = Exclude<ThemeKey, 'system'>;

interface ThemeSurface {
  canvas: string;
  chrome: string;
  surface: string;
  surfaceCard: string;
  surfaceRaised: string;
  surfaceMuted: string;
  surfaceSunken: string;
  fg: string;
  fgSecondary: string;
  fgMuted: string;
  fgFaint: string;
  edge: string;
  edgeStrong: string;
  success: string;
  successSubtle: string;
  successFg: string;
  warning: string;
  warningSubtle: string;
  warningFg: string;
  danger: string;
  dangerSubtle: string;
  dangerFg: string;
  destructive: string;
  destructiveHover: string;
  star: string;
  starHover: string;
  info: string;
  infoSubtle: string;
  infoFg: string;
}

export interface ThemeDef {
  key: ResolvedThemeKey;
  dark: boolean;
  primary: Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>;
  surface: ThemeSurface;
}

const BRAND_PRIMARY: ThemeDef['primary'] = {
  50: '244 248 241', // wash #F4F8F1
  100: '238 245 234', // wash2 #EEF5EA
  200: '221 235 213',
  300: '199 217 216', // sage #C7D9D8
  400: '140 198 63', // lime #8CC63F
  500: '46 139 61', // green #2E8B3D
  600: '39 122 53', // accessible brand action green
  700: '31 107 52', // green-d #1F6B34
  800: '24 85 42',
  900: '18 63 32',
};

export const THEMES: ThemeDef[] = [
  {
    key: 'light',
    dark: false,
    primary: BRAND_PRIMARY,
    surface: {
      canvas: '#FFFFFF',
      chrome: '#F1F7ED',
      surface: '#F4F8F1',
      surfaceCard: '#F7FAF5',
      surfaceRaised: '#FFFFFF',
      surfaceMuted: '#EEF5EA',
      surfaceSunken: '#F7F9F5',
      fg: '#2B2B2B',
      fgSecondary: '#455147',
      fgMuted: '#5F6A61',
      fgFaint: '#657067',
      edge: '#E6ECE3',
      edgeStrong: '#CBD6C8',
      success: '#2E8B3D',
      successSubtle: '#EEF5EA',
      successFg: '#1F6B34',
      warning: '#A84D21',
      warningSubtle: '#FFF3EC',
      warningFg: '#7A3517',
      danger: '#C2413B',
      dangerSubtle: '#FFF0EF',
      dangerFg: '#8F2F2B',
      destructive: '#C2413B',
      destructiveHover: '#A93631',
      star: '#B7791F',
      starHover: '#925F18',
      info: '#2D6E8E',
      infoSubtle: '#EDF7FA',
      infoFg: '#24566E',
    },
  },
  {
    key: 'dark',
    dark: true,
    primary: BRAND_PRIMARY,
    surface: {
      canvas: '#0F1510',
      chrome: '#1A231B',
      surface: '#151C16',
      surfaceCard: '#1A231B',
      surfaceRaised: '#1A231B',
      surfaceMuted: '#243026',
      surfaceSunken: '#0F1510',
      fg: '#F2F6F0',
      fgSecondary: '#C6D0C3',
      fgMuted: '#95A292',
      fgFaint: '#82917F',
      edge: '#2C392E',
      edgeStrong: '#405143',
      success: '#76C97D',
      successSubtle: 'rgba(76, 175, 80, 0.14)',
      successFg: '#A5DDA9',
      warning: '#E7A16B',
      warningSubtle: 'rgba(217, 102, 43, 0.15)',
      warningFg: '#F0B98F',
      danger: '#EE837D',
      dangerSubtle: 'rgba(224, 80, 73, 0.14)',
      dangerFg: '#F4AAA6',
      destructive: '#D75650',
      destructiveHover: '#E16C66',
      star: '#E6B45D',
      starHover: '#F0C472',
      info: '#72B4CF',
      infoSubtle: 'rgba(70, 145, 176, 0.15)',
      infoFg: '#A1CFE1',
    },
  },
];

const STORAGE_KEY = 'greenhouse-theme';

/**
 * Workspace branding hook: after the base variables of a mode are applied,
 * the provider returns per-mode overrides (brand palette, surface tokens, font
 * and scale variables) saved in the Branding Studio. Registered by
 * lib/workspace-branding.ts; absent = no overrides.
 */
type ThemeOverrideProvider = (mode: ResolvedThemeKey) => Record<string, string> | null;
let themeOverrideProvider: ThemeOverrideProvider | null = null;
/** Variables the previous applyTheme() wrote from overrides — cleared before re-applying. */
let appliedOverrideVars: string[] = [];

export function setThemeOverrideProvider(provider: ThemeOverrideProvider | null): void {
  themeOverrideProvider = provider;
}
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';
const DARK_LEGACY_KEYS = new Set(['midnight', 'deep-ocean', 'amoled']);
const LIGHT_LEGACY_KEYS = new Set(['teal', 'forest', 'ocean', 'blossom', 'harvest', 'rose']);
let systemThemeListenerInstalled = false;

/** Collapse every historical theme preference into the canonical three-way preference. */
export function normalizeThemeKey(themeKey: string | null | undefined): ThemeKey {
  if (themeKey === 'system' || themeKey === 'light') return themeKey;
  if (themeKey === 'dark' || DARK_LEGACY_KEYS.has(themeKey ?? '')) return 'dark';
  if (LIGHT_LEGACY_KEYS.has(themeKey ?? '')) return 'light';
  return 'system';
}

export function resolveThemeKey(themeKey: ThemeKey, prefersDark = systemPrefersDark()): ResolvedThemeKey {
  if (themeKey === 'system') return prefersDark ? 'dark' : 'light';
  return themeKey;
}

export function getThemeDefinition(themeKey: ThemeKey, prefersDark = systemPrefersDark()): ThemeDef {
  const resolvedKey = resolveThemeKey(themeKey, prefersDark);
  return THEMES.find((item) => item.key === resolvedKey) ?? THEMES[0];
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(SYSTEM_THEME_QUERY).matches
    : false;
}

/** Apply a canonical appearance preference and persist it. */
export function applyTheme(themeKey: string): void {
  const normalizedKey = normalizeThemeKey(themeKey);
  const theme = getThemeDefinition(normalizedKey);
  const root = document.documentElement;

  for (const [shade, value] of Object.entries(theme.primary)) {
    root.style.setProperty(`--primary-${shade}`, value);
  }

  const surfaceVariables: Record<string, string> = {
    '--t-surface-canvas': theme.surface.canvas,
    '--t-surface-chrome': theme.surface.chrome,
    '--t-surface': theme.surface.surface,
    '--t-surface-card': theme.surface.surfaceCard,
    '--t-surface-raised': theme.surface.surfaceRaised,
    '--t-surface-muted': theme.surface.surfaceMuted,
    '--t-surface-sunken': theme.surface.surfaceSunken,
    '--t-fg': theme.surface.fg,
    '--t-fg-secondary': theme.surface.fgSecondary,
    '--t-fg-muted': theme.surface.fgMuted,
    '--t-fg-faint': theme.surface.fgFaint,
    '--t-edge': theme.surface.edge,
    '--t-edge-strong': theme.surface.edgeStrong,
    '--t-success': theme.surface.success,
    '--t-success-subtle': theme.surface.successSubtle,
    '--t-success-fg': theme.surface.successFg,
    '--t-warning': theme.surface.warning,
    '--t-warning-subtle': theme.surface.warningSubtle,
    '--t-warning-fg': theme.surface.warningFg,
    '--t-danger': theme.surface.danger,
    '--t-danger-subtle': theme.surface.dangerSubtle,
    '--t-danger-fg': theme.surface.dangerFg,
    '--t-destructive': theme.surface.destructive,
    '--t-destructive-hover': theme.surface.destructiveHover,
    '--t-star': theme.surface.star,
    '--t-star-hover': theme.surface.starHover,
    '--t-info': theme.surface.info,
    '--t-info-subtle': theme.surface.infoSubtle,
    '--t-info-fg': theme.surface.infoFg,
  };
  for (const [name, value] of Object.entries(surfaceVariables)) {
    root.style.setProperty(name, value);
  }

  // Workspace overrides (Branding Studio) win over the built-in palette for
  // the resolved mode; variables from a previous mode are dropped first.
  for (const name of appliedOverrideVars) {
    if (!(name in surfaceVariables) && !name.startsWith('--primary-')) root.style.removeProperty(name);
  }
  appliedOverrideVars = [];
  const overrides = themeOverrideProvider?.(theme.key);
  if (overrides) {
    for (const [name, value] of Object.entries(overrides)) {
      root.style.setProperty(name, value);
      appliedOverrideVars.push(name);
    }
  }

  root.classList.toggle('dark-theme', theme.dark);
  root.dataset.theme = theme.key;
  root.dataset.themePreference = normalizedKey;
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  localStorage.setItem(STORAGE_KEY, normalizedKey);
}

/** Get the active preference, migrating any old multi-theme preference in memory. */
export function getActiveTheme(): ThemeKey {
  return normalizeThemeKey(localStorage.getItem(STORAGE_KEY));
}

/** Initialize the stored theme before the app renders. */
export function initTheme(): void {
  applyTheme(getActiveTheme());
  if (!systemThemeListenerInstalled && typeof window.matchMedia === 'function') {
    const mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY);
    mediaQuery.addEventListener('change', () => {
      if (getActiveTheme() === 'system') applyTheme('system');
    });
    systemThemeListenerInstalled = true;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('theme-loading');
    });
  });
}
