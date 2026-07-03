/**
 * Branding Studio (super only) — live-preview brand tokens, then export a CSS
 * override block for a downstream fork's src/branding.css (S6 seam).
 *
 * Stateless by design: edits are previewed via inline CSS variables on
 * <html> and NEVER persisted (server or localStorage). Leaving the page
 * removes the preview. The inline-style preview intentionally outranks
 * branding.css — that's what makes it a preview.
 *
 * Beyond the color tokens, typography and shape ride on Tailwind v4's default
 * theme variables (--font-sans, --text-*, --radius-*): utilities compile to
 * var() references, so redefining the variable restyles every consumer with
 * zero component changes.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Tooltip } from '../../components/ui';
import { Sun, Moon, ClipboardCopy, RotateCcw, Info } from '../../lib/icons';
import { useI18n } from '../../lib/i18n';
import { getThemeMode, setThemeMode } from '../../lib/theme';
import { BrandingPreview } from './branding-preview';
import {
  PALETTE_SHADES,
  generatePalette,
  deriveSemantic,
  hexToRgb,
  rgbToHex,
  rgbToTriplet,
  type PaletteShade,
  type Rgb,
} from '../../lib/color';

type PreviewMode = 'light' | 'dark';

interface TokenDef {
  variable: string;
  label: string;
}

interface TokenGroup {
  key: 'groupSurface' | 'groupText' | 'groupBorder';
  tokens: TokenDef[];
}

/** The --t-* surface/text/border tokens exposed for visual editing. */
const TOKEN_GROUPS: TokenGroup[] = [
  {
    key: 'groupSurface',
    tokens: [
      { variable: '--t-surface', label: 'surface' },
      { variable: '--t-surface-raised', label: 'raised' },
      { variable: '--t-surface-muted', label: 'muted' },
      { variable: '--t-surface-sunken', label: 'sunken' },
    ],
  },
  {
    key: 'groupText',
    tokens: [
      { variable: '--t-fg', label: 'fg' },
      { variable: '--t-fg-secondary', label: 'secondary' },
      { variable: '--t-fg-muted', label: 'muted' },
      { variable: '--t-fg-faint', label: 'faint' },
    ],
  },
  {
    key: 'groupBorder',
    tokens: [
      { variable: '--t-edge', label: 'edge' },
      { variable: '--t-edge-strong', label: 'edge-strong' },
    ],
  },
];

const ALL_TOKEN_VARS = TOKEN_GROUPS.flatMap((g) => g.tokens.map((t) => t.variable));

/** Configurable status colors — each drives a base/subtle/fg trio. */
const SEMANTICS = [
  { key: 'success', base: '--t-success', subtle: '--t-success-subtle', fg: '--t-success-fg' },
  { key: 'warning', base: '--t-warning', subtle: '--t-warning-subtle', fg: '--t-warning-fg' },
  { key: 'danger', base: '--t-danger', subtle: '--t-danger-subtle', fg: '--t-danger-fg' },
  { key: 'info', base: '--t-info', subtle: '--t-info-subtle', fg: '--t-info-fg' },
] as const;

const ALL_SEMANTIC_VARS = SEMANTICS.flatMap((s) => [s.base, s.subtle, s.fg]);

/** Every variable that lives in the per-mode overrides map (mode-dependent). */
const PER_MODE_VARS = [...ALL_TOKEN_VARS, ...ALL_SEMANTIC_VARS];

/** Tailwind v4 default text sizes (rem) — scaled by the font-size slider.
 *  Line heights are unitless ratios, so they follow automatically. */
const TEXT_SIZE_DEFAULTS: Record<string, number> = {
  '--text-xs': 0.75,
  '--text-sm': 0.875,
  '--text-base': 1,
  '--text-lg': 1.125,
  '--text-xl': 1.25,
};

