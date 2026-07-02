/**
 * Theme system — light / dark / system mode switching.
 *
 * All design tokens (`--t-*`, `--primary-*`) are defined in CSS: `app.css`
 * holds the upstream defaults (`:root` = light, `.dark-theme` = dark) and
 * `branding.css` is the downstream-fork override layer (S6 seam). JS only
 * toggles the `.dark-theme` class — it never writes token values, so fork
 * CSS overrides always win the cascade.
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

const STORAGE_KEY = 'greenhouse-theme';

/** Stored keys from the removed multi-theme palette (pre-2026-07). */
const LEGACY_DARK_KEYS = new Set(['midnight', 'deep-ocean', 'amoled']);

/**
 * Map a raw stored value to a ThemeMode. Legacy palette keys collapse to
 * light/dark by their `dark` flag; absent/unknown values default to `system`.
 */
export function normalizeThemeMode(stored: string | null): ThemeMode {
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  if (stored) return LEGACY_DARK_KEYS.has(stored) ? 'dark' : 'light';
  return 'system';
}

/** Get the persisted theme mode (migrating legacy palette keys). */
export function getThemeMode(): ThemeMode {
  return normalizeThemeMode(localStorage.getItem(STORAGE_KEY));
}

function systemPrefersDark(): MediaQueryList {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

function resolveDark(mode: ThemeMode): boolean {
  return mode === 'dark' || (mode === 'system' && systemPrefersDark().matches);
}

function applyResolved(dark: boolean): void {
  document.documentElement.classList.toggle('dark-theme', dark);
  syncThemeColorMeta(dark);
}

/**
 * Keep `<meta name="theme-color">` in sync with the active tokens so the PWA /
 * mobile chrome follows the brand color (including fork `branding.css` overrides).
 */
function syncThemeColorMeta(dark: boolean): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const styles = getComputedStyle(document.documentElement);
  const color = dark
    ? styles.getPropertyValue('--t-surface').trim()
    : `rgb(${styles.getPropertyValue('--primary-600').trim()})`;
  if (color) meta.setAttribute('content', color);
}

/** Set + persist the theme mode. */
export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
  applyResolved(resolveDark(mode));
}

/**
 * Initialize theme from stored preference on app load.
 *
 * `defaultMode` applies only when the user has never chosen a mode (nothing
 * stored): the web app keeps 'system'; the browser extension passes 'light'.
 */
export function initTheme(defaultMode: ThemeMode = 'system'): void {
  const mode = localStorage.getItem(STORAGE_KEY) === null ? defaultMode : getThemeMode();
  // Persist the migrated (or defaulted) value so it is rewritten once.
  if (localStorage.getItem(STORAGE_KEY) !== mode) localStorage.setItem(STORAGE_KEY, mode);
  applyResolved(resolveDark(mode));

  // Follow OS appearance changes while in system mode.
  systemPrefersDark().addEventListener('change', (e) => {
    if (getThemeMode() === 'system') applyResolved(e.matches);
  });

  // Remove theme-loading class after first paint to enable smooth transitions
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('theme-loading');
    });
  });
}
