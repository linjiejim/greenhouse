/**
 * Workspace branding — runtime personalization from GET /api/bootstrap.
 *
 * Fetched ONCE before the app renders (app.tsx awaits initWorkspaceBranding):
 * tenant product name, logo (data URL), theme tokens and the team Sprouty.
 * DB-configured values win; the compile-time BRANDING seam
 * (lib/branding.extensions.tsx) and branding.css remain the fork-level
 * fallback when nothing is configured in Settings → Branding Studio.
 *
 * Theme tokens are applied by injecting a <style data-workspace-branding>
 * block generated from the saved ThemeTokens — the same shape the Studio
 * saves/export uses (themeTokensToCss). The block is appended to <head>, so
 * it wins the cascade over bundled CSS (branding.css) but stays below the
 * Studio's inline-style live preview.
 */

import { sanitizeThemeTokens, type ThemeTokens, type WorkspaceBootstrap } from '@greenhouse/types';
import type { AvatarConfig } from '@greenhouse/types';
import { PALETTE_SHADES, generatePalette, rgbToTriplet } from './color';
import { BRANDING } from './branding.extensions';
import { getApiBaseUrl } from './api-base';

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
 * ThemeTokens → CSS override block (`:root { … }` + `.dark-theme { … }`).
 * Single generator for the runtime <style> injection, the Studio's export
 * box and the persisted payload — what you preview is what gets saved.
 */
export function themeTokensToCss(tokens: ThemeTokens): string {
  const rootLines: string[] = [];
  if (tokens.brand) {
    const palette = generatePalette(tokens.brand);
    if (palette) {
      for (const shade of PALETTE_SHADES) rootLines.push(`  --primary-${shade}: ${rgbToTriplet(palette[shade])};`);
    }
  }
  if (tokens.fontSans?.trim()) rootLines.push(`  --font-sans: ${tokens.fontSans.trim()};`);
  if (tokens.fontMono?.trim()) rootLines.push(`  --font-mono: ${tokens.fontMono.trim()};`);
  if (tokens.fontScale && tokens.fontScale !== 1) {
    for (const [variable, base] of Object.entries(TEXT_SIZE_DEFAULTS)) {
      rootLines.push(`  ${variable}: ${scaledRem(base, tokens.fontScale)};`);
    }
  }
  if (tokens.radiusScale !== undefined && tokens.radiusScale !== 1) {
    for (const [variable, base] of Object.entries(RADIUS_DEFAULTS)) {
      rootLines.push(`  ${variable}: ${scaledRem(base, tokens.radiusScale)};`);
    }
  }
  for (const [variable, value] of Object.entries(tokens.light ?? {})) rootLines.push(`  ${variable}: ${value};`);
  const darkLines = Object.entries(tokens.dark ?? {}).map(([variable, value]) => `  ${variable}: ${value};`);

  const blocks: string[] = [];
  if (rootLines.length) blocks.push(`:root {\n${rootLines.join('\n')}\n}`);
  if (darkLines.length) blocks.push(`.dark-theme {\n${darkLines.join('\n')}\n}`);
  return blocks.join('\n\n');
}

// ─── Runtime snapshot ────────────────────────────────────

interface WorkspaceBrandingSnapshot {
  productName: string | null;
  logo: string | null;
  themeTokens: ThemeTokens | null;
  teamAvatar: AvatarConfig | null;
}

let snapshot: WorkspaceBrandingSnapshot = {
  productName: null,
  logo: null,
  themeTokens: null,
  teamAvatar: null,
};

const STYLE_ATTR = 'data-workspace-branding';

function applySnapshot(): void {
  document.title = getRuntimeProductName();

  document.querySelector(`style[${STYLE_ATTR}]`)?.remove();
  // Defense-in-depth: sanitize again on render — a tampered payload must not
  // be able to escape the declaration block.
  const tokens = snapshot.themeTokens ? sanitizeThemeTokens(snapshot.themeTokens) : null;
  if (tokens) {
    const css = themeTokensToCss(tokens);
    if (css) {
      const el = document.createElement('style');
      el.setAttribute(STYLE_ATTR, '');
      el.textContent = css;
      document.head.appendChild(el);
    }
  }
}

/**
 * Fetch /api/bootstrap and apply title + theme. Resolves quickly on failure
 * (offline API, first boot) — the app then renders with fork/build defaults.
 */
export async function initWorkspaceBranding(): Promise<void> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/bootstrap`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return;
    const data = (await res.json()) as WorkspaceBootstrap;
    snapshot = {
      productName: data.product_name,
      logo: data.logo,
      themeTokens: data.theme_tokens,
      teamAvatar: (data.team_avatar as AvatarConfig | null) ?? null,
    };
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

/** Workspace-configured product name, falling back to the fork/build seam. */
export function getRuntimeProductName(): string {
  return snapshot.productName || BRANDING.productName;
}

/** Workspace logo data URL, or null to use the built-in mark. */
export function getRuntimeLogo(): string | null {
  return snapshot.logo;
}

/** Workspace default Sprouty (built-in profiles without their own avatar). */
export function getWorkspaceTeamAvatar(): AvatarConfig | null {
  return snapshot.teamAvatar;
}
