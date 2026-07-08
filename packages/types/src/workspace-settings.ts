/**
 * Workspace settings — DB-backed, admin-editable deployment configuration.
 *
 * SINGLE SOURCE OF TRUTH for which workspace-level settings exist (same
 * registry pattern as FEATURE_FLAGS). Consumed by:
 *   • apps/api — resolution (DB row → env fallback), env overlay, admin
 *                routes, /api/bootstrap (apps/api/src/settings/)
 *   • apps/web — Branding Studio persistence + the Runtime Config admin page
 *                render straight from this registry
 *
 * Adding a setting = one entry here (+ wiring its runtime effect if it is not
 * env-overlaid). No page changes, no migration — values live as one row per
 * key in the `workspace_settings` table.
 *
 * Resolution order (apps/api/src/settings/workspace-config.ts):
 *     DB row → env var (`env`) → unset
 * Admin edits win over the environment so changes apply without shell access;
 * clearing the DB row falls back to the env var. Entries with an `env` mapping
 * are overlaid onto process.env at startup and after every write, so existing
 * call-time consumers (model factory, media tools, external search) pick them
 * up unchanged.
 *
 * NOTE: this module must stay dependency-free (no zod) — the web bundle
 * imports the registry as runtime values. Server-side value validation lives
 * in apps/api/src/settings/.
 */

// ─── Registry ────────────────────────────────────────────

export type WorkspaceSettingGroup = 'branding' | 'llm' | 'vision' | 'image_gen' | 'search';

/**
 * Value shape stored in the `value` jsonb column:
 * 'string' (single line) and 'text' (multi-line) are JSON strings; 'json' is
 * an object validated per-key server-side (theme tokens, avatar DSL).
 */
export type WorkspaceSettingType = 'string' | 'text' | 'json';

export interface WorkspaceSettingDef {
  /** Stable key, stored verbatim in `workspace_settings.key`. Never rename. */
  key: string;
  group: WorkspaceSettingGroup;
  /** Human label for the admin UI. */
  label: string;
  /** What the setting controls (shown under the label). */
  description: string;
  type: WorkspaceSettingType;
  /** Encrypted at rest, write-only over the API (reads expose has_value only). */
  secret?: boolean;
  /** Env var this setting overlays / falls back to (see module doc). */
  env?: string;
  /** Max serialized length accepted on write (defense-in-depth; default 2000). */
  maxLength?: number;
  placeholder?: string;
}

/** Logo upload constraints (data URL stored as the `branding.logo` value). */
export const LOGO_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 256 * 1024;
/** base64 inflates ~4/3, plus the data: prefix. */
export const LOGO_MAX_DATA_URL_LENGTH = Math.ceil(LOGO_MAX_BYTES * 1.4);

