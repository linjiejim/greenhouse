/**
 * Branding: the workspace's product name, logo and theme tokens (`branding.*` workspace
 * settings, served before sign-in by /api/bootstrap and used by exports and plugin frames).
 * Start from a style, then tune the brand color, fonts, text size and roundness; the preview on the
 * right shows the result in light and dark without restyling the app around it. Saving stores
 * the whole state; per-mode color overrides saved earlier are kept.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { webColors } from '../theme/web-colors.generated';
import { Icon } from '../ui/core';
import { alertError, confirmAction } from '../ui/dialogs';
import { toast } from '../ui/toast';
import * as admin from './api';
import { AdminPage, Card, Field, SectionState } from './kit.web';
import { useWrite } from './use-write';
import {
  FONT_PRESETS,
  STYLE_PRESETS,
  activePreset,
  draftOf,
  logoProblem,
  normalizeHex,
  onBrand,
  presetDraft,
  tokensOf,
  LOGO_TYPES,
  type BrandDraft,
  type ThemeTokens,
} from './branding-model';

export default function BrandingSection() {
  const t = useT();
  const settings = useResource(useCallback(() => admin.listSettings(), []));
  const views = settings.data?.settings;
  const saved = useMemo(() => {
    const value = (key: string) => views?.find((v) => v.key === key)?.value;
    const tokens = value('branding.theme_tokens');
    return {
      tokens: tokens && typeof tokens === 'object' ? (tokens as ThemeTokens) : null,
      name: typeof value('branding.product_name') === 'string' ? (value('branding.product_name') as string) : '',
      logo: typeof value('branding.logo') === 'string' ? (value('branding.logo') as string) : null,
    };
  }, [views]);
  const [draft, setDraft] = useState<BrandDraft>(() => draftOf(null));
  const [hexText, setHexText] = useState(draft.brand);
  const [name, setName] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const { busy, run } = useWrite();
  const restore = useCallback(() => {
    const next = draftOf(saved.tokens);
    setDraft(next);
    setHexText(next.brand);
    setName(saved.name);
    setLogo(saved.logo);
  }, [saved]);
  useEffect(() => {
    if (views) restore();
  }, [views, restore]);
  const set = (change: Partial<BrandDraft>) => setDraft((d) => ({ ...d, ...change }));
  const preset = activePreset(draft);
  const pickLogo = (file: File) => {
    const problem = logoProblem(file);
    if (problem) {
      alertError(t(problem === 'type' ? 'admin.branding.logoType' : 'admin.branding.logoSize'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  };
  const save = async () => {
    const answer = await run(
      () =>
        admin.saveSettings({
          'branding.theme_tokens': tokensOf(draft, saved.tokens),
          'branding.product_name': name.trim() || null,
          'branding.logo': logo || null,
        }),
      t('admin.saveFailed'),
    );
    if (!answer) return;
    settings.setData(answer);
    toast(t('admin.branding.saved'));
  };
  const clear = async () => {
    const ok = await confirmAction({
      title: t('admin.branding.clearTitle'),
      message: t('admin.branding.clearHint'),
      confirmLabel: t('admin.branding.clear'),
      destructive: true,
    });
    if (!ok) return;
    const answer = await run(
      () => admin.saveSettings({ 'branding.theme_tokens': null, 'branding.product_name': null, 'branding.logo': null }),
      t('admin.saveFailed'),
    );
    if (!answer) return;
    settings.setData(answer);
    toast(t('admin.branding.cleared'));
  };
  if (!views)
    return (
      <AdminPage title={t('admin.sections.branding')}>
        <SectionState loading={settings.loading} error={settings.error} retry={() => void settings.refresh()} />
      </AdminPage>
    );
  return (
    <AdminPage
      title={t('admin.sections.branding')}
      testID="admin-branding"
      actions={
        <>
          <button className="gh-secondary-button" disabled={busy} onClick={restore}>
            <Icon name="rotate" size={14} />
            {t('admin.branding.revert')}
          </button>
          <button className="gh-secondary-button gh-danger" disabled={busy} onClick={() => void clear()}>
            {t('admin.branding.clear')}
          </button>
          <button className="gh-primary" disabled={busy} onClick={() => void save()}>
            {t('admin.branding.save')}
          </button>
        </>
      }
    >
      <p className="gh-hint">{t('admin.branding.intro')}</p>
      <div className="gh-admin-branding">
        <div>
          <Card title={t('admin.branding.identity')} icon="building">
            <div className="gh-form" style={{ padding: 0 }}>
              <Field label={t('admin.branding.productName')}>
                {(id) => (
                  <input
                    id={id}
                    value={name}
                    maxLength={60}
                    placeholder="Greenhouse"
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('admin.branding.logo')} help={t('admin.branding.logoHint')}>
                {(id) => (
                  <div className="gh-button-row" style={{ alignItems: 'center' }}>
                    <span className="gh-admin-logo">
                      {logo ? <img src={logo} alt={t('admin.branding.logo')} /> : '—'}
                    </span>
                    <label className="gh-secondary-button" htmlFor={id} style={{ cursor: 'pointer' }}>
                      <Icon name="upload" size={14} />
                      {t('admin.branding.upload')}
                    </label>
                    <input
                      id={id}
                      type="file"
                      accept={LOGO_TYPES.join(',')}
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) pickLogo(file);
                        e.target.value = '';
                      }}
                    />
                    {logo ? (
                      <button type="button" className="gh-link-button" onClick={() => setLogo(null)}>
                        {t('admin.branding.removeLogo')}
                      </button>
                    ) : null}
                  </div>
                )}
              </Field>
            </div>
          </Card>
          <Card title={t('admin.branding.styles')} icon="palette" hint={t('admin.branding.stylesHint')}>
            <div className="gh-admin-presets" role="radiogroup" aria-label={t('admin.branding.styles')}>
              {STYLE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={preset === p.id}
                  onClick={() => {
                    const next = presetDraft(p.id);
                    setDraft(next);
                    setHexText(next.brand);
                  }}
                >
                  <span className="gh-admin-swatch" style={{ background: p.brand }} />
                  {t(`admin.branding.preset.${p.id}`)}
                </button>
              ))}
            </div>
          </Card>
          <Card title={t('admin.branding.brandColor')} icon="sparkle" hint={t('admin.branding.brandHint')}>
            <div className="gh-button-row" style={{ alignItems: 'center' }}>
              <input
                type="color"
                className="gh-admin-color"
                aria-label={t('admin.branding.brandColor')}
                value={draft.brand.toLowerCase()}
                onChange={(e) => {
                  const hex = normalizeHex(e.target.value);
                  if (hex) {
                    set({ brand: hex });
                    setHexText(hex);
                  }
                }}
              />
              <input
                className="gh-input gh-mono"
                aria-label={t('admin.branding.brandHex')}
                value={hexText}
                spellCheck={false}
                style={{ width: 120 }}
                onChange={(e) => {
                  setHexText(e.target.value);
                  const hex = normalizeHex(e.target.value);
                  if (hex) set({ brand: hex });
                }}
              />
            </div>
          </Card>
          <Card title={t('admin.branding.typography')} icon="textSize" hint={t('admin.branding.typographyHint')}>
            <div className="gh-form" style={{ padding: 0 }}>
              <div className="gh-admin-presets" role="radiogroup" aria-label={t('admin.branding.fontSans')}>
                {FONT_PRESETS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={draft.fontSans === f.stack}
                    style={f.stack ? { fontFamily: f.stack } : undefined}
                    onClick={() => set({ fontSans: f.stack })}
                  >
                    {t(`admin.branding.font.${f.id}`)}
                  </button>
                ))}
              </div>
              <Field label={t('admin.branding.fontSans')}>
                {(id) => (
                  <input
                    id={id}
                    className="gh-mono"
                    value={draft.fontSans}
                    placeholder="'Brand Sans', system-ui, sans-serif"
                    spellCheck={false}
                    onChange={(e) => set({ fontSans: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('admin.branding.fontMono')}>
                {(id) => (
                  <input
                    id={id}
                    className="gh-mono"
                    value={draft.fontMono}
                    placeholder="'JetBrains Mono', ui-monospace, monospace"
                    spellCheck={false}
                    onChange={(e) => set({ fontMono: e.target.value })}
                  />
                )}
              </Field>
              <Scale
                label={t('admin.branding.textSize')}
                value={draft.fontScale}
                min={0.85}
                max={1.15}
                step={0.025}
                onChange={(v) => set({ fontScale: v })}
              />
              <Scale
                label={t('admin.branding.radius')}
                value={draft.radiusScale}
                min={0}
                max={2}
                step={0.125}
                onChange={(v) => set({ radiusScale: v })}
              />
            </div>
          </Card>
        </div>
        <BrandPreview draft={draft} name={name} logo={logo} mode={mode} setMode={setMode} />
      </div>
    </AdminPage>
  );
}

function Scale({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="gh-admin-scale">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="gh-mono">{Math.round(value * 100)}%</span>
    </label>
  );
}

/** A specimen of the workspace in the chosen style; its colors are the shared light / dark tokens. */
function BrandPreview({
  draft,
  name,
  logo,
  mode,
  setMode,
}: {
  draft: BrandDraft;
  name: string;
  logo: string | null;
  mode: 'light' | 'dark';
  setMode: (mode: 'light' | 'dark') => void;
}) {
  const t = useT();
  const palette = webColors[mode];
  const style = {
    '--pv-brand': draft.brand,
    // dark text on a light brand fill, white on a dark one
    '--pv-on-brand': onBrand(draft.brand) === 'dark' ? webColors.light.text : webColors.light.onAccent,
    '--pv-canvas': palette.canvas,
    '--pv-card': palette.card,
    '--pv-fill': palette.fill,
    '--pv-line': palette.line,
    '--pv-text': palette.text,
    '--pv-secondary': palette.secondary,
    '--pv-scale': String(draft.fontScale),
    '--pv-radius': String(draft.radiusScale),
    fontFamily: draft.fontSans.trim() || undefined,
  } as React.CSSProperties;
  return (
    <section className="gh-admin-preview-wrap" aria-label={t('admin.branding.preview')}>
      <header>
        <strong>{t('admin.branding.preview')}</strong>
        <div className="gh-segmented" role="radiogroup" aria-label={t('admin.branding.preview')}>
          {(['light', 'dark'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
              {t(m === 'light' ? 'admin.branding.light' : 'admin.branding.dark')}
            </button>
          ))}
        </div>
      </header>
      <div className="gh-admin-preview" style={style} data-testid="admin-branding-preview">
        <div className="gh-pv-bar">
          {logo ? <img src={logo} alt="" /> : <span className="gh-pv-mark" />}
          <strong>{name.trim() || 'Greenhouse'}</strong>
          <span className="gh-pv-pill">{t('admin.branding.sampleOnline')}</span>
        </div>
        <div className="gh-pv-body">
          <h3>{t('admin.branding.sampleHeading')}</h3>
          <p>{t('admin.branding.sampleBody')}</p>
          <div className="gh-pv-row">
            <span className="gh-pv-button">{t('admin.branding.samplePrimary')}</span>
            <span className="gh-pv-button gh-pv-ghost">{t('admin.branding.sampleSecondary')}</span>
            <span className="gh-pv-link">{t('admin.branding.sampleLink')}</span>
          </div>
          <div className="gh-pv-input">{t('admin.branding.sampleInput')}</div>
          <div className="gh-pv-chat">
            <div className="gh-pv-mine">{t('admin.branding.sampleAsk')}</div>
            <div className="gh-pv-reply">
              {t('admin.branding.sampleReply')}
              <code style={{ fontFamily: draft.fontMono.trim() || undefined }}>Q3 +18%</code>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
