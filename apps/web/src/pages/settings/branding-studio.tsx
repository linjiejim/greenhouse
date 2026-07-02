/**
 * Branding Studio (super only) — live-preview brand tokens, then export a CSS
 * override block for a downstream fork's src/branding.css (S6 seam).
 *
 * Stateless by design: edits are previewed via inline CSS variables on
 * <html> and NEVER persisted (server or localStorage). Leaving the page
 * removes the preview. The inline-style preview intentionally outranks
 * branding.css — that's what makes it a preview.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input } from '../../components/ui';
import { Sun, Moon, ClipboardCopy, RotateCcw } from '../../lib/icons';
import { useI18n } from '../../lib/i18n';
import { getThemeMode, setThemeMode } from '../../lib/theme';
import {
  PALETTE_SHADES,
  generatePalette,
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

/** The --t-* tokens exposed for visual editing. Status colors and the rest
 *  stay hand-written CSS in branding.css — they're rarely rebranded. */
const TOKEN_GROUPS: TokenGroup[] = [
  {
    key: 'groupSurface',
    tokens: [
      { variable: '--t-surface', label: 'surface' },
      { variable: '--t-surface-raised', label: 'surface-raised' },
      { variable: '--t-surface-muted', label: 'surface-muted' },
      { variable: '--t-surface-sunken', label: 'surface-sunken' },
    ],
  },
  {
    key: 'groupText',
    tokens: [
      { variable: '--t-fg', label: 'fg' },
      { variable: '--t-fg-secondary', label: 'fg-secondary' },
      { variable: '--t-fg-muted', label: 'fg-muted' },
      { variable: '--t-fg-faint', label: 'fg-faint' },
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

export function BrandingStudioPanel() {
  const { t } = useI18n();
  const [previewMode, setPreviewMode] = useState<PreviewMode>(isDarkPreviewActive);
  const [brandHex, setBrandHex] = useState<string>(currentBrandHex);
  const [palette, setPalette] = useState<Record<PaletteShade, Rgb> | null>(null);
  const [overrides, setOverrides] = useState<{ light: Record<string, string>; dark: Record<string, string> }>({
    light: {},
    dark: {},
  });
  const [copied, setCopied] = useState(false);
  // Bumped whenever inline styles / preview mode change so computed values re-read.
  const [tick, setTick] = useState(0);

  // Leaving the page drops the preview: clear inline vars, restore the stored mode.
  useEffect(() => {
    return () => {
      for (const shade of PALETTE_SHADES) rootStyle().removeProperty(`--primary-${shade}`);
      for (const variable of ALL_TOKEN_VARS) rootStyle().removeProperty(variable);
      setThemeMode(getThemeMode());
    };
  }, []);

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

  const setTokenOverride = (variable: string, hex: string) => {
    rootStyle().setProperty(variable, hex);
    setOverrides((prev) => ({ ...prev, [previewMode]: { ...prev[previewMode], [variable]: hex } }));
  };

  const switchPreviewMode = (mode: PreviewMode) => {
    if (mode === previewMode) return;
    // Token overrides are per-mode: drop the current mode's inline values,
    // toggle the class, then re-apply the target mode's saved edits.
    for (const variable of ALL_TOKEN_VARS) rootStyle().removeProperty(variable);
    document.documentElement.classList.toggle('dark-theme', mode === 'dark');
    for (const [variable, value] of Object.entries(overrides[mode])) {
      rootStyle().setProperty(variable, value);
    }
    setPreviewMode(mode);
    setTick((n) => n + 1);
  };

  const resetPreview = () => {
    for (const shade of PALETTE_SHADES) rootStyle().removeProperty(`--primary-${shade}`);
    for (const variable of ALL_TOKEN_VARS) rootStyle().removeProperty(variable);
    setPalette(null);
    setOverrides({ light: {}, dark: {} });
    setBrandHex(currentBrandHex());
    setCopied(false);
    setTick((n) => n + 1);
  };

  const exportCss = useMemo(() => {
    const rootLines: string[] = [];
    if (palette) {
      for (const shade of PALETTE_SHADES) rootLines.push(`  --primary-${shade}: ${rgbToTriplet(palette[shade])};`);
    }
    for (const [variable, value] of Object.entries(overrides.light)) rootLines.push(`  ${variable}: ${value};`);
    const darkLines = Object.entries(overrides.dark).map(([variable, value]) => `  ${variable}: ${value};`);

    const blocks: string[] = [];
    if (rootLines.length) blocks.push(`:root {\n${rootLines.join('\n')}\n}`);
    if (darkLines.length) blocks.push(`.dark-theme {\n${darkLines.join('\n')}\n}`);
    return blocks.join('\n\n');
  }, [palette, overrides]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(exportCss);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <p className="text-xs text-fg-muted bg-surface-muted border border-edge rounded-lg px-3 py-2 leading-relaxed">
        {t('brandingStudio.intro')}
      </p>

      {/* Preview mode */}
      <section>
        <label className="block text-sm font-medium text-fg-secondary mb-2">{t('brandingStudio.previewMode')}</label>
        <div className="flex gap-2">
          {(['light', 'dark'] as const).map((mode) => {
            const Icon = mode === 'light' ? Sun : Moon;
            const isActive = previewMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => switchPreviewMode(mode)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 transition-all ${
                  isActive
                    ? 'border-primary-500 bg-primary-subtle/50 text-primary-fg-strong font-medium shadow-sm'
                    : 'border-edge text-fg-secondary hover:border-edge-strong hover:bg-surface-sunken'
                }`}
              >
                <Icon size={15} />
                <span className="text-sm">
                  {mode === 'light' ? t('preferences.themeLight') : t('preferences.themeDark')}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Brand color → palette */}
      <section>
        <label className="block text-sm font-medium text-fg-secondary mb-1">{t('brandingStudio.brandColor')}</label>
        <p className="text-xs text-fg-faint mb-2">{t('brandingStudio.brandColorHint')}</p>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={brandHex}
            onChange={(e) => applyBrandColor(e.target.value)}
            className="h-9 w-12 rounded-md border border-edge-strong bg-surface cursor-pointer"
            aria-label={t('brandingStudio.brandColor')}
          />
          <Input
            value={brandHex}
            onChange={(e) => {
              const hex = e.target.value;
              setBrandHex(hex);
              if (hexToRgb(hex)) applyBrandColor(hex.startsWith('#') ? hex : `#${hex}`);
            }}
            className="w-32 font-mono text-sm"
            spellCheck={false}
          />
        </div>
        {palette && (
          <div className="mt-3">
            <span className="block text-xs text-fg-muted mb-1.5">{t('brandingStudio.palettePreview')}</span>
            <div className="flex rounded-lg overflow-hidden border border-edge">
              {PALETTE_SHADES.map((shade) => (
                <div
                  key={shade}
                  className="flex-1 h-9 flex items-end justify-center pb-0.5"
                  style={{ backgroundColor: rgbToHex(palette[shade]) }}
                  title={`primary-${shade}: ${rgbToHex(palette[shade])}`}
                >
                  <span className={`text-[9px] font-mono ${shade >= 400 ? 'text-white/80' : 'text-black/50'}`}>
                    {shade}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Token editors */}
      <section>
        <label className="block text-sm font-medium text-fg-secondary mb-1">{t('brandingStudio.tokens')}</label>
        <p className="text-xs text-fg-faint mb-3">{t('brandingStudio.tokensHint')}</p>
        <div className="space-y-4">
          {TOKEN_GROUPS.map((group) => (
            <div key={group.key}>
              <span className="block text-xs font-medium text-fg-muted mb-1.5">{t(`brandingStudio.${group.key}`)}</span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-tick={tick}>
                {group.tokens.map((token) => {
                  const value = overrides[previewMode][token.variable] ?? computedVar(token.variable);
                  return (
                    <div
                      key={token.variable}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-edge"
                    >
                      <input
                        type="color"
                        value={value}
                        onChange={(e) => setTokenOverride(token.variable, e.target.value)}
                        className="h-6 w-8 rounded border border-edge cursor-pointer flex-shrink-0"
                        aria-label={token.variable}
                      />
                      <span className="text-[10px] font-mono text-fg-secondary truncate" title={token.variable}>
                        {token.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Export */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium text-fg-secondary">{t('brandingStudio.exportTitle')}</label>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={resetPreview}>
              <RotateCcw size={13} className="mr-1" />
              {t('brandingStudio.reset')}
            </Button>
            <Button size="sm" onClick={handleCopy} disabled={!exportCss}>
              <ClipboardCopy size={13} className="mr-1" />
              {copied ? t('brandingStudio.copied') : t('brandingStudio.copy')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-fg-faint mb-2">{t('brandingStudio.exportHint')}</p>
        {exportCss ? (
          <pre className="text-xs font-mono bg-surface-muted border border-edge rounded-lg p-3 overflow-x-auto whitespace-pre">
            {exportCss}
          </pre>
        ) : (
          <p className="text-xs text-fg-muted border border-dashed border-edge rounded-lg px-3 py-4 text-center">
            {t('brandingStudio.noChanges')}
          </p>
        )}
      </section>
    </div>
  );
}