const WORKSPACE_SETTINGS_LITERAL = [
  // ── Branding (no env fallback except the product name) ──
  {
    key: 'branding.product_name',
    group: 'branding',
    label: 'Product name',
    description: 'Tenant / product name shown in the app chrome, login screen and document title',
    type: 'string',
    env: 'PRODUCT_NAME',
    maxLength: 60,
    placeholder: 'Greenhouse',
  },
  {
    key: 'branding.logo',
    group: 'branding',
    label: 'Logo',
    description: 'Workspace logo (PNG/JPEG/SVG/WebP data URL, ≤ 256 KB); falls back to the built-in mark',
    type: 'text',
    maxLength: LOGO_MAX_DATA_URL_LENGTH,
  },
  {
    key: 'branding.theme_tokens',
    group: 'branding',
    label: 'Theme tokens',
    description: 'Design-token overrides (per-mode CSS variables + type/radius scales) from the Branding Studio',
    type: 'json',
    maxLength: 20000,
  },
  {
    key: 'branding.team_avatar',
    group: 'branding',
    label: 'Team Sprouty',
    description: 'Workspace default Sprouty avatar DSL (used by built-in profiles without their own avatar)',
    type: 'json',
    maxLength: 2000,
  },
  // ── Main LLM (OpenAI-compatible) ──
  {
    key: 'llm.base_url',
    group: 'llm',
    label: 'LLM base URL',
    description: 'OpenAI-compatible endpoint for the agent kernel',
    type: 'string',
    env: 'LLM_BASE_URL',
    placeholder: 'https://api.openai.com/v1',
  },
  {
    key: 'llm.api_key',
    group: 'llm',
    label: 'LLM API key',
    description: 'API key for the main LLM endpoint',
    type: 'string',
    secret: true,
    env: 'LLM_API_KEY',
  },
  {
    key: 'llm.model',
    group: 'llm',
    label: 'Default model',
    description: 'Model id for the default/flash logical models',
    type: 'string',
    env: 'LLM_MODEL',
    placeholder: 'gpt-4o-mini',
  },
  {
    key: 'llm.model_pro',
    group: 'llm',
    label: 'Pro model',
    description: 'Heavier model for the `pro` logical id (defaults to the default model)',
    type: 'string',
    env: 'LLM_MODEL_PRO',
  },
  {
    key: 'llm.model_title',
    group: 'llm',
    label: 'Title model',
    description: 'Light non-thinking model for auto-titles (defaults to the default model)',
    type: 'string',
    env: 'LLM_MODEL_TITLE',
  },
  // ── Vision (analyze_image) ──
  {
    key: 'vision.base_url',
    group: 'vision',
    label: 'Vision base URL',
    description: 'OpenAI-compatible multimodal endpoint (falls back to the main LLM endpoint)',
    type: 'string',
    env: 'IMAGE_API_BASE_URL',
  },
  {
    key: 'vision.api_key',
    group: 'vision',
    label: 'Vision API key',
    description: 'API key for the vision endpoint (falls back to the main LLM key)',
    type: 'string',
    secret: true,
    env: 'IMAGE_API_KEY',
  },
  {
    key: 'vision.model',
    group: 'vision',
    label: 'Vision model',
    description: 'Multimodal model id for analyze_image',
    type: 'string',
    env: 'VISION_MODEL',
  },
  // ── Image generation (generate_image) ──
  {
    key: 'image_gen.gpt_base_url',
    group: 'image_gen',
    label: 'Primary image base URL',
    description: 'OpenAI-compatible image API endpoint (required with its key to enable generate_image)',
    type: 'string',
    env: 'GPT_IMAGE_BASE_URL',
  },
  {
    key: 'image_gen.gpt_api_key',
    group: 'image_gen',
    label: 'Primary image API key',
    description: 'API key for the primary image provider',
    type: 'string',
    secret: true,
    env: 'GPT_IMAGE_API_KEY',
  },
  {
    key: 'image_gen.glm_base_url',
    group: 'image_gen',
    label: 'Fallback image base URL',
    description: 'Optional secondary image provider used when the primary fails',
    type: 'string',
    env: 'GLM_IMAGE_BASE_URL',
  },
  {
    key: 'image_gen.glm_api_key',
    group: 'image_gen',
    label: 'Fallback image API key',
    description: 'API key for the secondary image provider',
    type: 'string',
    secret: true,
    env: 'GLM_IMAGE_API_KEY',
  },
  // ── External web search ──
  {
    key: 'search.tavily_api_key',
    group: 'search',
    label: 'Tavily API key',
    description: 'Enables the Tavily provider of external_search',
    type: 'string',
    secret: true,
    env: 'TAVILY_API_KEY',
  },
  {
    key: 'search.firecrawl_api_key',
    group: 'search',
    label: 'Firecrawl API key',
    description: 'Enables the Firecrawl provider of external_search',
    type: 'string',
    secret: true,
    env: 'FIRECRAWL_API_KEY',
  },
  {
    key: 'search.brave_api_key',
    group: 'search',
    label: 'Brave Search API key',
    description: 'Enables the Brave provider of external_search',
    type: 'string',
    secret: true,
    env: 'BRAVE_SEARCH_API_KEY',
  },
] as const satisfies readonly WorkspaceSettingDef[];

/** The registry, widened to WorkspaceSettingDef so optional fields (env,
 *  secret, …) are accessible on every entry. */
export const WORKSPACE_SETTINGS: readonly WorkspaceSettingDef[] = WORKSPACE_SETTINGS_LITERAL;

/** Union of registry keys, e.g. 'branding.logo' | 'llm.api_key' | …. */
export type WorkspaceSettingKey = (typeof WORKSPACE_SETTINGS_LITERAL)[number]['key'];

export const WORKSPACE_SETTING_KEYS: readonly string[] = WORKSPACE_SETTINGS.map((s) => s.key);

export function getWorkspaceSettingDef(key: string): WorkspaceSettingDef | undefined {
  return WORKSPACE_SETTINGS.find((s) => s.key === key);
}

