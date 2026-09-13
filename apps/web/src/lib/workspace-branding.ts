/**
 * Workspace branding — runtime personalization from GET /api/bootstrap.
 *
 * Fetched ONCE before the app renders (app.tsx awaits initWorkspaceBranding):
 * product name, logo (data URL) and theme tokens saved in Settings →
 * Administration → Branding Studio. DB-configured values win; the build-time
 * PRODUCT_NAME / bundled mark remain the fallback when nothing is configured.
 *
 * Theme tokens are applied through the theme system (lib/theme.ts): applyTheme
 * sets the base --primary-* / --t-* variables inline on <html> for the resolved
 * mode and then asks this module for the workspace overrides of that mode, so
 * a saved brand colour or surface override survives every light/dark switch.
 * Font stacks and the type/radius scales are mode-independent and are set
 * inline the same way.
 */

import { sanitizeThemeTokens, type ThemeTokens, type WorkspaceBootstrap } from '@greenhouse/types';
import { PALETTE_SHADES, generatePalette, rgbToTriplet } from './color';
import { getApiBaseUrl } from './api-base';
import { applyTheme, getActiveTheme, setThemeOverrideProvider } from './theme';
import { PRODUCT_NAME } from '../components/ui';

// ─── Tailwind v4 scale bases (shared with the Branding Studio) ──

/** Tailwind v4 default text sizes (rem) — scaled by the font-size slider.
 *  Line heights are unitless ratios, so they follow automatically. */
export const TEXT_SIZE_DEFAULTS: Record<string, number> = {
  '--text-xs': 0.75,
  '--text-sm': 0.875,
  '--text-base': 1,
  '--text-lg': 1.125,
  '--text-xl': 1.25,
};

/** Tailwind v4 default radii (rem) — scaled by the roundness slider. */
export const RADIUS_DEFAULTS: Record<string, number> = {
  '--radius-xs': 0.125,
  '--radius-sm': 0.25,
  '--radius-md': 0.375,
  '--radius-lg': 0.5,
  '--radius-xl': 0.75,
  '--radius-2xl': 1,
  '--radius-3xl': 1.5,
  '--radius-4xl': 2,
};

export const scaledRem = (base: number, scale: number) => `${+(base * scale).toFixed(4)}rem`;

/**
 * ThemeTokens → the inline CSS variables for one resolved mode. Single
 * generator for the runtime application and the Studio's live preview — what
 * you preview is what gets applied after save.
 */
export function themeTokensToVariables(tokens: ThemeTokens, mode: 'light' | 'dark'): Record<string, string> {
  const vars: Record<string, string> = {};
  if (tokens.brand) {
    const palette = generatePalette(tokens.brand);
    if (palette) {
      for (const shade of PALETTE_SHADES) vars[`--primary-${shade}`] = rgbToTriplet(palette[shade]);
    }
  }
  if (tokens.fontSans?.trim()) vars['--font-sans'] = tokens.fontSans.trim();
  if (tokens.fontMono?.trim()) vars['--font-mono'] = tokens.fontMono.trim();
  if (tokens.fontScale && tokens.fontScale !== 1) {
    for (const [variable, base] of Object.entries(TEXT_SIZE_DEFAULTS)) {
      vars[variable] = scaledRem(base, tokens.fontScale);
    }
  }
  if (tokens.radiusScale !== undefined && tokens.radiusScale !== 1) {
    for (const [variable, base] of Object.entries(RADIUS_DEFAULTS)) {
      vars[variable] = scaledRem(base, tokens.radiusScale);
    }
  }
  for (const [variable, value] of Object.entries((mode === 'dark' ? tokens.dark : tokens.light) ?? {})) {
    vars[variable] = value;
  }
  return vars;
}

// ─── Runtime snapshot ────────────────────────────────────

interface WorkspaceBrandingSnapshot {
  productName: string | null;
  logo: string | null;
  themeTokens: ThemeTokens | null;
}

let snapshot: WorkspaceBrandingSnapshot = { productName: null, logo: null, themeTokens: null };

function applySnapshot(): void {
  document.title = getRuntimeProductName();
  // Re-run the theme so the override provider below is consulted again.
  applyTheme(getActiveTheme());
}

// The theme system asks for the overrides of the mode it just applied.
// Sanitize on render too — a tampered payload must not reach the DOM.
setThemeOverrideProvider((mode) => {
  const tokens = snapshot.themeTokens ? sanitizeThemeTokens(snapshot.themeTokens) : null;
  return tokens ? themeTokensToVariables(tokens, mode) : null;
});

/**
 * Fetch /api/bootstrap and apply title + theme. Resolves quickly on failure
 * (offline API, first boot) — the app then renders with build defaults.
 */
export async function initWorkspaceBranding(): Promise<void> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/bootstrap`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return;
    const data = (await res.json()) as WorkspaceBootstrap;
    snapshot = { productName: data.product_name, logo: data.logo, themeTokens: data.theme_tokens };
    applySnapshot();
  } catch {
    // fail open — defaults already in place
  }
}

/** After a successful Studio save: update the snapshot + re-apply, so the
 *  persisted state is live without a reload. */
export function updateWorkspaceBrandingLocal(partial: Partial<WorkspaceBrandingSnapshot>): void {
  snapshot = { ...snapshot, ...partial };
  applySnapshot();
}

export function getWorkspaceBranding(): Readonly<WorkspaceBrandingSnapshot> {
  return snapshot;
}

/** Workspace-configured product name, falling back to the build-time name. */
export function getRuntimeProductName(): string {
  return snapshot.productName || PRODUCT_NAME;
}

/** Workspace logo data URL, or null to use the built-in mark. */
export function getRuntimeLogo(): string | null {
  return snapshot.logo;
}
