/**
 * 用户偏好设置弹窗 — 主题、语言、个性化 notes。
 */

import React, { useState, useEffect } from 'react';
import { Dialog, Button, Textarea } from '../ui';
import { authFetch } from '../../lib/auth';
import type { AuthenticatedUser } from '../../lib/auth';
import { Sparkles, Palette, Globe } from '../../lib/icons';
import { ThemeModeSelector } from './theme-mode-selector';
import { useI18n, LOCALE_OPTIONS } from '../../lib/i18n';

const MAX_NOTES_LENGTH = 500;

interface PreferencesDialogProps {
  open: boolean;
  onClose: () => void;
  user: AuthenticatedUser;
  /** Callback to update the cached user object after saving */
  onUserUpdate?: (updated: Partial<AuthenticatedUser>) => void;
}

export function PreferencesDialog({ open, onClose, user, onUserUpdate }: PreferencesDialogProps) {
  const { t, locale, setLocale } = useI18n();
  const [notes, setNotes] = useState(user.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setNotes(user.notes ?? '');
      setSaved(false);
      setError(null);
    }
  }, [open, user.notes]);

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
      onUserUpdate?.({ notes: data.notes });
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
    <Dialog open={open} onClose={onClose} title={t('preferences.title')} size="md">
      <div className="space-y-5">
        {/* Theme Mode — light / dark / system */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-fg-secondary mb-2.5">
            <Palette size={15} className="text-primary-fg" />
            {t('preferences.theme')}
          </label>
          <ThemeModeSelector />
        </div>

        <hr className="border-edge" />

        {/* Language Selector */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-fg-secondary mb-2.5">
            <Globe size={15} className="text-primary-fg" />
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
        </div>

        <hr className="border-edge" />

        {/* Explanation */}
        <div className="flex items-start gap-2.5 p-3 bg-primary-subtle border border-primary-edge rounded-lg">
          <Sparkles size={16} className="text-primary-fg mt-0.5 flex-shrink-0" />
          <p className="text-xs text-primary-fg-strong leading-relaxed">{t('preferences.notesHint')}</p>
        </div>

        {/* Notes textarea */}
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-1.5">{t('preferences.personalNotes')}</label>
          <Textarea
            value={notes}
            onChange={(e) => {
              if (e.target.value.length <= MAX_NOTES_LENGTH) {
                setNotes(e.target.value);
              }
            }}
            placeholder={t('preferences.notesPlaceholder')}
            rows={6}
            className="resize-none"
          />
          <div className="flex items-center justify-between mt-1.5">
            <span className={`text-[10px] ${remaining < 50 ? 'text-warning' : 'text-fg-faint'}`}>
              {t('preferences.charactersRemaining', { count: remaining })}
            </span>
          </div>
        </div>

        {/* Error / Success */}
        {error && (
          <p className="text-xs text-danger bg-danger-subtle border border-danger rounded-lg px-3 py-2">{error}</p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {saved && <span className="text-xs text-primary-fg font-medium mr-2">{t('common.saved')}</span>}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || notes === (user.notes ?? '')}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