// ─── API views ───────────────────────────────────────────

/** Where the effective value of a setting currently comes from. */
export type WorkspaceSettingSource = 'db' | 'env' | 'none';

/** Admin read view — secrets never expose their value, only has_value/source. */
export interface WorkspaceSettingView {
  key: string;
  group: WorkspaceSettingGroup;
  label: string;
  description: string;
  type: WorkspaceSettingType;
  secret: boolean;
  env: string | null;
  /** Plain value when set in DB and not secret; null otherwise. */
  value: unknown;
  /** True when a DB row exists for this key. */
  has_value: boolean;
  source: WorkspaceSettingSource;
}

/** Pre-login personalization payload served by GET /api/bootstrap. */
export interface WorkspaceBootstrap {
  product_name: string | null;
  /** Logo data URL, or null to use the built-in mark. */
  logo: string | null;
  theme_tokens: ThemeTokens | null;
  /** Workspace default Sprouty avatar (profile-manifest AvatarConfig shape). */
  team_avatar: Record<string, unknown> | null;
}

// ─── Theme tokens (Branding Studio payload) ──────────────

/**
 * The Branding Studio's persisted state — everything needed to re-apply AND
 * re-edit a saved theme: the brand hex (the --primary-* palette is
 * regenerated client-side), font stacks, type/radius scales and the per-mode
 * CSS custom-property overrides. Sanitized on write AND on render (the web
 * injects the generated CSS into a <style> block — see sanitizeThemeTokens).
 */
export interface ThemeTokens {
  /** Brand color hex (#rrggbb) — regenerates the --primary-* palette. */
  brand?: string;
  /** Font stacks (CSS font-family lists). */
  fontSans?: string;
  fontMono?: string;
  /** Multiplier applied to the Tailwind --text-* sizes (0.8–1.2). */
  fontScale?: number;
  /** Multiplier applied to the Tailwind --radius-* sizes (0–2). */
  radiusScale?: number;
  /** Per-mode --t-* / semantic variable overrides (hex values). */
  light?: Record<string, string>;
  dark?: Record<string, string>;
}

const CSS_VAR_NAME_RE = /^--[a-z][a-z0-9-]*$/;
// Conservative value charset: hex colors, rgb()/oklch() etc., keywords, sizes.
// No braces/semicolons/slashes-comments — enough to express color/size tokens,
// not enough to escape a declaration block.
const CSS_VALUE_RE = /^[#a-zA-Z0-9 ().,%_-]{1,80}$/;
const BRAND_HEX_RE = /^#[0-9a-fA-F]{6}$/;
// Font stacks: family names with quotes/commas only — no ; { } / so the value
// cannot escape the declaration.
const FONT_STACK_RE = /^[a-zA-Z0-9 ,'"-]{1,200}$/;

function sanitizeVarMap(map: unknown): Record<string, string> | undefined {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (!CSS_VAR_NAME_RE.test(k) || !CSS_VALUE_RE.test(v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function clampScale(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, v));
}

/**
 * Structural sanitizer for ThemeTokens — drops anything that is not a safe
 * CSS variable name/value/font stack. Returns null when nothing valid
 * remains. Used by the API on write and by the web before injecting the
 * <style> block, so a tampered DB value still cannot break out of the
 * declaration.
 */
export function sanitizeThemeTokens(raw: unknown): ThemeTokens | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: ThemeTokens = {};
  if (typeof o.brand === 'string' && BRAND_HEX_RE.test(o.brand)) out.brand = o.brand;
  if (typeof o.fontSans === 'string' && o.fontSans.trim() && FONT_STACK_RE.test(o.fontSans.trim()))
    out.fontSans = o.fontSans.trim();
  if (typeof o.fontMono === 'string' && o.fontMono.trim() && FONT_STACK_RE.test(o.fontMono.trim()))
    out.fontMono = o.fontMono.trim();
  const light = sanitizeVarMap(o.light);
  const dark = sanitizeVarMap(o.dark);
  if (light) out.light = light;
  if (dark) out.dark = dark;
  const fontScale = clampScale(o.fontScale, 0.8, 1.2);
  const radiusScale = clampScale(o.radiusScale, 0, 2);
  if (fontScale !== undefined && fontScale !== 1) out.fontScale = fontScale;
  if (radiusScale !== undefined && radiusScale !== 1) out.radiusScale = radiusScale;
  return Object.keys(out).length ? out : null;
}
