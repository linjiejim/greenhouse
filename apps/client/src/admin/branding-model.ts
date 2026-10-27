/**
 * Branding rules (React-free, tested): the stored `branding.theme_tokens` (packages/types
 * ThemeTokens) edited as brand color, font stacks and type / shape scales. Per-mode variable
 * overrides saved by the classic studio are kept as they are. Ranges follow sanitizeThemeTokens.
 */

export interface ThemeTokens {
  brand?: string;
  fontSans?: string;
  fontMono?: string;
  fontScale?: number;
  radiusScale?: number;
  light?: Record<string, string>;
  dark?: Record<string, string>;
}

export interface BrandDraft {
  brand: string;
  fontSans: string;
  fontMono: string;
  fontScale: number;
  radiusScale: number;
}

export const DEFAULT_BRAND = '#235D4D'; // data color: the Haven accent, the stored default
export const FONT_PRESETS = [
  { id: 'default', stack: '' },
  { id: 'inter', stack: "'Inter', ui-sans-serif, system-ui, sans-serif" },
  { id: 'humanist', stack: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', sans-serif" },
  { id: 'serif', stack: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif" },
] as const;

/** One-click starting points: a whole feel (color, font, shape). Swatches are data colors. */
export const STYLE_PRESETS = [
  { id: 'greenhouse', brand: '#235D4D', font: 'default', fontScale: 1, radiusScale: 1 }, // data color
  { id: 'slate', brand: '#4F46E5', font: 'inter', fontScale: 1, radiusScale: 0.5 }, // data color
  { id: 'sunset', brand: '#EA580C', font: 'humanist', fontScale: 1, radiusScale: 1.75 }, // data color
  { id: 'editorial', brand: '#9F1239', font: 'serif', fontScale: 1.05, radiusScale: 0.75 }, // data color
  { id: 'graphite', brand: '#334155', font: 'default', fontScale: 0.95, radiusScale: 0 }, // data color
] as const;
export type PresetId = (typeof STYLE_PRESETS)[number]['id'];

const HEX = /^#?([0-9a-fA-F]{6})$/;
/** `235d4d` / `#235D4D` → `#235D4D`, or null. */
export function normalizeHex(value: string): string | null {
  const match = HEX.exec(value.trim());
  return match ? `#${match[1]!.toUpperCase()}` : null;
}

export function draftOf(tokens: ThemeTokens | null | undefined): BrandDraft {
  return {
    brand: normalizeHex(tokens?.brand ?? '') ?? DEFAULT_BRAND,
    fontSans: tokens?.fontSans ?? '',
    fontMono: tokens?.fontMono ?? '',
    fontScale: tokens?.fontScale ?? 1,
    radiusScale: tokens?.radiusScale ?? 1,
  };
}

export function presetDraft(id: PresetId): BrandDraft {
  const preset = STYLE_PRESETS.find((p) => p.id === id)!;
  return {
    brand: preset.brand,
    fontSans: FONT_PRESETS.find((f) => f.id === preset.font)!.stack,
    fontMono: '',
    fontScale: preset.fontScale,
    radiusScale: preset.radiusScale,
  };
}

/** The preset this draft is, if any (for the selected chip). */
export function activePreset(draft: BrandDraft): PresetId | null {
  return STYLE_PRESETS.find((p) => JSON.stringify(presetDraft(p.id)) === JSON.stringify(draft))?.id ?? null;
}

/**
 * The tokens to store: only what differs from the defaults, the saved per-mode overrides kept;
 * null when nothing remains (the workspace falls back to the built-in theme).
 */
export function tokensOf(draft: BrandDraft, saved: ThemeTokens | null | undefined): ThemeTokens | null {
  const tokens: ThemeTokens = {};
  const brand = normalizeHex(draft.brand);
  // an untouched default stays unset (exports pick their own default); a stored brand stays stored
  if (brand && (brand !== DEFAULT_BRAND || saved?.brand)) tokens.brand = brand;
  if (draft.fontSans.trim()) tokens.fontSans = draft.fontSans.trim();
  if (draft.fontMono.trim()) tokens.fontMono = draft.fontMono.trim();
  const fontScale = Math.min(1.2, Math.max(0.8, draft.fontScale));
  const radiusScale = Math.min(2, Math.max(0, draft.radiusScale));
  if (fontScale !== 1) tokens.fontScale = fontScale;
  if (radiusScale !== 1) tokens.radiusScale = radiusScale;
  if (saved?.light && Object.keys(saved.light).length) tokens.light = saved.light;
  if (saved?.dark && Object.keys(saved.dark).length) tokens.dark = saved.dark;
  return Object.keys(tokens).length ? tokens : null;
}

/** Text on a solid brand fill: dark on light colors, white on dark ones (WCAG relative luminance). */
export function onBrand(hex: string): 'light' | 'dark' {
  const value = normalizeHex(hex) ?? DEFAULT_BRAND;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(value.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? 'dark' : 'light';
}

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 256 * 1024;

/** Why a picked logo file is refused, or null. */
export function logoProblem(file: { type: string; size: number }): 'type' | 'size' | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'type';
  return file.size > LOGO_MAX_BYTES ? 'size' : null;
}
