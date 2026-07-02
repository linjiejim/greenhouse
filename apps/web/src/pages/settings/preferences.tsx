/**
 * Preferences panel — personal notes, theme, language.
 * Embedded as a sub-module of the Settings page.
 * Title/description shown in TopBar breadcrumb — not repeated here.
 */

import React, { useState, useEffect } from 'react';
import { Button, Textarea } from '../../components/ui';
import { authFetch } from '../../lib/auth';
import { Sparkles, Palette, Globe } from '../../lib/icons';
import { ThemeModeSelector } from '../../components/app/theme-mode-selector';
import { useI18n, LOCALE_OPTIONS } from '../../lib/i18n';
import { useAuthStore } from '../../stores';

const MAX_NOTES_LENGTH = 500;

export function PreferencesPanel() {
  const { t, locale, setLocale } = useI18n();
  const { currentUser, updateUser } = useAuthStore();
  const [notes, setNotes] = useState(currentUser?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNotes(currentUser?.notes ?? '');
    setSaved(false);
    setError(null);
  }, [currentUser?.notes]);

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
    <div className="space-y-6">
      {/* AI Personal Notes — top priority */}
      <section>
        <div className="flex items-start gap-2.5 p-2.5 bg-primary-subtle border border-primary-edge rounded-lg mb-3">
          <Sparkles size={15} className="text-primary-fg mt-0.5 flex-shrink-0" />
          <p className="text-xs text-primary-fg-strong leading-relaxed">{t('preferences.notesHint')}</p>
        </div>

        <label className="block text-sm font-medium text-fg-secondary mb-1.5">{t('preferences.personalNotes')}</label>
        <Textarea
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
        <div className="flex items-center justify-between mt-1.5">
          <span className={`text-[10px] ${remaining < 50 ? 'text-warning' : 'text-fg-faint'}`}>
            {t('preferences.charactersRemaining', { count: remaining })}
          </span>
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs text-primary-fg font-medium">{t('common.saved')}</span>}
            <Button size="sm" onClick={handleSave} disabled={saving || notes === (currentUser?.notes ?? '')}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
        {error && (
          <p className="text-xs text-danger bg-danger-subtle border border-danger rounded-lg px-3 py-2 mt-2">{error}</p>
        )}
      </section>

      {/* Theme + Language — each on its own full-width row */}
      <div className="space-y-6">
        {/* Theme Mode — light / dark / system */}
        <section>
          <label className="flex items-center gap-2 text-sm font-medium text-fg-secondary mb-2.5">
            <Palette size={14} className="text-primary-fg" />
            {t('preferences.theme')}
          </label>
          <ThemeModeSelector />
        </section>

        {/* Language Selector */}
        <section>
          <label className="flex items-center gap-2 text-sm font-medium text-fg-secondary mb-2.5">
            <Globe size={14} className="text-primary-fg" />
            {t('preferences.language')}
          </label>
          <div className="flex gap-2">
            {LOCALE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setLocale(opt.value)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 transition-all ${
                  locale === opt.value
                    ? 'border-primary-500 bg-primary-subtle/50 text-primary-fg-strong font-medium shadow-sm'
                    : 'border-edge text-fg-secondary hover:border-edge-strong hover:bg-surface-sunken'
                }`}
              >
                <span className="text-sm">{opt.nativeLabel}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