/** Tailwind v4 default radii (rem) — scaled by the roundness slider. */
const RADIUS_DEFAULTS: Record<string, number> = {
  '--radius-xs': 0.125,
  '--radius-sm': 0.25,
  '--radius-md': 0.375,
  '--radius-lg': 0.5,
  '--radius-xl': 0.75,
  '--radius-2xl': 1,
  '--radius-3xl': 1.5,
  '--radius-4xl': 2,
};

/** Web-safe font stacks a fork can preview without shipping a webfont. */
const FONT_DEFAULT = '';
const FONT_INTER = "'Inter', ui-sans-serif, system-ui, sans-serif";
const FONT_HUMANIST = "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', sans-serif";
const FONT_SERIF = "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif";

const FONT_SANS_PRESETS: Array<{ label: string; stack: string }> = [
  { label: 'Inter', stack: FONT_INTER },
  { label: 'Humanist', stack: FONT_HUMANIST },
  { label: 'Serif', stack: FONT_SERIF },
];

/** One-click starting points — each sets a whole "feel" (color + font + shape). */
interface StylePreset {
  key: string;
  swatch: string;
  brand: string;
  fontSans: string;
  textScale: number;
  radiusScale: number;
}

const STYLE_PRESETS: StylePreset[] = [
  { key: 'greenhouse', swatch: '#14b8a6', brand: '#14b8a6', fontSans: FONT_DEFAULT, textScale: 1, radiusScale: 1 },
  { key: 'slate', swatch: '#4f46e5', brand: '#4f46e5', fontSans: FONT_INTER, textScale: 1, radiusScale: 0.5 },
  { key: 'sunset', swatch: '#ea580c', brand: '#ea580c', fontSans: FONT_HUMANIST, textScale: 1, radiusScale: 1.75 },
  { key: 'editorial', swatch: '#9f1239', brand: '#9f1239', fontSans: FONT_SERIF, textScale: 1.05, radiusScale: 0.75 },
  { key: 'graphite', swatch: '#334155', brand: '#334155', fontSans: FONT_DEFAULT, textScale: 0.95, radiusScale: 0 },
];

const scaledRem = (base: number, scale: number) => `${+(base * scale).toFixed(4)}rem`;

function rootStyle() {
  return document.documentElement.style;
}

function computedVar(variable: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

/** Current --primary-500 as hex (triplet var → hex), for the color input default. */
function currentBrandHex(): string {
  const triplet = computedVar('--primary-500').split(/\s+/).map(Number);
  if (triplet.length === 3 && triplet.every((n) => Number.isFinite(n))) {
    return rgbToHex({ r: triplet[0], g: triplet[1], b: triplet[2] });
  }
  return '#14b8a6';
}

function isDarkPreviewActive(): PreviewMode {
  return document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light';
}

/** Remove every inline variable the studio can set. */
function clearAllInlineVars() {
  for (const shade of PALETTE_SHADES) rootStyle().removeProperty(`--primary-${shade}`);
  for (const variable of PER_MODE_VARS) rootStyle().removeProperty(variable);
  for (const variable of Object.keys(TEXT_SIZE_DEFAULTS)) rootStyle().removeProperty(variable);
  for (const variable of Object.keys(RADIUS_DEFAULTS)) rootStyle().removeProperty(variable);
  rootStyle().removeProperty('--font-sans');
  rootStyle().removeProperty('--font-mono');
}

// ─── Small building blocks ───────────────────────────────

/** Section header: title + a "more info" tooltip that explains what the
 *  control affects in the running app (plain language, no CSS jargon). */
function ControlSection({ title, tip, children }: { title: string; tip: string; children: React.ReactNode }) {
  return (
    <section className="py-5 first:pt-0 last:pb-0">
      <div className="flex items-center gap-1.5 mb-3">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <Tooltip content={tip}>
          <Info size={13} className="text-fg-faint hover:text-fg-muted cursor-help" />
        </Tooltip>
      </div>
      {children}
    </section>
  );
}

function ScaleSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-fg-muted w-16 flex-shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-primary-600"
        aria-label={label}
      />
      <span className="text-xs font-mono text-fg-secondary w-12 text-right">
        {format ? format(value) : `${Math.round(value * 100)}%`}
      </span>
    </div>
  );
}

