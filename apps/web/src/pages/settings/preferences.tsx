/**
 * Preferences panel — personal notes, theme, language.
 * Embedded as a sub-module of the Settings page.
 * Title/description shown in TopBar breadcrumb — not repeated here.
 */

import React, { useState, useEffect } from 'react';
import { Button, Textarea } from '../../components/ui';
import { FormActions, FormError } from '../../components/form';
import { SettingsPanel, SettingsSection } from '../../components/settings';
import { ModulePage } from '../../components/app/module-page';
import { authFetch } from '../../lib/auth';
import { Check, Globe, Monitor, Moon, Palette, Sparkles, Sun } from '../../lib/icons';
import { color } from '@greenhouse/ui/tokens';
import { applyTheme, getActiveTheme, getThemeDefinition } from '../../lib/theme';
import type { ThemeKey } from '../../lib/theme';
import { useI18n, LOCALE_OPTIONS } from '../../lib/i18n';
import { useAuthStore } from '../../stores';

const MAX_NOTES_LENGTH = 500;
const THEME_CHOICES: ThemeKey[] = ['system', 'light', 'dark'];

export function PreferencesPanel() {
  const { t, locale, setLocale } = useI18n();
  const { currentUser, updateUser } = useAuthStore();
  const [notes, setNotes] = useState(currentUser?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTheme, setActiveTheme] = useState<ThemeKey>(getActiveTheme());
  const [, setSystemThemeVersion] = useState(0);

  useEffect(() => {
    setNotes(currentUser?.notes ?? '');
    setSaved(false);
    setError(null);
    setActiveTheme(getActiveTheme());
  }, [currentUser?.notes]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const refreshPreview = () => setSystemThemeVersion((version) => version + 1);
    mediaQuery.addEventListener('change', refreshPreview);
    return () => mediaQuery.removeEventListener('change', refreshPreview);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await authFetch('/api/auth/me/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notes.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${t('common.saveFailed')} (${res.status})`);
      }
      const data = await res.json();
      updateUser({ notes: data.notes });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remaining = MAX_NOTES_LENGTH - notes.length;

  return (
    <ModulePage moduleId="settings.preferences" layout="form">
      <SettingsPanel>
        {/* AI Personal Notes — top priority */}
        <SettingsSection
          title={t('preferences.personalNotes')}
          description={t('preferences.notesHint')}
          icon={Sparkles}
        >
          <Textarea
            aria-label={t('preferences.personalNotes')}
            value={notes}
            onChange={(e) => {
              if (e.target.value.length <= MAX_NOTES_LENGTH) {
                setNotes(e.target.value);
              }
            }}
            placeholder={t('preferences.notesPlaceholder')}
            rows={5}
            className="resize-none"
          />
          <FormActions
            leading={
              <span className={`text-caption ${remaining < 50 ? 'text-warning' : 'text-fg-faint'}`}>
                {t('preferences.charactersRemaining', { count: remaining })}
              </span>
            }
          >
            {saved && <span className="text-xs font-medium text-primary-fg">{t('common.saved')}</span>}
            <Button size="sm" onClick={handleSave} disabled={saving || notes === (currentUser?.notes ?? '')}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </FormActions>
          <FormError>{error}</FormError>
        </SettingsSection>

        <SettingsSection title={t('preferences.theme')} description={t('preferences.themeDescription')} icon={Palette}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {THEME_CHOICES.map((themeKey) => {
              const theme = getThemeDefinition(themeKey);
              const isActive = activeTheme === themeKey;
              const Icon = themeKey === 'system' ? Monitor : theme.dark ? Moon : Sun;
              const title = t(
                themeKey === 'system'
                  ? 'preferences.themeSystem'
                  : theme.dark
                    ? 'preferences.themeDark'
                    : 'preferences.themeLight',
              );
              const description = t(
                themeKey === 'system'
                  ? 'preferences.themeSystemDescription'
                  : theme.dark
                    ? 'preferences.themeDarkDescription'
                    : 'preferences.themeLightDescription',
              );
              return (
                <button
                  key={themeKey}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => {
                    applyTheme(themeKey);
                    setActiveTheme(themeKey);
                  }}
                  className={`group relative overflow-hidden rounded-lg border p-3 text-left transition-all ${
                    isActive
                      ? 'border-accent bg-primary-subtle shadow-sm ring-1 ring-accent/15'
                      : 'border-edge bg-surface-raised hover:border-primary-300 hover:bg-surface-sunken'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border"
                      style={{
                        backgroundColor: color.fill[theme.key],
                        borderColor: color.lineStrong[theme.key],
                        color: color.accentText[theme.key],
                      }}
                    >
                      <Icon size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-fg">{title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">{description}</span>
                    </span>
                    <span
                      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border ${
                        isActive ? 'border-accent bg-accent text-on-accent' : 'border-edge-strong text-transparent'
                      }`}
                    >
                      <Check size={12} strokeWidth={3} />
                    </span>
                  </div>
                  <span
                    className="mt-3 flex h-8 overflow-hidden rounded-md border"
                    style={{ borderColor: color.line[theme.key] }}
                  >
                    <span className="w-1/4" style={{ backgroundColor: color.chrome[theme.key] }} />
                    <span className="flex-1" style={{ backgroundColor: color.canvas[theme.key] }} />
                    <span className="w-1/5" style={{ backgroundColor: color.accent[theme.key] }} />
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsSection>

        <SettingsSection title={t('preferences.language')} icon={Globe}>
          <div className="flex gap-2">
            {LOCALE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setLocale(opt.value)}
                className={`flex items-center gap-2 px-4 py-2 rounded-md border-2 transition-all ${
                  locale === opt.value
                    ? 'border-accent bg-primary-subtle/50 text-primary-fg-strong font-medium shadow-sm'
                    : 'border-edge text-fg-secondary hover:border-edge-strong hover:bg-surface-sunken'
                }`}
              >
                <span className="text-sm">{opt.nativeLabel}</span>
              </button>
            ))}
          </div>
        </SettingsSection>
      </SettingsPanel>
    </ModulePage>
  );
}
