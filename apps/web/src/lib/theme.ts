/**
 * Greenhouse brand theme system.
 *
 * The product has one visual identity and two resolved appearance modes. Users
 * can pin either mode or follow the operating-system preference. Switching is
 * instant (no cross-fade): applyTheme toggles `.dark-theme` and re-applies only
 * the workspace's Branding Studio overrides.
 */

export type ThemeKey = 'system' | 'light' | 'dark';
export type ResolvedThemeKey = Exclude<ThemeKey, 'system'>;

export interface ThemeDef {
  key: ResolvedThemeKey;
  dark: boolean;
}

/**
 * The two resolved appearances. Their token values live in one place —
 * packages/ui/src/tokens/tokens.ts, rendered to tokens.css (`pnpm tokens:build`) — and are
 * switched by the `.dark-theme` class; nothing here writes a token value inline.
 */
export const THEMES: ThemeDef[] = [
  { key: 'light', dark: false },
  { key: 'dark', dark: true },
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

  // Workspace overrides (Branding Studio) for the resolved mode — the only inline
  // variables the app writes. Variables from the previous mode are dropped first.
  for (const name of appliedOverrideVars) root.style.removeProperty(name);
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
}