function SwatchInput({
  variable,
  label,
  value,
  onChange,
}: {
  variable: string;
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-edge">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-8 rounded border border-edge cursor-pointer flex-shrink-0"
        aria-label={variable}
      />
      <span className="text-[10px] font-mono text-fg-secondary truncate" title={variable}>
        {label}
      </span>
    </div>
  );
}

// ─── Panel ───────────────────────────────────────────────

export function BrandingStudioPanel() {
  const { t } = useI18n();
  const [previewMode, setPreviewMode] = useState<PreviewMode>(isDarkPreviewActive);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [brandHex, setBrandHex] = useState<string>(currentBrandHex);
  const [palette, setPalette] = useState<Record<PaletteShade, Rgb> | null>(null);
  const [overrides, setOverrides] = useState<{ light: Record<string, string>; dark: Record<string, string> }>({
    light: {},
    dark: {},
  });
  const [fontSans, setFontSans] = useState('');
  const [fontMono, setFontMono] = useState('');
  const [textScale, setTextScale] = useState(1);
  const [radiusScale, setRadiusScale] = useState(1);
  const [copied, setCopied] = useState(false);
  // Bumped whenever inline styles / preview mode change so computed values re-read.
  const [tick, setTick] = useState(0);

  // Leaving the page drops the preview: clear inline vars, restore the stored mode.
  useEffect(() => {
    return () => {
      clearAllInlineVars();
      setThemeMode(getThemeMode());
    };
  }, []);

  // ── apply helpers (pure — do NOT touch activePreset, so presets can reuse) ──

  const applyBrandColor = (hex: string) => {
    setBrandHex(hex);
    const generated = generatePalette(hex);
    if (!generated) return;
    setPalette(generated);
    for (const shade of PALETTE_SHADES) {
      rootStyle().setProperty(`--primary-${shade}`, rgbToTriplet(generated[shade]));
    }
    setTick((n) => n + 1);
  };

  const applyFontSans = (stack: string) => {
    setFontSans(stack);
    if (stack.trim()) rootStyle().setProperty('--font-sans', stack);
    else rootStyle().removeProperty('--font-sans');
  };

  const applyFontMono = (stack: string) => {
    setFontMono(stack);
    if (stack.trim()) rootStyle().setProperty('--font-mono', stack);
    else rootStyle().removeProperty('--font-mono');
  };

  const applyTextScale = (scale: number) => {
    setTextScale(scale);
    for (const [variable, base] of Object.entries(TEXT_SIZE_DEFAULTS)) {
      if (scale === 1) rootStyle().removeProperty(variable);
      else rootStyle().setProperty(variable, scaledRem(base, scale));
    }
  };

  const applyRadiusScale = (scale: number) => {
    setRadiusScale(scale);
    for (const [variable, base] of Object.entries(RADIUS_DEFAULTS)) {
      if (scale === 1) rootStyle().removeProperty(variable);
      else rootStyle().setProperty(variable, scaledRem(base, scale));
    }
  };

  const setTokenOverride = (variable: string, hex: string) => {
    rootStyle().setProperty(variable, hex);
    setOverrides((prev) => ({ ...prev, [previewMode]: { ...prev[previewMode], [variable]: hex } }));
    setActivePreset(null);
  };

  const setSemanticColor = (s: (typeof SEMANTICS)[number], hex: string) => {
    const derived = deriveSemantic(hex, previewMode === 'dark');
    if (!derived) return;
    const entries: Record<string, string> = { [s.base]: derived.base, [s.subtle]: derived.subtle, [s.fg]: derived.fg };
    for (const [variable, value] of Object.entries(entries)) rootStyle().setProperty(variable, value);
    setOverrides((prev) => ({ ...prev, [previewMode]: { ...prev[previewMode], ...entries } }));
    setActivePreset(null);
  };

  // ── preset + mode + reset ──

  const applyPreset = (p: StylePreset) => {
    // Fresh slate for any fine-tuning done on top of the preset.
    for (const variable of PER_MODE_VARS) rootStyle().removeProperty(variable);
    setOverrides({ light: {}, dark: {} });
    applyBrandColor(p.brand);
    applyFontSans(p.fontSans);
    applyFontMono('');
    applyTextScale(p.textScale);
    applyRadiusScale(p.radiusScale);
    setActivePreset(p.key);
  };

  const switchPreviewMode = (mode: PreviewMode) => {
    if (mode === previewMode) return;
    // Per-mode overrides: drop this mode's inline values, toggle the class,
    // re-apply the target mode's saved edits. (Palette / type / shape are
    // mode-independent and stay put.)
    for (const variable of PER_MODE_VARS) rootStyle().removeProperty(variable);
    document.documentElement.classList.toggle('dark-theme', mode === 'dark');
    for (const [variable, value] of Object.entries(overrides[mode])) {
      rootStyle().setProperty(variable, value);
    }
    setPreviewMode(mode);
    setTick((n) => n + 1);
  };

  const resetPreview = () => {
    clearAllInlineVars();
    setPalette(null);
    setOverrides({ light: {}, dark: {} });
    setBrandHex(currentBrandHex());
    setFontSans('');
    setFontMono('');
    setTextScale(1);
    setRadiusScale(1);
    setActivePreset(null);
    setCopied(false);
    setTick((n) => n + 1);
  };

  const exportCss = useMemo(() => {
    const rootLines: string[] = [];
    if (palette) {
      for (const shade of PALETTE_SHADES) rootLines.push(`  --primary-${shade}: ${rgbToTriplet(palette[shade])};`);
    }
    if (fontSans.trim()) rootLines.push(`  --font-sans: ${fontSans.trim()};`);
    if (fontMono.trim()) rootLines.push(`  --font-mono: ${fontMono.trim()};`);
    if (textScale !== 1) {
      for (const [variable, base] of Object.entries(TEXT_SIZE_DEFAULTS)) {
        rootLines.push(`  ${variable}: ${scaledRem(base, textScale)};`);
      }
    }
    if (radiusScale !== 1) {
      for (const [variable, base] of Object.entries(RADIUS_DEFAULTS)) {
        rootLines.push(`  ${variable}: ${scaledRem(base, radiusScale)};`);
      }
    }
    for (const [variable, value] of Object.entries(overrides.light)) rootLines.push(`  ${variable}: ${value};`);
    const darkLines = Object.entries(overrides.dark).map(([variable, value]) => `  ${variable}: ${value};`);

    const blocks: string[] = [];
    if (rootLines.length) blocks.push(`:root {\n${rootLines.join('\n')}\n}`);
    if (darkLines.length) blocks.push(`.dark-theme {\n${darkLines.join('\n')}\n}`);
    return blocks.join('\n\n');
  }, [palette, overrides, fontSans, fontMono, textScale, radiusScale]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(exportCss);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-muted leading-relaxed max-w-3xl">{t('brandingStudio.intro')}</p>

      <div className="lg:grid lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-8 lg:items-start space-y-6 lg:space-y-0">
        {/* ─── Left: controls (light dividers between sections) ─── */}
        <div className="divide-y divide-edge">
          {/* Presets */}
          <ControlSection title={t('brandingStudio.presets')} tip={t('brandingStudio.tipPresets')}>
            <div className="flex flex-wrap gap-1.5">
              {STYLE_PRESETS.map((p) => {
                const isActive = activePreset === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={`flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full border transition-all ${
                      isActive
                        ? 'border-primary-500 bg-primary-subtle/50 text-primary-fg-strong font-medium shadow-sm'
                        : 'border-edge text-fg-secondary hover:border-edge-strong hover:bg-surface-sunken'
                    }`}
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full border border-black/10 flex-shrink-0"
                      style={{ backgroundColor: p.swatch }}
                    />
                    <span className="text-xs">{t(`brandingStudio.preset_${p.key}`)}</span>
                  </button>
                );
              })}
            </div>
          </ControlSection>

          {/* Brand color → palette */}
          <ControlSection title={t('brandingStudio.brandColor')} tip={t('brandingStudio.tipBrand')}>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={brandHex}
                onChange={(e) => {
                  applyBrandColor(e.target.value);
                  setActivePreset(null);
                }}
                className="h-9 w-12 rounded-md border border-edge-strong bg-surface cursor-pointer"
                aria-label={t('brandingStudio.brandColor')}
              />
              <Input
                value={brandHex}
                onChange={(e) => {
                  const hex = e.target.value;
                  setBrandHex(hex);
                  if (hexToRgb(hex)) {
                    applyBrandColor(hex.startsWith('#') ? hex : `#${hex}`);
                    setActivePreset(null);
                  }
                }}
                className="w-32 font-mono text-sm"
                spellCheck={false}
              />
            </div>
            {palette && (
              <div className="mt-3 flex rounded-lg overflow-hidden border border-edge">
                {PALETTE_SHADES.map((shade) => (
                  <div
                    key={shade}
                    className="flex-1 h-8 flex items-end justify-center pb-0.5"
                    style={{ backgroundColor: rgbToHex(palette[shade]) }}
                    title={`primary-${shade}: ${rgbToHex(palette[shade])}`}
                  >
                    <span className={`text-[9px] font-mono ${shade >= 400 ? 'text-white/80' : 'text-black/50'}`}>
                      {shade}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </ControlSection>

          {/* Semantic status colors */}
          <ControlSection title={t('brandingStudio.semantic')} tip={t('brandingStudio.tipSemantic')}>
            <div className="grid grid-cols-2 gap-2" data-tick={tick}>
              {SEMANTICS.map((s) => (
                <SwatchInput
                  key={s.key}
                  variable={s.base}
                  label={s.key}
                  value={overrides[previewMode][s.base] ?? computedVar(s.base)}
                  onChange={(hex) => setSemanticColor(s, hex)}
                />
              ))}
            </div>
          </ControlSection>

          {/* Surfaces / text / borders */}
          <ControlSection title={t('brandingStudio.tokens')} tip={t('brandingStudio.tipTokens')}>
            <div className="space-y-4">
              {TOKEN_GROUPS.map((group) => (
                <div key={group.key}>
                  <span className="block text-xs font-medium text-fg-muted mb-1.5">
                    {t(`brandingStudio.${group.key}`)}
                  </span>
                  <div className="grid grid-cols-2 gap-2" data-tick={tick}>
                    {group.tokens.map((token) => (
                      <SwatchInput
                        key={token.variable}
                        variable={token.variable}
                        label={token.label}
                        value={overrides[previewMode][token.variable] ?? computedVar(token.variable)}
                        onChange={(hex) => setTokenOverride(token.variable, hex)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ControlSection>

          {/* Typography */}
          <ControlSection title={t('brandingStudio.typography')} tip={t('brandingStudio.tipTypography')}>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    applyFontSans('');
                    setActivePreset(null);
                  }}
                  className={`px-2.5 py-1 text-xs rounded-lg border transition-all ${
                    fontSans === ''
                      ? 'border-primary-500 bg-primary-subtle/50 text-primary-fg-strong font-medium'
                      : 'border-edge text-fg-secondary hover:border-edge-strong'
                  }`}
                >
                  {t('brandingStudio.fontDefault')}
                </button>
                {FONT_SANS_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      applyFontSans(preset.stack);
                      setActivePreset(null);
                    }}
                    style={{ fontFamily: preset.stack }}
                    className={`px-2.5 py-1 text-xs rounded-lg border transition-all ${
                      fontSans === preset.stack
                        ? 'border-primary-500 bg-primary-subtle/50 text-primary-fg-strong font-medium'
                        : 'border-edge text-fg-secondary hover:border-edge-strong'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <Input
                value={fontSans}
                onChange={(e) => {
                  applyFontSans(e.target.value);
                  setActivePreset(null);
                }}
                placeholder={t('brandingStudio.fontCustomPlaceholder')}
                size="sm"
                className="font-mono text-xs"
                spellCheck={false}
              />
              <Input
                value={fontMono}
                onChange={(e) => {
                  applyFontMono(e.target.value);
                  setActivePreset(null);
                }}
                placeholder={t('brandingStudio.fontMonoPlaceholder')}
                size="sm"
                className="font-mono text-xs"
                spellCheck={false}
              />
              <ScaleSlider
                label={t('brandingStudio.textScale')}
                value={textScale}
                min={0.85}
                max={1.15}
                step={0.025}
                onChange={(v) => {
                  applyTextScale(v);
                  setActivePreset(null);
                }}
              />
            </div>
          </ControlSection>

          {/* Shape */}
          <ControlSection title={t('brandingStudio.shape')} tip={t('brandingStudio.tipShape')}>
            <ScaleSlider
              label={t('brandingStudio.radius')}
              value={radiusScale}
              min={0}
              max={2}
              step={0.125}
              onChange={(v) => {
                applyRadiusScale(v);
                setActivePreset(null);
              }}
            />
          </ControlSection>

          {/* Export */}
          <ControlSection title={t('brandingStudio.exportTitle')} tip={t('brandingStudio.tipExport')}>
            <div className="flex items-center gap-2 mb-2">
              <Button variant="outline" size="sm" onClick={resetPreview}>
                <RotateCcw size={13} className="mr-1" />
                {t('brandingStudio.reset')}
              </Button>
              <Button size="sm" onClick={handleCopy} disabled={!exportCss}>
                <ClipboardCopy size={13} className="mr-1" />
                {copied ? t('brandingStudio.copied') : t('brandingStudio.copy')}
              </Button>
            </div>
            {exportCss ? (
              <pre className="text-xs font-mono bg-surface-muted border border-edge rounded-lg p-3 overflow-x-auto whitespace-pre">
                {exportCss}
              </pre>
            ) : (
              <p className="text-xs text-fg-muted border border-dashed border-edge rounded-lg px-3 py-4 text-center">
                {t('brandingStudio.noChanges')}
              </p>
            )}
          </ControlSection>
        </div>

        {/* ─── Right: live specimen canvas ─── */}
        <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:pr-1">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-fg-secondary">{t('brandingStudio.preview')}</span>
              <Tooltip content={t('brandingStudio.tipPreview')}>
                <Info size={13} className="text-fg-faint hover:text-fg-muted cursor-help" />
              </Tooltip>
            </div>
            {/* Preview mode — also selects which mode's color edits you're making */}
            <div className="inline-flex rounded-lg border border-edge p-0.5">
              {(['light', 'dark'] as const).map((mode) => {
                const Icon = mode === 'light' ? Sun : Moon;
                const isActive = previewMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => switchPreviewMode(mode)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${
                      isActive ? 'bg-surface-muted text-fg font-medium' : 'text-fg-muted hover:text-fg-secondary'
                    }`}
                    aria-pressed={isActive}
                  >
                    <Icon size={13} />
                    {mode === 'light' ? t('preferences.themeLight') : t('preferences.themeDark')}
                  </button>
                );
              })}
            </div>
          </div>
          <BrandingPreview />
        </div>
      </div>
    </div>
  );
}
